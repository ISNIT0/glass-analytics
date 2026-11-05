---

"dataflare-cli": minor
"dataflare-web": minor
---

The lake store leaves beta. Schema changes now have an upgrade path: a new version gets its own streams and tables (Cloudflare can't alter a stream or share a table between sinks), and queries, your own SQL and erasure read every version through a UNION ALL. The web report and overview count visitors in two exact steps instead of COUNT(DISTINCT), which Basin SQL rejected at tens of millions of events; every query kind now runs at 30 million events in 1–7 seconds.
