/**
 * Files written for coding agents by `glass init`, so the next agent session
 * already knows how to track events and query Glass:
 *
 * - AGENTS.md (and CLAUDE.md if present): a marked section, replaced on re-run
 * - .claude/skills/glass/SKILL.md: recipes, loaded when relevant
 * - .mcp.json (and .cursor/mcp.json if .cursor/ exists): the MCP server
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EVENT_DOCUMENTATION_GUIDE, EVENT_NAMING_GUIDE } from '@glassanalytics/core/instrument';

const START = '<!-- glass:start -->';
const END = '<!-- glass:end -->';

export interface AgentFileOptions {
  root: string;
  host: string;
  project: string;
  /** The install snippet for this project's framework. */
  snippet: { file: string; code: string };
}

export function agentsSection(o: AgentFileOptions): string {
  return `${START}
## Analytics (Glass)

This project uses Glass for analytics, session replay, feature flags and A/B tests. It runs in our own Cloudflare account; deployment config is in \`.glass/\`.

- Dashboard: ${o.host}/app (print the key with \`npx @glassanalytics/cli key\`)
- MCP server \`glass\` is configured in \`.mcp.json\`. Start with the \`overview\` tool, then \`list_events\` for exact event names.
- Terminal: \`npx @glassanalytics/cli query web --from -7d\`, \`npx @glassanalytics/cli sql "SELECT …"\`, \`npx @glassanalytics/cli --help\`

Tracking (project \`${o.project}\`):
- Install (${o.snippet.file}): \`${o.snippet.code.split('\n').pop()}\`
- Custom events: \`glass.capture('signup_completed', { plan: 'pro' })\`. After login: \`glass.identify(user.id, { plan })\`.
- ${EVENT_NAMING_GUIDE}
- After adding an event and deploying, confirm it arrives: \`npx @glassanalytics/cli events <name>\` (or MCP \`describe_event\`).
- ${EVENT_DOCUMENTATION_GUIDE}
- Prefer MCP \`define_event\` so you can set both the event description and each property's meaning in one call.
- Feature flags: \`glass.flag('key')\` returns "on", a variant key, or null. Create with \`npx @glassanalytics/cli flags set <key> --rollout 10\`.

Upgrades (the Worker version is pinned in \`.glass/config.json\`):
- \`.github/workflows/glass.yml\` deploys whatever \`.glass/\` holds when it changes on the default branch. If that file is missing, run \`npx @glassanalytics/cli ci\` and add the \`CLOUDFLARE_API_TOKEN\` repository secret.
- To upgrade: \`npx @glassanalytics/cli@latest upgrade\` stages the new Worker and migrations into \`.glass/\` without deploying. Commit and push (or open a PR); CI deploys. Ask before pushing if pushes also deploy the site.
- Do not deploy Glass from a laptop (\`glass upgrade --local\`, wrangler) once the workflow exists, and never commit \`.glass/credentials.json\`.
- \`glass upgrade\` refuses to replace a newer Worker with an older CLI. If it does, use \`@latest\`; do not pass \`--allow-downgrade\`.
${END}`;
}

/** Insert or replace the Glass section in a markdown file. */
export function upsertSection(path: string, section: string, createIfMissing: boolean): boolean {
  const exists = existsSync(path);
  if (!exists && !createIfMissing) return false;
  const current = exists ? readFileSync(path, 'utf8') : '';
  const pattern = new RegExp(`${START}[\\s\\S]*?${END}`);
  const next = pattern.test(current) ? current.replace(pattern, section) : `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${section}\n`;
  writeFileSync(path, next);
  return true;
}

export function skillFile(o: AgentFileOptions): string {
  return `---
name: glass
description: Use when adding analytics events, answering questions about traffic, signups, conversion, retention or errors, debugging what a user did in a session, or creating feature flags and A/B tests in this project.
---

# Glass analytics

Glass is deployed at ${o.host} (project \`${o.project}\`). Prefer the \`glass\` MCP tools; the CLI (\`npx @glassanalytics/cli …\`) does the same things.

## Answer a question about usage

1. \`overview\` for the period (visitors, top pages, errors, events that moved). If it (or MCP init) says an upgrade is available, tell the user; with their go-ahead, follow "Upgrade Glass" below.
2. \`list_events\` to get exact event names — never guess them.
3. The right query: \`query_trends\` (counts over time), \`query_funnel\` (conversion through steps), \`query_retention\` (who comes back), \`sql\` when nothing else fits.
4. Report numbers with the dashboard link and SQL from the result.

## Add tracking

1. \`instrument\` with the event name returns the exact code for this framework.
2. ${EVENT_NAMING_GUIDE}
3. After deploying, \`describe_event\` (or \`npx @glassanalytics/cli events <name>\`) confirms events arrive with the expected properties.
4. Always \`define_event\` next. ${EVENT_DOCUMENTATION_GUIDE}

## First session on a project

1. \`overview\` then \`list_events\`.
2. For every name in \`undocumented\`, read the code that fires it (or ask), then \`define_event\` with how/when it fires and property meanings.
3. Do not invent funnel or trend queries against undocumented custom events until those descriptions exist.

## Debug a user problem

1. \`query_funnel\` with a breakdown (browser, device, utm_source) to find where people drop.
2. \`list_replays\` to find affected sessions: \`has: ["errors"]\` or \`["rage_clicks"]\`, a \`person\`, or \`did_event\` (the step before the drop) with \`not_event\` (the step after).
3. \`summarise_replay\` to read what happened: pages, clicks with CSS selectors, rage and dead clicks, errors with stack frames, failed requests, console errors.
4. \`replay_snapshot\` at the moment it goes wrong to see what was on screen; search the code for the clicked element's selector.
5. \`annotate_replay\` with the cause, so the next person watching the session sees it.

For "what's frustrating users?", start with \`analyse_replays\` for the period.

## Upgrade Glass

1. \`npx @glassanalytics/cli@latest upgrade\`. With \`.github/workflows/glass.yml\` present this only stages \`.glass/\` (Worker, migrations, pinned version); nothing deploys.
2. No workflow yet? \`npx @glassanalytics/cli ci\` writes it; the repo needs secret \`CLOUDFLARE_API_TOKEN\` (\`gh secret set CLOUDFLARE_API_TOKEN\`).
3. Commit \`.glass/\` and push to the default branch (or open a PR). The Glass workflow migrates D1 and deploys.
4. \`npx @glassanalytics/cli status\` confirms the new version is live.

## Run an experiment

1. \`create_experiment\` with a goal event (creates a control/test flag).
2. In code: \`if (glass.flag('<key>') === 'test') { … }\` — reading the flag records the exposure.
3. \`update_experiment\` with \`action: "start"\`; later \`experiment_results\`; ship the winner with \`action: "ship"\`.
`;
}

export function upsertMcpConfig(path: string): boolean {
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(readFileSync(path, 'utf8')) as typeof config;
    } catch {
      return false; // don't overwrite a file we can't parse
    }
  }
  config.mcpServers = { ...config.mcpServers, glass: { command: 'npx', args: ['-y', '@glassanalytics/cli', 'mcp'] } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

/** Write all agent files. Returns the paths written, relative to root. */
export function writeAgentFiles(o: AgentFileOptions): string[] {
  const written: string[] = [];
  const section = agentsSection(o);
  if (upsertSection(join(o.root, 'AGENTS.md'), section, true)) written.push('AGENTS.md');
  if (upsertSection(join(o.root, 'CLAUDE.md'), section, false)) written.push('CLAUDE.md');
  const skill = join(o.root, '.claude', 'skills', 'glass', 'SKILL.md');
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, skillFile(o));
  written.push('.claude/skills/glass/SKILL.md');
  if (upsertMcpConfig(join(o.root, '.mcp.json'))) written.push('.mcp.json');
  if (existsSync(join(o.root, '.cursor')) && upsertMcpConfig(join(o.root, '.cursor', 'mcp.json'))) written.push('.cursor/mcp.json');
  return written;
}
