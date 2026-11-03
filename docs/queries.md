# Queries

Every query is a JSON spec. The same specs work in the dashboard (they're in its URLs), the MCP tools, the CLI (`--spec`) and `POST /api/query`.

## Time ranges

`from` (inclusive) and `to` (exclusive) accept ISO dates (`2026-10-01`), epoch milliseconds, `now`, `today`, `yesterday`, or relative offsets (`-30d`, `-12h`, `-2w`, `-3mo`, `-1y`). The default is the last 30 days. Buckets are UTC; shift them with `utcOffsetMinutes` (e.g. `60` for UTC+1).

## Properties

| Written as | Means |
| --- | --- |
| `path`, `url`, `host`, `referrer_host`, `title` | Page columns |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` | Campaign tags from the page URL |
| `country`, `region`, `city`, `device`, `browser`, `os` | From the request |
| `event`, `session_id`, `user_id`, `distinct_id` | Identity columns |
| `plan` or `props.plan` | The event property `plan` |
| `props.address.city` | A nested event property |
| `person.plan` | The person's `plan` at the time of the event |

## Filters

```json
{ "property": "person.plan", "op": "eq", "value": "pro" }
```

Ops: `eq` (default), `neq`, `contains`, `not_contains`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte`, `is_set`, `is_not_set`. Negative ops (`neq`, `not_contains`, `not_in`) include events where the property is missing. `contains` ignores case. Numeric comparisons apply to event and person properties.

## Web

```json
{ "kind": "web", "from": "-7d", "filters": [{ "property": "utm_campaign", "value": "launch" }] }
```

Visitors are distinct devices; a session ends after 30 minutes of inactivity. Referrers and UTM tags are attributed to the session's first pageview, so a campaign visit counts once, not once per page. Bounce rate is the share of sessions with one pageview.

## Trends

```json
{
  "kind": "trends",
  "series": [{ "event": "signup_completed", "math": "unique_persons" }, { "event": "order_paid", "math": "sum", "property": "amount" }],
  "interval": "week",
  "breakdown": "utm_source",
  "from": "-90d"
}
```

`math`: `total` (default), `unique_persons`, `unique_sessions`, `sum`, `avg`. With a breakdown, the top 10 values are kept (`breakdownLimit`); for totals and sums the rest are combined as "Other".

## Funnels

```json
{
  "kind": "funnel",
  "steps": [
    { "event": "$pageview", "filters": [{ "property": "path", "value": "/pricing" }] },
    { "event": "signup_started" },
    { "event": "signup_completed" }
  ],
  "window": "7d",
  "breakdown": "device"
}
```

A person enters at their first step-1 event in the range. Each later step must happen strictly after the previous one and within `window` of step 1. Breakdowns use the property of the step-1 event. The result has counts, conversion from the start and from the previous step, and the mean time between steps.

## Retention

```json
{
  "kind": "retention",
  "cohortEvent": { "event": "signup_completed" },
  "returnEvent": { "event": "$pageview" },
  "period": "week",
  "periods": 8,
  "from": "-90d"
}
```

A person's cohort is the period of their first `cohortEvent` in the range. Period 0 is the cohort itself; period *k* counts people who did `returnEvent` *k* periods later. The average weights cohorts by size and only includes cohorts old enough to have that period.

## SQL

```json
{ "query": "SELECT browser, COUNT(DISTINCT distinct_id) AS visitors FROM events WHERE project = 'my-app' AND ts_ms >= 1767225600000 GROUP BY browser", "limit": 100 }
```

One read-only `SELECT` (or `WITH … SELECT`). In D1 mode you can read `events`, `identities`, `persons`, `flags`, `experiments`, `replays` and `event_definitions`; in lake mode, `<namespace>.events` and `<namespace>.identities`. `ts_ms` is epoch milliseconds; `props`, `person_props` and `flags` are JSON (`json_extract(props, '$.plan')` in D1, `json_get_str(props, 'plan')` in the lake).

Each query result's `sql` field shows exactly what ran, which is the easiest way to learn the schema.
