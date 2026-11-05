---

"dataflare": minor
"dataflare-web": minor
---

Glass is now Dataflare, at https://dataflare.dev. The CLI is published as `dataflare` (`npx dataflare init`, `npx dataflare@latest upgrade`) and the browser SDK as `dataflare-web`; the `@glassanalytics/cli` and `@glassanalytics/web` packages get no new versions. Nothing changes in your snippet or deployment: `window.glass`, the `data-glass-*` attributes, the `/_glass` route, `.glass/` and the `GLASS_*` settings all stay, and the SDK still exports `Glass` as an alias of the renamed `Dataflare` class. `dataflare upgrade` rewrites a deploy workflow generated before the rename so CI installs `dataflare` instead of `@glassanalytics/cli`.
