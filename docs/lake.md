# The lake store (beta)

By default Glass keeps events in D1, which is exact, real-time and free-plan friendly. D1 databases have a size limit, though, so for high volumes Glass can stream events into Apache Iceberg tables in R2 and query them with Basin SQL (Cloudflare's DataFusion engine, formerly R2 SQL):

```sh
npx @glassanalytics/cli init --lake
```

Status: **beta**. Pipelines and Basin SQL are themselves in beta, and the Basin SQL response format is not documented yet, so Glass parses it tolerantly (`normaliseRows()` in `packages/worker/src/stores/lake.ts`). Please report anything odd.

## What it creates

- An R2 bucket `glass-data` with the data catalog enabled
- Two Pipelines streams, `glass_events` and `glass_identities`, with fixed schemas (`packages/core/src/lake.ts`)
- Two sinks writing Iceberg tables `glass.events` and `glass.identities` (Parquet, files rolled every 60 seconds)
- Two pipelines connecting them (`INSERT INTO <sink> SELECT * FROM <stream>`)
- Worker bindings `EVENTS_STREAM` and `IDENTITIES_STREAM`, and the API token as the `CF_API_TOKEN` secret so the Worker can query Basin SQL

D1 still holds projects, people, identity links, flags, experiments and the replay index.

## Differences from D1 mode

|                            | D1                                     | Lake                                                                   |
| -------------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| Freshness                  | Immediate                              | About 1–2 minutes (file roll interval)                                 |
| History                    | Until D1's size limit                  | Unbounded                                                              |
| Cost                       | Included in Workers plans up to limits | R2 storage, Pipelines and Basin SQL scans                              |
| Person properties          | At event time, or current via SQL join | At event time                                                          |
| Deleting a person's events | Yes                                    | Not yet (roadmap)                                                      |
| Other engines              |                                        | Any Iceberg reader (DuckDB, Spark, Snowflake) can read the same tables |

## Using a narrower token

The Worker only needs to _read_ in lake mode. After `init`, you can replace its token with one that has just _Workers R2 SQL › Read_ and _Workers R2 Data Catalog › Read_:

```sh
npx wrangler secret put CF_API_TOKEN --config .glass/wrangler.jsonc
```

## Schema changes

Pipelines streams can't be altered after creation, so the stream schemas are versioned (`LAKE_VERSION` in `packages/core/src/lake.ts`). Custom properties never need a schema change: they live in the `props` JSON column. A new built-in column would need new streams (`glass_events_v2`) and queries over both tables; that migration path isn't built yet and is tracked in the roadmap.
