---

"@glassanalytics/cli": minor
"@glassanalytics/web": minor
---

Session replay becomes a debugging tool. Recordings now include console warnings and errors, network requests (method, URL without query string, status, timing) and client-side navigation; `data-glass-mask` masks an element's text. Transcripts label clicks on content rendered after load, add CSS selectors, dead clicks, clicks followed by errors, stack frames, failed requests and console errors. New MCP tools `replay_snapshot`, `analyse_replays`, `annotate_replay` and `delete_replay_note`; `list_replays` can filter by signals, visited URL, events that did or did not happen, cohorts and text. The dashboard gets a full player (timeline markers, speed, skip inactivity, fullscreen, deep links, notes) and a Patterns page. Run `glass upgrade` to apply migration 0004 and switch the maintenance cron to hourly.
