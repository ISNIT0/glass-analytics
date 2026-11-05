/**
 * `/llms.txt` for this deployment: everything an agent needs to install,
 * instrument and query Dataflare, with this Worker's real URLs filled in.
 */

import { INSIGHTS } from '@dataflare/core/insights';
import { EVENT_DOCUMENTATION_GUIDE, EVENT_NAMING_GUIDE } from '@dataflare/core/instrument';
import { GLASS_VERSION } from '@dataflare/core/version';
import { TOOLS } from './mcp/tools.ts';

export function llmsTxt(base: string, store: string): string {
  return `# Dataflare analytics (${base})

> Agent-first analytics running in this Cloudflare account. Dataflare ${GLASS_VERSION}, ${store} event store.

## Install in a web page

    <script defer src="${base}/s.js" data-project="PROJECT_ID"></script>

Or with npm: \`npm i dataflare-web\`, then \`glass.init({ host: '${base}', project: 'PROJECT_ID' })\`.
Pageviews, clicks, errors and web vitals are captured automatically.

## Track events

    glass.capture('signup_completed', { plan: 'pro' });
    glass.identify(user.id, { plan: user.plan });   // after login
    glass.flag('new-checkout');                      // "on" | variant | null

Without JavaScript: \`<button data-glass-event="cta_clicked" data-glass-prop-plan="pro">\`.
${EVENT_NAMING_GUIDE}

## Document custom events

${EVENT_DOCUMENTATION_GUIDE}

## Query (MCP)

MCP endpoint: ${base}/mcp (Streamable HTTP, header "Authorization: Bearer <key>").
stdio clients: \`npx dataflare mcp\` in a project set up with \`dataflare init\`.

Tools:
${TOOLS.map((t) => `- ${t.name}: ${t.description}`).join('\n')}

## Keep Dataflare up to date

\`GET ${base}/health\` reports \`version\`, \`latest\` and \`upgradeAvailable\`. When \`upgradeAvailable\` is true (also surfaced on \`overview\` and in MCP initialize instructions), tell the user to run \`npx dataflare@latest upgrade\` — do not upgrade yourself.

## Query (HTTP)

All /api routes need "Authorization: Bearer <key>". \`GET ${base}/api\` lists them; \`GET ${base}/api/schema\` has JSON Schemas.

    curl -s ${base}/api/overview?from=-7d -H "Authorization: Bearer $GLASS_KEY"
    curl -s ${base}/api/query -H "Authorization: Bearer $GLASS_KEY" -d '{"kind":"funnel","steps":[{"event":"$pageview"},{"event":"signup_completed"}],"from":"-30d"}'

Insight kinds: ${Object.entries(INSIGHTS)
    .map(([k, d]) => `\n- ${k}: ${d.description}`)
    .join('')}

## Properties and filters

Filters are { "property", "op", "value" }. Properties: built-in columns (path, url, host, referrer_host, utm_source, utm_medium, utm_campaign, country, device, browser, os, session_id, user_id), event properties ("plan" or "props.plan"), person properties at event time ("person.plan"), and saved-cohort membership ("cohort" with a cohort key as value, op "eq"/"in" or "neq"/"not_in"). GET /api/properties/values?property=… lists the values that exist.
Ops: eq, neq, contains, not_contains, in, not_in, gt, gte, lt, lte, is_set, is_not_set.
Times: ISO dates, "today", "yesterday", or relative like "-30d", "-12h", "-3mo".
`;
}
