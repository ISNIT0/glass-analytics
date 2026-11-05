"""A stand-in for Basin SQL in tests: DataFusion, the engine Basin SQL runs, over in-memory tables.

The lake conformance test (lake-conformance.test.ts) starts this once and talks JSON lines on
stdin/stdout:

  {"op": "schema", "table": "events", "fields": [{"name": "ts_ms", "type": "int64"}, ...]}
  {"op": "write", "table": "events", "rows": [{...}, ...]}     -> {"ok": true}
  {"op": "query", "sql": "SELECT ..."}                         -> Basin SQL's response body

Basin SQL adds JSON functions from datafusion-functions-json (json_as_text, json_get_float,
json_get_bool, json_contains); plain DataFusion lacks them, so they are defined here for one
key, which is all the query compilers use.
"""

import json
import sys
from datetime import datetime

import pyarrow as pa
from datafusion import SessionContext, udf

TYPES = {"string": pa.string(), "int64": pa.int64(), "float64": pa.float64(), "bool": pa.bool_()}


def arrow_type(name):
    return pa.timestamp("us", tz="UTC") if name == "timestamp" else TYPES[name]


def lookup(doc, key):
    if doc is None:
        return None
    try:
        value = json.loads(doc)
    except ValueError:
        return None
    return value.get(key) if isinstance(value, dict) else None


def as_text(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    return json.dumps(value, separators=(",", ":"))


def as_float(value):
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def as_bool(value):
    return value if isinstance(value, bool) else None


def json_udf(name, convert, out_type, exists=False):
    def fn(docs, keys):
        docs, keys = docs.to_pylist(), keys.to_pylist()
        out = []
        for doc, key in zip(docs, keys):
            if exists:
                try:
                    parsed = json.loads(doc) if doc is not None else None
                except ValueError:
                    parsed = None
                out.append(isinstance(parsed, dict) and key in parsed)
            else:
                out.append(convert(lookup(doc, key)))
        return pa.array(out, out_type)

    return udf(fn, [pa.string(), pa.string()], out_type, "immutable", name=name)


ctx = SessionContext()
for f in (
    json_udf("json_as_text", as_text, pa.string()),
    json_udf("json_get_float", as_float, pa.float64()),
    json_udf("json_get_bool", as_bool, pa.bool_()),
    json_udf("json_contains", None, pa.bool_(), exists=True),
):
    ctx.register_udf(f)
ctx.sql("CREATE SCHEMA IF NOT EXISTS glass").collect()

schemas, rows = {}, {}


def register(table):
    schema = schemas[table]
    data = rows.get(table, [])
    columns = {}
    for field in schema:
        values = [r.get(field.name) for r in data]
        if pa.types.is_timestamp(field.type):
            values = [datetime.fromisoformat(v.replace("Z", "+00:00")) if v else None for v in values]
        columns[field.name] = pa.array(values, field.type)
    name = f"glass.{table}"
    ctx.deregister_table(name)
    ctx.register_record_batches(name, [[pa.RecordBatch.from_pydict(columns, schema=schema)]])


def plain(value):
    if isinstance(value, float) and value.is_integer():
        return value
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


def main():
    for line in sys.stdin:
        msg = json.loads(line)
        try:
            if msg["op"] == "schema":
                schemas[msg["table"]] = pa.schema([pa.field(f["name"], arrow_type(f["type"])) for f in msg["fields"]])
                register(msg["table"])
                reply = {"ok": True}
            elif msg["op"] == "write":
                rows.setdefault(msg["table"], []).extend(msg["rows"])
                register(msg["table"])
                reply = {"ok": True}
            else:
                table = ctx.sql(msg["sql"]).to_arrow_table()
                reply = {
                    "result": {
                        "schema": [{"name": n} for n in table.column_names],
                        "rows": [{k: plain(v) for k, v in r.items()} for r in table.to_pylist()],
                    },
                    "success": True,
                    "errors": [],
                }
        except Exception as err:  # reported to the test as a Basin SQL error
            reply = {"success": False, "errors": [{"message": f"{type(err).__name__}: {err}"}]}
        print(json.dumps(reply, default=str), flush=True)


if __name__ == "__main__":
    main()
