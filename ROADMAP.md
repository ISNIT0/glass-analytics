# Roadmap

What Glass does today, and what's next. Items marked *good first issue* are self-contained and a good way to start contributing.

## Shipped in 0.1

- `glass init` / `upgrade` / `status`, with agent files (AGENTS.md, skill, `.mcp.json`)
- Browser SDK: autocapture (pageviews incl. SPA navigation, clicks, errors, web vitals), custom events, identify, person properties, cookieless mode, consent
- Web analytics, trends, funnels, retention, raw SQL; filters and breakdowns on any event or person property
- Session replay with sampling, error-triggered buffering and text transcripts
- Feature flags with targeting; experiments with Bayesian readout and SRM checks
- MCP server (23 tools), CLI, HTTP API, `llms.txt`
- D1 event store (default) and the lake store (beta)

## Next

- **Verify the lake store against production Cloudflare.** Basin SQL's response format isn't documented yet; `normaliseRows()` is deliberately tolerant. Needs real-account testing and a recorded fixture.
- **Paths, stickiness and lifecycle insights.** Each is one file in `packages/core/src/insights/`. *good first issue*
- **Cohorts:** saved person filters reusable across queries.
- **Alerts:** threshold and anomaly alerts on any insight, via email or webhook, run from the Worker's cron.
- **Current person properties in lake mode:** mirror D1 `persons` to an Iceberg table (today, lake queries use the per-event snapshot).
- **Lake-mode erasure:** an Iceberg delete job for GDPR requests (D1 mode deletes events today).
- **Goals in the web view:** mark an event or URL as a goal and show conversion in every breakdown. *good first issue*
- **Timezone support** beyond fixed UTC offsets (DST-aware bucketing).
- **Cloudflare Access** support for the dashboard, as an alternative to API keys.
- **Lake schema migrations:** versioned streams (`glass_events_v2`) and queries across old and new tables, for when built-in columns change.
- **Materialised property columns** for frequently filtered lake properties (needs versioned streams).
- **Analytics Engine accelerator** for real-time tiles at high volume.
- **`glass cost`:** estimate monthly Cloudflare spend from current volume. *good first issue*
- **Opt-in install telemetry** for the landing page's conversion funnel (off by default).
- **More framework snippets and detection:** Qwik, SolidStart, Eleventy, Hugo. *good first issue*
