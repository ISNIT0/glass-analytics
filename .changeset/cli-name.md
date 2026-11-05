---

"dataflare-cli": patch
"dataflare-web": patch
---

The CLI is published as `dataflare-cli` (npm rejected `dataflare` as too close to an existing package): `npx dataflare-cli init`, `npx dataflare-cli@latest upgrade`. Installed globally, the command is still `dataflare`. Deploy workflows and `.mcp.json` written by the CLI use `dataflare-cli`, and `/health` checks `dataflare-cli` on npm for new versions.
