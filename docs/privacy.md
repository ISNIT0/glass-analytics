# Privacy

Glass runs entirely in your Cloudflare account. There is no Glass service: events, people, recordings and keys live in your D1 database, your R2 buckets and your Worker's secrets. Nothing is sent to the Glass project or to any third party, and the dashboard and SDK load no third-party resources. (The Glass website, which is separate from your deployment, uses the Meta Pixel to measure its own ads.)

## What is stored

| Data         | Where                     | Notes                                                                                                                                                            |
| ------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Events       | D1 `events` (or the lake) | URL without query string (except UTM tags), referrer without query string, title, country/region/city from Cloudflare, browser/OS/device family, your properties |
| IP addresses | Nowhere                   | Used only in memory, to derive cookieless ids                                                                                                                    |
| People       | D1 `persons`              | The properties you send with `identify()` / `setPersonProperties()`                                                                                              |
| Device links | D1 `identities`           | Anonymous device id → your user id                                                                                                                               |
| Replays      | R2, gzipped               | rrweb recordings; deleted after 30 days by default (`GLASS_REPLAY_RETENTION_DAYS`)                                                                               |

Set `GLASS_RETENTION_DAYS` (a Worker variable) to delete events older than that many days.

## Cookieless mode

With `persistence: 'cookieless'` (or `data-persistence="cookieless"`), the SDK stores nothing on the device. The Worker derives a visitor id from a daily-rotating secret salt, your project, the IP address and the user agent, hashes it with SHA-256, and stores only the hash. The salt changes every day, so ids can't be linked across days or reversed to an IP. Sessions are 30-minute windows of that id.

This is enough for web analytics. It is not enough for funnels across days, retention, experiments or replay, which need a stable id; call `glass.consent(true)` once the user agrees to switch to a persistent id. Whether you need consent in your jurisdiction is a question for your own legal advice.

## Session replay

- Every input is masked (`maskAllInputs`). Set `maskAllText` to mask all text as well, or mark elements with `data-glass-mask` to mask just their text.
- Elements matching `[data-glass-block]` (configurable) aren't recorded.
- Recording is sampled; nothing is recorded unless you set a sample rate.
- Network requests are recorded as method, URL without its query string, status and timing. Headers and bodies never are. Turn it off with `network: false`.
- Console `warn` and `error` messages are recorded by default; they contain whatever your code logs. Turn it off with `console: false`.
- Notes left on a session, and its cached summary, are deleted with the session (retention, or erasing a person).

## Deleting a person

```sh
npx @glassanalytics/cli person <user-id> --delete
```

This deletes the person, their device links, their replays and (in D1 mode) every event from their user id and devices. In lake mode, Iceberg tables are append-only to Glass, so events must be removed with a separate delete job against the table; this is on the [roadmap](../ROADMAP.md).

## EU data

`glass init --eu` creates the D1 database and R2 buckets in Cloudflare's EU jurisdiction. The Worker itself runs on Cloudflare's global network.
