# dataflare

The CLI for [Dataflare](https://github.com/ISNIT0/glass-analytics): open-source, agent-first analytics (web, product, session replay, A/B tests) that runs in your own Cloudflare account.

```sh
CLOUDFLARE_API_TOKEN=… npx dataflare init
```

`dataflare init` creates a D1 database, an R2 bucket and a Worker in your account, then prints the snippet for your framework and writes `AGENTS.md`, a Claude Code skill and `.mcp.json` so your coding agent can use Dataflare straight away.

```sh
npx dataflare status                       # check the deployment end to end
npx dataflare query web --from -7d         # ask questions from the terminal
npx dataflare query funnel --steps '$pageview,signup_completed'
npx dataflare sql "SELECT event, COUNT(*) AS n FROM events GROUP BY event"
npx dataflare flags set new-checkout --variants control:50,test:50
npx dataflare mcp                          # MCP server over stdio (what .mcp.json runs)
npx dataflare@latest upgrade               # stage a new version into .glass/ (CI deploys it)
npx dataflare ci                           # write the GitHub Actions workflow that deploys .glass/
npx dataflare --help
```

Every command takes `--json`. Docs: [getting started](https://github.com/ISNIT0/glass-analytics/blob/main/docs/getting-started.md), [agents](https://github.com/ISNIT0/glass-analytics/blob/main/docs/agents.md). License: MIT.
