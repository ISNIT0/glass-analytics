---

"@glassanalytics/cli": minor
"@glassanalytics/web": minor
---

Reports you can explore, key events and a cost page. Mark events as conversions or important (Events page, or the new `mark_event` MCP tool) and Reports show their rates, overall and per source. Marketing adds channels (search, social, paid, email, AI assistants, referral, direct) and a source table with conversion and bounce. Health adds errors over time, sessions affected, likely 404 pages, the slowest pages and replay frustration. Clicking any source, campaign, page, country or device opens a full report for that segment; source and page segments keep whole visits (new `session.<property>` filters). New Usage & cost page (and `usage_and_cost` tool) projects what Glass adds to the Cloudflare bill and recommends ways to cut it. Copyable agent prompts on Reports and in Insights' "New analysis" menu. New MCP tools `query_sources` and `site_health`. Run `glass upgrade` to apply migration 0005.
