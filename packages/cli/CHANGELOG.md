# dataflare-cli

## 0.7.0

### Minor Changes

- 1e69d38: Lake mode can erase people and apply retention. `dataflare person <id> --delete` queues the person's events, and the new `dataflare lake maintain` deletes them (and events past `--retention-days`) with PyIceberg through Basin Catalog; lake deployments' workflow runs it daily. `init --lake` turns on snapshot expiration and compaction so deleted rows leave R2 within a week. Every read API is now checked against DataFusion in CI, and ranked lists (top pages, referrers, events) break ties by name, so D1 and the lake order them the same.

## 0.6.3

### Patch Changes

- fdea56f: Lake mode works against production Cloudflare. Queries no longer fail with "Illegal invocation" in the Worker; `init --lake` lists Pipelines resources through the API (Wrangler's list output isn't JSON) and names streams, sinks and pipelines after the deployment, so a second lake deployment in one account gets its own instead of silently reusing the first's; and `--lake --eu` is refused up front, since Basin Catalog doesn't support jurisdiction buckets yet.

## 0.6.2

### Patch Changes

- c901828: Fix `npx dataflare-cli` doing nothing: the CLI only started when its bin was named `glass`, and npm links it as `dataflare`. It now compares real paths, so it runs under any bin name.

## 0.6.1

### Patch Changes

- cf728a9: The CLI is published as `dataflare-cli` (npm rejected `dataflare` as too close to an existing package): `npx dataflare-cli init`, `npx dataflare-cli@latest upgrade`. Installed globally, the command is still `dataflare`. Deploy workflows and `.mcp.json` written by the CLI use `dataflare-cli`, and `/health` checks `dataflare-cli` on npm for new versions.

## 0.6.0

### Minor Changes

- 8393cf8: Glass is now Dataflare, at https://dataflare.dev. The CLI is published as `dataflare` (`npx dataflare init`, `npx dataflare@latest upgrade`) and the browser SDK as `dataflare-web`; the `@glassanalytics/cli` and `@glassanalytics/web` packages get no new versions. Nothing changes in your snippet or deployment: `window.glass`, the `data-glass-*` attributes, the `/_glass` route, `.glass/` and the `GLASS_*` settings all stay, and the SDK still exports `Glass` as an alias of the renamed `Dataflare` class. `dataflare upgrade` rewrites a deploy workflow generated before the rename so CI installs `dataflare` instead of `@glassanalytics/cli`.

## 0.5.0

### Minor Changes

- 19736d1: Session replay can record cookieless visitors. Add `data-replay-cookieless="true"` (or `replay: { cookieless: true }`) and visitors who haven't consented are recorded too, still with nothing stored on the device: the Worker files each page load's recording under the same daily-rotating visitor and session ids as its events, so the replay joins the visit. `glass.consent(false)` now stops replay for the rest of the page even if the recorder was still loading, and `consent(true)` restarts a cookieless recording under the stored session.

## 0.4.0

### Minor Changes

- 88f0a3a: Reports you can explore, key events and a cost page. Mark events as conversions or important (Events page, or the new `mark_event` MCP tool) and Reports show their rates, overall and per source. Marketing adds channels (search, social, paid, email, AI assistants, referral, direct) and a source table with conversion and bounce. Health adds errors over time, sessions affected, likely 404 pages, the slowest pages and replay frustration. Clicking any source, campaign, page, country or device opens a full report for that segment; source and page segments keep whole visits (new `session.<property>` filters). New Usage & cost page (and `usage_and_cost` tool) projects what Glass adds to the Cloudflare bill and recommends ways to cut it. Copyable agent prompts on Reports and in Insights' "New analysis" menu. New MCP tools `query_sources` and `site_health`. Run `glass upgrade` to apply migration 0005.

  Onboarding fixes from rolling Glass out to ten sites: deployments are named `glass-<project>` by default (a shared `glass` name made a second site take over the first site's Worker); `--route acme.com` is enough (no shell-sensitive `*`), and `--no-route` removes one; `--retention-days` on init and upgrade; init retries while new Worker secrets propagate instead of failing with "GLASS_ADMIN_KEY is not set"; wrangler failures show the actual error; a CLAUDE.md that imports AGENTS.md no longer gets a duplicate Glass section; init and the agent instructions explain cookie banners (cookieless until `glass.consent(true)`), mirroring an existing analytics helper, and loading from the Worker URL on Vercel or Netlify.

## 0.3.0

### Minor Changes

- 1449c31: Session replay becomes a debugging tool. Recordings now include console warnings and errors, network requests (method, URL without query string, status, timing) and client-side navigation; `data-glass-mask` masks an element's text. Transcripts label clicks on content rendered after load, add CSS selectors, dead clicks, clicks followed by errors, stack frames, failed requests and console errors. New MCP tools `replay_snapshot`, `analyse_replays`, `annotate_replay` and `delete_replay_note`; `list_replays` can filter by signals, visited URL, events that did or did not happen, cohorts and text. The dashboard gets a full player (timeline markers, speed, skip inactivity, fullscreen, deep links, notes) and a Patterns page. Run `glass upgrade` to apply migration 0004 and switch the maintenance cron to hourly.
