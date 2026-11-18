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
- **Experiments (core only)**: metric kinds conversion/mean/ratio/funnel/retention,
  Bayesian + frequentist, probability to be best, winsorising, minimum runtime/exposures,
  timeline, secondary metrics computed. Old `goal` form still works.

## Not done yet
- Experiments, service side: store `metrics`/engine options, lifecycle (pause/resume/reset/
  archive/duplicate), holdouts (flags return `"holdout"`; SDK `isEnabled` must treat it as off),
  running-time calculator tool, web-experiment transforms in the SDK, stats tests against the
  scipy values in the session scratchpad.
- Phase 7 destinations/transformations/batch exports/import CLI (Queues), Phase 8 error
  tracking + source maps, Phase 9 revenue + Stripe, Phase 10 dashboard UI for everything
  above, docs, comparison pages, e2e tests, upgrade dry-run.

## Decisions to confirm
- Groups live in `props.$groups` / `props.$group_props` rather than new columns, so no lake
  schema version is needed.
- Static cohorts in lake mode are inlined (up to 10,000 people) instead of a new Pipelines stream.
- Server and encryption keys are derived from existing secrets (CI upgrades can't add secrets).
- Cohorts may now reference other cohorts (loop-checked), reversing the 2026-11-04 decision.
- Script-tag SDK grew (now ~5.2 KB gzip); check against the "about 4 KB" claim.
