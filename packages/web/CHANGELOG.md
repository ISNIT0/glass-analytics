# @glassanalytics/web

## 0.4.0

### Minor Changes

- 88f0a3a: Reports you can explore, key events and a cost page. Mark events as conversions or important (Events page, or the new `mark_event` MCP tool) and Reports show their rates, overall and per source. Marketing adds channels (search, social, paid, email, AI assistants, referral, direct) and a source table with conversion and bounce. Health adds errors over time, sessions affected, likely 404 pages, the slowest pages and replay frustration. Clicking any source, campaign, page, country or device opens a full report for that segment; source and page segments keep whole visits (new `session.<property>` filters). New Usage & cost page (and `usage_and_cost` tool) projects what Glass adds to the Cloudflare bill and recommends ways to cut it. Copyable agent prompts on Reports and in Insights' "New analysis" menu. New MCP tools `query_sources` and `site_health`. Run `glass upgrade` to apply migration 0005.

  Onboarding fixes from rolling Glass out to ten sites: deployments are named `glass-<project>` by default (a shared `glass` name made a second site take over the first site's Worker); `--route acme.com` is enough (no shell-sensitive `*`), and `--no-route` removes one; `--retention-days` on init and upgrade; init retries while new Worker secrets propagate instead of failing with "GLASS_ADMIN_KEY is not set"; wrangler failures show the actual error; a CLAUDE.md that imports AGENTS.md no longer gets a duplicate Glass section; init and the agent instructions explain cookie banners (cookieless until `glass.consent(true)`), mirroring an existing analytics helper, and loading from the Worker URL on Vercel or Netlify.

## 0.3.0

### Minor Changes

- 1449c31: Session replay becomes a debugging tool. Recordings now include console warnings and errors, network requests (method, URL without query string, status, timing) and client-side navigation; `data-glass-mask` masks an element's text. Transcripts label clicks on content rendered after load, add CSS selectors, dead clicks, clicks followed by errors, stack frames, failed requests and console errors. New MCP tools `replay_snapshot`, `analyse_replays`, `annotate_replay` and `delete_replay_note`; `list_replays` can filter by signals, visited URL, events that did or did not happen, cohorts and text. The dashboard gets a full player (timeline markers, speed, skip inactivity, fullscreen, deep links, notes) and a Patterns page. Run `glass upgrade` to apply migration 0004 and switch the maintenance cron to hourly.
