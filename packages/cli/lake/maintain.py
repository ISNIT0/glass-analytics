"""Lake maintenance: the deletes Basin SQL can't do.

Basin SQL is read-only, so Dataflare deletes lake rows with PyIceberg through the
catalog (Basin Catalog in production, a local SQL catalog in tests). `dataflare
lake maintain` runs this script and passes a JSON job on stdin:

  {
    "catalog": {"type": "rest", "uri": "...", "warehouse": "...", "token": "..."},
    "namespace": "glass",
    "tables": {"events": ["events", "events_v2"], "identities": ["identities"]},
    "deletions": [{"id": 1, "project": "acme", "ids": ["alice", "device-1"]}],
    "retention_cutoff_ms": 1790000000000   # or null: keep events forever
  }

It erases each queued person (events by person, device or user id, and their
identity links), deletes events older than the retention cutoff, and prints a
JSON result on stdout. Deletes are copy-on-write commits: the rows disappear from
queries at once, and the old files go when Basin Catalog's snapshot expiration
(enabled by `dataflare init --lake`) drops the snapshots that still hold them.
"""

import json
import sys
import time
from collections import defaultdict

from pyiceberg.catalog import load_catalog
from pyiceberg.exceptions import CommitFailedException, NoSuchTableError
from pyiceberg.expressions import And, EqualTo, In, LessThan

ATTEMPTS = 6


def log(message):
    print(message, file=sys.stderr, flush=True)


def delete(catalog, name, row_filter, label):
    """Delete matching rows, retrying when Pipelines commits to the table at the same time."""
    for attempt in range(1, ATTEMPTS + 1):
        try:
            table = catalog.load_table(name)
        except NoSuchTableError:
            log(f"{name}: no table yet, nothing to delete")
            return False
        try:
            table.delete(delete_filter=row_filter)
            log(f"{name}: deleted {label}")
            return True
        except CommitFailedException as err:
            if attempt == ATTEMPTS:
                raise
            wait = 2**attempt
            log(f"{name}: commit conflict ({err}); retrying in {wait}s")
            time.sleep(wait)
    return False


def main():
    job = json.load(sys.stdin)
    catalog = load_catalog("dataflare", **job["catalog"])
    ns = job.get("namespace") or "glass"
    # Every schema version's table (events, events_v2, ...): rows live in all of them.
    tables = job.get("tables") or {}
    events = [f"{ns}.{t}" for t in tables.get("events") or ["events"]]
    identities = [f"{ns}.{t}" for t in tables.get("identities") or ["identities"]]

    # Queued ids are merged per project, so a long queue still costs a few commits.
    by_project = defaultdict(set)
    for d in job.get("deletions") or []:
        by_project[d["project"]].update(d["ids"])
    for project, ids in sorted(by_project.items()):
        ids = sorted(ids)
        # One delete per column, never an OR across columns: PyIceberg's copy-on-write delete keeps
        # rows where the filter is NULL, and user_id is NULL on anonymous events, so
        # `distinct_id IN ids OR user_id IN ids` would leave a matching device's anonymous rows.
        for name in events:
            for column in ("distinct_id", "person_id", "user_id"):
                delete(
                    catalog,
                    name,
                    And(EqualTo("project", project), In(column, ids)),
                    f"events of {len(ids)} ids in {project} by {column}",
                )
        for name in identities:
            for column in ("distinct_id", "person_id"):
                delete(
                    catalog,
                    name,
                    And(EqualTo("project", project), In(column, ids)),
                    f"identity links of {len(ids)} ids in {project} by {column}",
                )

    cutoff = job.get("retention_cutoff_ms")
    if cutoff:
        for name in events:
            delete(catalog, name, LessThan("ts_ms", int(cutoff)), f"events before {cutoff}")

    json.dump(
        {
            "deletions": [d["id"] for d in job.get("deletions") or []],
            "retention_cutoff_ms": cutoff,
        },
        sys.stdout,
    )
    print()


if __name__ == "__main__":
    main()
