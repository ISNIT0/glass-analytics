---
"dataflare-cli": minor
"dataflare-web": minor
---

Lake mode can erase people and apply retention. `dataflare person <id> --delete` queues the person's events, and the new `dataflare lake maintain` deletes them (and events past `--retention-days`) with PyIceberg through Basin Catalog; lake deployments' workflow runs it daily. `init --lake` turns on snapshot expiration and compaction so deleted rows leave R2 within a week. Every read API is now checked against DataFusion in CI, and ranked lists (top pages, referrers, events) break ties by name, so D1 and the lake order them the same.
