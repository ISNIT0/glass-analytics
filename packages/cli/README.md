# glass

The CLI for [Glass](https://github.com/ISNIT0/glass-analytics): open-source, agent-first analytics (web, product, session replay, A/B tests) that runs in your own Cloudflare account.

```sh
CLOUDFLARE_API_TOKEN=… npx @glassanalytics/cli init
```

`glass init` creates a D1 database, an R2 bucket and a Worker in your account, then prints the snippet for your framework and writes `AGENTS.md`, a Claude Code skill and `.mcp.json` so your coding agent can use Glass straight away.

```sh
npx @glassanalytics/cli status                       # check the deployment end to end
npx @glassanalytics/cli query web --from -7d         # ask questions from the terminal
npx @glassanalytics/cli query funnel --steps '$pageview,signup_completed'
npx @glassanalytics/cli sql "SELECT event, COUNT(*) AS n FROM events GROUP BY event"
npx @glassanalytics/cli flags set new-checkout --variants control:50,test:50
npx @glassanalytics/cli mcp                          # MCP server over stdio (what .mcp.json runs)
npx @glassanalytics/cli upgrade                      # deploy a new version
npx @glassanalytics/cli --help
```

Every command takes `--json`. Docs: [getting started](https://github.com/ISNIT0/glass-analytics/blob/main/docs/getting-started.md), [agents](https://github.com/ISNIT0/glass-analytics/blob/main/docs/agents.md). License: MIT.
