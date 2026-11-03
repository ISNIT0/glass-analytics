# Agents: MCP, CLI and HTTP

Everything in Glass is available to agents in three equivalent ways. They call the same service, so results match exactly.

## MCP

`glass init` adds this to `.mcp.json`, which Claude Code, Cursor and other MCP clients read:

```json
{ "mcpServers": { "glass": { "command": "npx", "args": ["-y", "glass", "mcp"] } } }
```

`glass mcp` is a small stdio bridge that forwards to your Worker's `/mcp` endpoint with the key from `.glass/credentials.json`, so no secret goes into the config file. Clients that support remote servers can connect directly instead:

```sh
claude mcp add --transport http glass https://glass.<you>.workers.dev/mcp --header "Authorization: Bearer $GLASS_API_KEY"
```

Use the read-only key (`npx glass key --read`) for agents that shouldn't change flags or experiments; write tools then return a clear error.

### Tools

| Tool | |
| --- | --- |
| `overview` | Start here: headline stats vs the previous period, top pages, referrers, errors, frequent events and the events that moved most |
| `query_web` | The full web analytics view |
| `query_trends` | Counts, unique people, sums or averages over time, with breakdowns |
| `query_funnel` | Conversion through ordered steps within a window, with breakdowns |
| `query_retention` | Cohort retention by day, week or month |
| `sql` | One read-only SELECT against the event store |
| `list_events` | Event names, counts and documentation status |
| `describe_event` | Properties sent with an event: types, coverage, examples |
| `define_event` | Document an event and its properties |
| `instrument` | The exact code to track an event in a framework |
| `search_persons`, `get_person` | Identified people; one person's properties, devices, events and replays |
| `list_replays`, `summarise_replay` | Recorded sessions; a session as a text transcript |
| `list_flags`, `save_flag`, `delete_flag` | Feature flags |
| `list_experiments`, `create_experiment`, `experiment_results`, `update_experiment` | A/B tests: create, start, read, stop, ship |
| `list_projects`, `create_project` | Projects |

Every result includes a `summary` sentence, the `sql` that ran, and a `dashboard` link to the same view. Tool input schemas are generated from the same zod schemas the API validates with, so the descriptions agents see are always current.

### Recipes

- **"Why did X drop?"** `overview` → `query_funnel` with `breakdown: "browser"` (or `utm_source`, `device`) → `list_replays` with `with_errors: true` → `summarise_replay`.
- **"Add tracking for Y."** `instrument` with the event name → add the code → deploy → `describe_event` to confirm it arrives → `define_event` to document it.
- **"Test Z."** `create_experiment` with a goal → branch on `glass.flag(key)` in code → `update_experiment` with `start` → later `experiment_results` → `update_experiment` with `ship`.

## CLI

All commands accept `--json`. In a project set up with `glass init` they need no configuration; elsewhere set `GLASS_HOST`, `GLASS_API_KEY` and optionally `GLASS_PROJECT`.

```sh
npx glass query web --from -7d
npx glass query trends --event signup_completed --math unique_persons --interval week --breakdown utm_source
npx glass query funnel --steps '$pageview,signup_started,signup_completed' --window 1d --where 'device=mobile'
npx glass query retention --cohort signup_completed --return '$pageview' --period week
npx glass query funnel --spec '{"steps":[{"event":"a"},{"event":"b"}],"from":"-90d"}' --sql
npx glass sql "SELECT path, COUNT(*) AS n FROM events WHERE event = '\$pageview' GROUP BY path ORDER BY n DESC LIMIT 10"
npx glass events signup_completed
npx glass replays --errors
npx glass replays summary <session-id>
npx glass flags set new-checkout --variants control:50,test:50
npx glass experiments create checkout-v2 --goal purchase_completed
```

## HTTP

`GET /api` on your Worker lists every endpoint, `GET /api/schema` returns JSON Schemas for every query spec, and `GET /llms.txt` has these instructions with your real URLs. Authenticate with `Authorization: Bearer <key>`.

```sh
curl -s https://glass.<you>.workers.dev/api/query \
  -H "Authorization: Bearer $GLASS_API_KEY" \
  -d '{"kind":"funnel","steps":[{"event":"$pageview"},{"event":"signup_completed"}],"from":"-30d","breakdown":"utm_source"}'
```

Errors are JSON with an `error` message and, where useful, a `hint` saying how to fix it.
