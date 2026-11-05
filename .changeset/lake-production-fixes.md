---

"dataflare-cli": patch
"dataflare-web": patch
---

Lake mode works against production Cloudflare. Queries no longer fail with "Illegal invocation" in the Worker; `init --lake` lists Pipelines resources through the API (Wrangler's list output isn't JSON) and names streams, sinks and pipelines after the deployment, so a second lake deployment in one account gets its own instead of silently reusing the first's; and `--lake --eu` is refused up front, since Basin Catalog doesn't support jurisdiction buckets yet.
