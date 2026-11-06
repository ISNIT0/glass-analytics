---

"dataflare-cli": patch
"dataflare-web": patch
---

An install made with `init --no-replay` keeps session replay off: `dataflare upgrade` no longer creates its R2 bucket, which also stopped upgrades failing on tokens without R2 permission. Installs from before this release can record the choice once with `dataflare upgrade --no-replay`; on an install that already has a replay bucket it refuses rather than strand the replays (#9, thanks @robertdoneill).
