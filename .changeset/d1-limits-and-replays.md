---

"dataflare-cli": patch
"dataflare-web": patch
---

Fixes for five failures reported in #2:

- **D1's 100-parameter limit.** Ingesting a batch that touches more than 98 known people, and erasing a person with more than 32 device links, no longer fails. Person updates go 90 at a time, and erasure passes its ids as one JSON parameter.
- **Erasure that finishes.** A person's replays are deleted 50 sessions per slice with one D1 batch each, instead of two queries per session, which could pass D1's per-invocation limit. A request does two slices, and the hourly job finishes anything left. The person and their device links are deleted last, so `"complete": true` means everything is gone. A failure part way leaves the rows that let the next run finish. Retention uses the same bounded slices.
- **Retried replay uploads count once.** A chunk whose response was lost and is sent again no longer doubles the session's chunk, byte, page, click and error counts.
- **EU replay buckets.** The `REPLAYS` binding now names its jurisdiction. Before, an EU deployment's Worker wrote replays to a default-jurisdiction bucket of the same name that Wrangler created on deploy, so replays were stored outside the EU. `dataflare upgrade` switches to the EU bucket and keeps the old one bound as `REPLAYS_LEGACY`: replays still read from it, and the hourly job moves its objects across. See [privacy.md](docs/privacy.md#eu-data) for removing it afterwards.
- **Routes on multi-label domains.** The generated route no longer guesses the zone from the hostname's last two labels (`co.uk` for `analytics.example.co.uk`). Wrangler now resolves the zone by trying each parent domain against your account's zones, which also handles delegated subzones.
