# Architecture

Glass is one Worker, one D1 database and one R2 bucket in the user's Cloudflare account, plus a CLI that deploys them. The optional lake store adds Cloudflare Pipelines and Iceberg tables.

```
                    ┌──────────────────────── your Cloudflare account ─────────────────────────┐
 browser SDK ──────▶│  POST /e  ingest pipeline ──▶ EventStore ──▶ D1 events                   │
 (s.js, replay.js)  │  POST /r  replay chunks ─────────────────▶ R2  replays/<project>/<session>│
                    │  POST /f  flag evaluation ◀── D1 flags, persons, identities              │
                    │                                                                          │
 coding agents ────▶│  POST /mcp  MCP server ─┐                                                │
 glass CLI ────────▶│  /api/*     JSON API ───┼──▶ GlassService ──▶ insight compilers ──▶ SQL   │
 you ──────────────▶│  /app       dashboard ──┘                                                │
                    │                                                                          │
                    │  lake mode: EventStore ──▶ Pipelines stream ──▶ Iceberg on R2 ──▶ Basin SQL│
                    └──────────────────────────────────────────────────────────────────────────┘
```

## Request paths

- **Ingest** (`packages/worker/src/ingest.ts`): parse a batch, check the project and origin, drop bots and malformed events, apply `identify()` links and person updates, resolve each event's person and snapshot their properties, enrich (clock skew, URL and UTM parsing, referrer, geo, user agent), and write. The body is `text/plain` JSON so browsers skip CORS preflights; the SDK uses `sendBeacon` when pages are hidden.
- **Queries** (`packages/worker/src/service.ts` → `packages/core/src/insights/`): a spec is validated with zod, compiled to SQL for the store's dialect, executed, and shaped into a result with a `summary`, the `sql` that ran and a dashboard link. The HTTP API, MCP tools and dashboard all go through `GlassService`.
- **Replay**: each upload is one gzipped JSON array of rrweb events, stored as its own R2 object keyed by start time, page load and sequence. A D1 row indexes the session, so listing replays never touches R2. Two constraints shape this:
  - _A page that is going away can send about 64 KB_ (`sendBeacon` and `keepalive` share that limit), and most pages' DOM snapshots are bigger. So `replay.js` uploads each page's snapshot the moment it's taken and never lets more than a beacon's worth of events wait, which leaves only a small remainder for the beacon when the page is hidden.
  - _rrweb numbers DOM nodes per page load_, so node 42 means something different on each page. Anything that resolves node ids, such as the transcript in `packages/core/src/replay-summary.ts`, reads each page load separately (`loadReplayPages()` groups chunks by their page id).
  - _Most of a single-page app arrives as mutations_, not in the first snapshot, and rrweb sends each added node separately. `packages/core/src/replay-dom.ts` rebuilds the DOM from snapshots plus every mutation (adds, removes, text and attribute changes), which is what names clicked elements and renders `replay_snapshot`.
  - _Reading every chunk is expensive_, so an hourly cron summarises sessions about 30 minutes after they end: the timeline is cached at `summaries/<project>/<session>.json`, and its frustration counts and a searchable digest (pages, clicked elements, errors) go on the D1 row. Search and `analyse_replays` read those; a new chunk makes the cache stale.

## Identity

Every event carries `distinct_id` (the device, stable across login), `user_id` (once identified) and `person_id` (resolved at ingest). `identify()` writes a link from device to user in `identities`; the first link wins, so a shared device never moves old events to a new user.

Queries resolve people at query time:

```sql
CASE WHEN user_id <> '' THEN user_id ELSE COALESCE(identities.person_id, person_id) END AS pid
```

So events from before signup count towards the user in funnels and retention, in both stores, without rewriting old rows.

## Portable SQL

The compilers (`packages/core/src/insights/*.ts`) target two engines: SQLite (D1) and Basin SQL (DataFusion over Iceberg). To keep one implementation:

- Time is integer milliseconds (`ts_ms`), so hour, day and week buckets are integer arithmetic.
- Funnels and retention use chained CTEs and joins, not window functions (budget-gated in Basin SQL).
- Everything engine-specific (JSON access, month arithmetic, case-insensitive search) is one of the `Dialect` methods in `packages/core/src/sql/dialect.ts`.
- Values are inlined through escaping helpers and property keys are validated, because Basin SQL's HTTP API has no parameter binding.

The core tests execute every compiler on real SQLite against the production migration, which covers the lake's logic too.

## Packages

| Package                     | Published                    |                                                            |
| --------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `@glassanalytics/core`      | no (bundled)                 | Event model, SQL, stats, flags, replay summaries, snippets |
| `@glassanalytics/web`       | npm                          | Browser SDK                                                |
| `@glassanalytics/worker`    | no (bundled into the CLI)    | The Worker                                                 |
| `@glassanalytics/dashboard` | no (bundled into the Worker) | The dashboard                                              |
| `@glassanalytics/cli`       | npm                          | CLI, carrying the built Worker and migrations              |

Versioning the CLI and the Worker together means `npx @glassanalytics/cli@x upgrade` always deploys exactly the Worker that CLI was tested with.

## Why not…

- **Analytics Engine** for the web view: it samples and keeps three months of data. D1 is exact and real-time at the volumes most Glass users have, and the lake covers large volumes. An Analytics Engine accelerator for real-time tiles at scale is on the roadmap.
- **A Durable Object per session** for replay: R2 objects per chunk plus a D1 index do the job with fewer moving parts.
- **A web framework** in the Worker: the routing Glass needs is ~60 lines (`http.ts`), and fewer dependencies are easier to audit.
