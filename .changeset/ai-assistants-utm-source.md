---
"dataflare-cli": patch
"dataflare-web": patch
---

Visitors from AI assistants are counted as "AI assistants" when the link carries the assistant in `utm_source` (ChatGPT search adds `utm_source=chatgpt.com` and sends no referrer). They used to land in "Other campaigns".
