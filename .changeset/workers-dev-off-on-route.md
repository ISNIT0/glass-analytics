---

"dataflare-cli": patch
"dataflare-web": patch
---

A Worker deployed on your own domain with `init --route` is no longer also reachable at its workers.dev address, which let traffic to `/e`, `/r` and `/f` skip the zone's WAF and rate limits (#4, thanks @robertdoneill). **If anything still sends to your workers.dev host** (a server-side SDK, a hard-coded snippet), point it at your route before running `dataflare upgrade`: the upgrade turns workers.dev off and those requests will get a 404.
