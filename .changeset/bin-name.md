---

"dataflare-cli": patch
"dataflare-web": patch
---

Fix `npx dataflare-cli` doing nothing: the CLI only started when its bin was named `glass`, and npm links it as `dataflare`. It now compares real paths, so it runs under any bin name.
