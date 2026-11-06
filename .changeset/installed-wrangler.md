---

"dataflare-cli": patch
"dataflare-web": patch
---

Since 0.8.1, the CLI runs the wrangler installed with it instead of downloading the newest wrangler 4.x through `npx` on every deploy. The lookup always failed because wrangler's `exports` don't include `bin/wrangler.js` (#5, thanks @robertdoneill).
