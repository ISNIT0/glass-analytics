---

"dataflare-cli": patch
"dataflare-web": patch
---

Your own SQL (`POST /api/sql`, the MCP `sql` tool, `dataflare sql`) can no longer hide a second, writing statement from the read-only guard, which accepts the read key. The guard now tokenizes the query in one pass the way SQLite does, so a `/*` or `--` inside a string, a quote inside a `[bracketed]` identifier, or a `$name(...)` parameter can't make it misread where a string ends (#3, thanks @robertdoneill). As a backstop, a read-only query that changes the D1 database now fails with an error instead of returning normally.
