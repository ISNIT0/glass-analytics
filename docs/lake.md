# The lake store (beta)

By default Dataflare keeps events in D1, which is exact, real-time and free-plan friendly. D1 databases have a size limit, though, so for high volumes Dataflare can stream events into Apache Iceberg tables in R2 and query them with Basin SQL (Cloudflare's DataFusion engine, formerly R2 SQL):

```sh
npx dataflare-cli init --lake
```

Status: **beta**. Every query kind (web, trends, funnels, retention, SQL, the event list) has been run against production Basin SQL, and the response format is recorded in the tests. Still missing before it leaves beta: deleting a person's events, retention, schema migrations and testing at high volume (see the [roadmap](../ROADMAP.md)). Please report anything odd.

Lake mode can't be combined with `--eu`: Basin Catalog doesn't support R2 buckets in a jurisdiction yet, so `init` refuses the combination. Use the D1 store if your data must stay in the EU jurisdiction.

## What it creates

- An R2 bucket `<name>-data` with the data catalog enabled
- Two Pipelines streams, `<name>_events` and `<name>_identities` (the Worker name with `-` as `_`), with fixed schemas (`packages/core/src/lake.ts`). Stream, sink and pipeline names are unique per account, so each deployment gets its own.
- Two sinks writing Iceberg tables `glass.events` and `glass.identities` (Parquet, files rolled every 60 seconds)
- Two pipelines connecting them (`INSERT INTO <sink> SELECT * FROM <stream>`)
- Worker bindings `EVENTS_STREAM` and `IDENTITIES_STREAM`, and the API token as the `CF_API_TOKEN` secret so the Worker can query Basin SQL

D1 still holds projects, people, identity links, flags, experiments and the replay index.

## Differences from D1 mode

|                            | D1                                     | Lake                                                                   |
| -------------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| Freshness                  | Immediate                              | About 1–2 minutes (file roll interval)                                 |
| Query time                 | Milliseconds                           | About 1–5 seconds per query                                            |
| EU jurisdiction (`--eu`)   | Yes                                    | Not yet (Basin Catalog limitation)                                     |
| History                    | Until D1's size limit                  | Unbounded                                                              |
| Cost                       | Included in Workers plans up to limits | R2 storage, Pipelines and Basin SQL scans                              |
| Person properties          | At event time, or current via SQL join | At event time                                                          |
| Deleting a person's events | Yes                                    | Not yet (roadmap)                                                      |
| Other engines              |                                        | Any Iceberg reader (DuckDB, Spark, Snowflake) can read the same tables |

## Using a narrower token

The Worker only needs to _read_ in lake mode. After `init`, you can replace its token with one that has just _Workers R2 SQL › Read_, _Workers R2 Data Catalog › Read_ and _Workers R2 Storage Bucket Item › Read_ (Cloudflare's docs list R2 storage access as well; keep it read-only, since vended credentials inherit it):

```sh
npx wrangler secret put CF_API_TOKEN --config .glass/wrangler.jsonc
```

## Schema changes

Pipelines streams can't be altered after creation, so the stream schemas are versioned (`LAKE_VERSION` in `packages/core/src/lake.ts`). Custom properties never need a schema change: they live in the `props` JSON column. A new built-in column would need new streams (`<name>_events_v2`) and queries over both tables; that migration path isn't built yet and is tracked in the roadmap.
