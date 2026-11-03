# Glass: analytics that lives in your Cloudflare account

Web analytics, product analytics, session replay and A/B tests. Deployed by one command, queried by your coding agent, and open source. Your data never leaves your account.

```sh
npx @glassanalytics/cli init
```

Or paste this into your coding agent:

> Add Glass analytics to this project: run `npx @glassanalytics/cli init`, track signups and purchases, then show me today's visitors.

Needs a Cloudflare account and an API token. Takes about two minutes. Full agent instructions: [/llms.txt](/llms.txt).

## From zero to answers

1. **Run one command.** `npx @glassanalytics/cli init` creates a D1 database, an R2 bucket and a Worker in your account, then writes instructions and an MCP server config for your agent.
2. **Add one script tag.** Or let your agent do it. Pageviews, clicks, errors and web vitals arrive straight away; custom events are one line.
3. **Ask your agent.** "Why did signups drop last week?" It runs funnels, reads session replays as text, and can ship a fix behind an experiment.

## Four tools on one event stream

- **Web analytics:** visitors, pages, referrers, campaigns, countries and devices, plus errors and Core Web Vitals. Cookieless mode needs no consent banner.
- **Product analytics:** trends, funnels and retention on any event, filtered or broken down by any event or person property. Raw SQL when you need it.
- **Session replay:** rrweb recordings with inputs masked, and a text transcript of each session that agents can read.
- **Flags and experiments:** feature flags evaluated in your Worker, and A/B tests with Bayesian results and sample-ratio checks.

## Your account, your data

Events, people and recordings live in your D1 database and R2 bucket; Glass has no servers. Keep data in the EU with `glass init --eu`. Delete a person and everything about them with one call.

## Cost

Your Cloudflare bill, nothing else. The default D1 store runs on the Workers free plan for small sites; Workers Paid raises the limits. For large volumes, `--lake` streams events to Iceberg tables in R2, queried with Basin SQL.

## Open source

MIT licensed: https://github.com/ISNIT0/glass-analytics
