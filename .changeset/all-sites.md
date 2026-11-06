---

"dataflare-cli": patch
"dataflare-web": patch
---

All sites: deployments with more than one project get an "All sites" entry at the top of the project switcher and open on it, showing each project's visitors and pageviews against the previous period, a sparkline, the last pageview and a trend (gaining, losing, steady, new, stopped). Also `GET /api/sites` and the `compare_sites` MCP tool. One-project deployments are unchanged (#8, thanks @robertdoneill).
