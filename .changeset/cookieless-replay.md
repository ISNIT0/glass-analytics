---
"@glassanalytics/cli": minor
"@glassanalytics/web": minor
---

Session replay can record cookieless visitors. Add `data-replay-cookieless="true"` (or `replay: { cookieless: true }`) and visitors who haven't consented are recorded too, still with nothing stored on the device: the Worker files each page load's recording under the same daily-rotating visitor and session ids as its events, so the replay joins the visit. `glass.consent(false)` now stops replay for the rest of the page even if the recorder was still loading, and `consent(true)` restarts a cookieless recording under the stored session.
