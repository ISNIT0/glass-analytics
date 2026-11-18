# deepen-coverage: review notes (delete before merging)

Branch `deepen-coverage`, off `origin/main` (0.8.4). Nothing pushed, released or deployed.
Run: `pnpm install && pnpm typecheck && pnpm lint && pnpm test` (lake conformance needs `uv`).

## Done (one commit each)

- **Foundations**: `/api/import` (keeps old timestamps; public `/e` still clamps to 7 days),
  per-key props truncation, server key (derived from the admin key; `dataflare key --server`),
  project settings (migration 0008), DST-aware IANA time zones, `filterTestAccounts`,
  5-minute cron + task registry, group storage (`$groups`, `$groupidentify`, migration 0009),
  `aggregateBy` (person / session / group), safe formula parser.
- **Trends**: dau/wau/mau, first_time, unique_groups, min/max/median/p75–p99 (1% sketch),
  per-actor count stats, multi-event series, formulas, cumulative/smoothing/trend line,
  compare, numeric bins, cohort breakdowns, minute interval, display options; `list_actors`
  drill-down (+CSV), annotations (migration 0010).
- **Funnels**: best attempt per actor, ordered/strict/unordered, exclusions, optional steps,
  breakdown attribution, median times, time-to-convert and trends views, drill-down,
  `funnel_correlation`.
- **Retention**: recurring, cumulative, breakdowns, hourly, any event, simple mean, drill-down.
- **Cohorts**: behavioural condition groups, nested cohorts, static cohorts, members/CSV,
  freeze, save selection as cohort, flag targeting via materialised membership (migration 0011).
- **Flags + dataflare-node**: payloads, `flag.<key>` dependencies, bucketBy person/group,
  early access, bootstrap/overrides, debug reasons, history + schedules (migration 0012),
  usage, local-evaluation definitions; Node SDK with local evaluation checked against `/f`.
- **Experiments**: metric kinds conversion/mean/ratio/funnel/retention, Bayesian +
  frequentist, probability to be best, winsorising, minimum runtime/exposures, timeline,
  secondary metrics computed (old `goal` form still works); lifecycle pause/resume/reset/
  archive/duplicate, holdouts (migration 0013; flags return `"holdout"`, which the SDKs treat
  as off), `plan_experiment` running-time calculator, web-experiment transforms applied by the
  SDK. Stats checked against SciPy reference values.
- **Destinations, transformations, exports, import**: 16 destination templates (webhook, Slack,
  Discord, Teams, Meta CAPI, GA4, TikTok, Customer.io, Loops, HubSpot, Mixpanel, Amplitude,
  PostHog, Zapier, Make, n8n) delivered through Cloudflare Queues with a D1 outbox fallback,
  backoff, failure logs, retry and test sends; AES-GCM encrypted secrets; ingest
  transformations (drop event, drop/rename/set/hash properties, redact); hourly/daily batch
  exports to S3/R2 (SigV4), BigQuery and HTTP NDJSON with backfill (migration 0014);
  `dataflare import` with PostHog/Mixpanel/Amplitude/Segment/GA4 presets; `init`/`upgrade`
  create the queue and its dead-letter queue and fall back to the outbox when the token can't;
  queue operations in `usage_and_cost`. Exports are checked against DataFusion in the lake
  conformance suite.

- **Error tracking**: `captureException` and `release` in both SDKs (`data-release` on the
  script tag); Chrome/V8, Firefox and Safari stack parsing; fingerprints from type, message
  with variable parts removed, and top three in-app frames (bundle hashes and minified names
  ignored, `$fingerprint` overrides); issues in D1 with `$issue_id` on every exception (so the
  lake groups by issue too); resolve/suppress/assign/merge, regressions, a per-issue minute
  limit; alerts for new issues, regressions and spikes through a destination; source map
  upload (`dataflare sourcemaps upload`, `PUT /api/sourcemaps`, server key allowed) with an
  in-house VLQ decoder checked against esbuild, symbolication at read time with code context;
  `list_issues`, `get_issue`, `update_issue`, `merge_issues`, `list_sourcemaps`;
  `site_health` lists top issues (migration 0015). Issue reads are checked against DataFusion.

## Not done yet

- Phase 9 revenue + Stripe, Phase 10 dashboard UI for everything above (including an Errors
  page), docs, comparison pages, e2e tests (SDK `captureException`, web experiments, early
  access, overrides), upgrade dry-run.

## Decisions to confirm

- Groups live in `props.$groups` / `props.$group_props` rather than new columns, so no lake
  schema version is needed.
- Static cohorts in lake mode are inlined (up to 10,000 people) instead of a new Pipelines stream.
- Server and encryption keys are derived from existing secrets (CI upgrades can't add secrets).
- Cohorts may now reference other cohorts (loop-checked), reversing the 2026-11-04 decision.
- Script-tag SDK grew (now ~5.8 KB gzip); check against the "about 4 KB" claim.
- Destination work per invocation is capped for the Free plan's 50 subrequests: queue batches
  of 25, 20 outbox deliveries per 5-minute tick, 10 export requests per tick (2,000 rows a page).
- A failing after-write hook (e.g. the queue is over quota) logs and moves on: the events are
  already stored, so `/e` still succeeds and the delivery goes to the outbox.
- Phone numbers for ad platforms drop a "(0)" and "00" prefix; Meta gets digits, TikTok E.164
  with "+"; an optional `phoneCountryCode` input fixes national numbers.
- Error fingerprints are computed at ingest from unsymbolicated frames (symbolicating at ingest
  would not fit the Free plan's 10 ms CPU), so frames are keyed on file (hash stripped) and
  function name (minified names ignored). Two builds can still split an issue when the
  top frames' real names change; merging covers that.
- The per-issue rate limit is counted per Worker isolate (free, approximate), not globally.
- An exception that happened before its issue was resolved (a late batch) doesn't reopen it.
- BigQuery uses streaming inserts (`insertAll`), not load jobs: simpler, and rows dedupe on the
  event id for about a minute; a load-job path would need a GCS bucket.
