/**
 * Guides (/guides/<slug>/): one per framework that `dataflare init` detects, with
 * snippets generated from the same FRAMEWORKS table the CLI prints, plus a
 * few topic guides. Everything here must match the docs; link to them for detail.
 */

import { FRAMEWORKS, type Framework } from '../../../packages/core/src/instrument.ts';

export interface Guide {
  slug: string;
  title: string;
  /** Short title for lists. */
  label: string;
  description: string;
  /** Markdown body. */
  body: string;
  kind: 'framework' | 'topic';
}

const HOST = 'https://glass.<you>.workers.dev';
const PROJECT = 'my-app';

const FRAMEWORK_NOTES: Partial<Record<Framework, { slug: string; intro: string; extra?: string }>> =
  {
    nextjs: {
      slug: 'nextjs',
      intro:
        'Next.js apps on Vercel, on Cloudflare (via OpenNext) or anywhere else can send analytics to a Dataflare Worker in your Cloudflare account. The script tag loads after the page is interactive and tracks client-side navigations automatically.',
      extra:
        'Server actions and route handlers can send events too: POST to `<host>/e` (see the [SDK docs](/docs/sdk/#server-side-events)), with the same `distinct_id` the browser uses if you want them joined to the visit.',
    },
    astro: {
      slug: 'astro',
      intro:
        'Astro sites, static or server-rendered, add Dataflare with one inline script tag in the base layout. View transitions count as page views.',
    },
    sveltekit: {
      slug: 'sveltekit',
      intro:
        'SvelteKit apps add the script tag to `src/app.html`, so every page and every client-side navigation is tracked.',
    },
    nuxt: {
      slug: 'nuxt',
      intro:
        'Nuxt apps add the script through `app.head` in `nuxt.config.ts`. Route changes are tracked as page views.',
    },
    remix: {
      slug: 'remix',
      intro:
        'Remix and React Router apps add the script tag in `app/root.tsx`. Client-side navigations are tracked as page views.',
    },
    vite: {
      slug: 'vite',
      intro:
        'Single-page apps built with Vite (React, Vue, Svelte, Solid) can use the npm package instead of a script tag, so types and tree-shaking come with it.',
    },
    html: {
      slug: 'html',
      intro:
        'Any website, from a hand-written HTML page to a static site generator such as Hugo, Jekyll or Eleventy, needs one script tag in the `<head>` of every page.',
    },
    worker: {
      slug: 'cloudflare-workers',
      intro:
        'Workers, Hono apps and other server code send events with a plain `fetch` to your Dataflare Worker. Use this for events that only the server knows about, such as a payment succeeding.',
    },
  };

function frameworkGuide(id: Framework): Guide | null {
  const note = FRAMEWORK_NOTES[id];
  if (!note) return null;
  const fw = FRAMEWORKS[id];
  const snippet = fw.snippet({ host: HOST, project: PROJECT });
  const lang = id === 'html' || id === 'astro' || id === 'sveltekit' ? 'html' : 'ts';
  const name = fw.name.replace(/ \(.*\)$/, '');
  const browser = id !== 'worker';
  const body = `${note.intro}

Dataflare is open-source analytics that runs in your own Cloudflare account: web analytics, product analytics (trends, funnels, retention), session replay, feature flags and A/B tests. There is no Dataflare service to sign up for. Your events go to a Worker and a D1 database in your account.

## 1. Deploy Dataflare

From your project's root, with a [Cloudflare API token](/docs/getting-started/#1-create-an-api-token):

\`\`\`sh
CLOUDFLARE_API_TOKEN=… npx dataflare init
\`\`\`

\`dataflare init\` detects ${name} from your \`package.json\`, creates the database, the replay bucket and the Worker, and prints the snippet below with your real host and project filled in. It also writes \`AGENTS.md\`, a Claude Code skill and \`.mcp.json\`, so your coding agent can do the next steps for you.

## 2. Add the snippet

In \`${snippet.file}\`:

\`\`\`${lang}
${snippet.code}
\`\`\`

${browser ? 'Page views, clicks, JavaScript errors and Core Web Vitals start arriving straight away.' : 'Send one event per action. Events with an `id` are de-duplicated, so retries are safe.'}

## 3. Track what matters

\`\`\`${id === 'vite' || id === 'worker' ? 'ts' : 'js'}
${snippet.capture('signup_completed', { plan: 'pro' })}
\`\`\`
${
  browser
    ? `
After someone signs in, link their visits to their account so funnels span the moment of signup:

\`\`\`js
${id === 'vite' ? 'glass' : 'window.glass?'}.identify(user.id, { plan: user.plan });
\`\`\`
`
    : ''
}
Name events \`object_action\` in the past tense (\`signup_completed\`, \`invite_sent\`) and put details in properties, never personal data.${note.extra ? `\n\n${note.extra}` : ''}

## 4. Check it works

\`\`\`sh
npx dataflare status
npx dataflare events signup_completed
\`\`\`

Then open \`${HOST}/app\` (sign in with \`npx dataflare key\`), or ask your agent: *"Which traffic source converts best to signup?"*

## Serve it from your own domain

Ad blockers often block third-party analytics domains. Serve Dataflare from a path on your own site instead, if your domain is on Cloudflare:

\`\`\`sh
npx dataflare init --route example.com
\`\`\`

Then use \`https://example.com/_glass\` as the host in the snippet.

## Next

- [Browser SDK reference](/docs/sdk/): options, flags, replay, consent
- [Session replay your agent can read](/guides/session-replay-for-agents/)
- [What it costs](/pricing/)
`;
  return {
    slug: note.slug,
    title: `${name} analytics with Dataflare: setup in two minutes`,
    label: name,
    description: `Add analytics to a ${name} app with Dataflare: open-source web and product analytics, session replay and A/B tests that run in your own Cloudflare account. Step-by-step setup.`,
    body,
    kind: 'framework',
  };
}

const TOPICS: Guide[] = [
  {
    slug: 'coding-agents',
    label: 'With your coding agent',
    title: 'Add analytics with your coding agent (Claude Code, Cursor, Codex)',
    description:
      'Let your coding agent install analytics, track events and answer questions about your users. Dataflare writes agent instructions and an MCP server config at install.',
    kind: 'topic',
    body: `Dataflare was built to be installed and queried by coding agents. Paste this into Claude Code, Cursor, Codex or any agent that can run commands:

> Add Dataflare analytics to this project: run \`npx dataflare init\`, track signups and purchases, then show me today's visitors.

## What the agent gets

\`dataflare init\` deploys Dataflare into your Cloudflare account, then writes three files into your project:

- **\`AGENTS.md\`** (and \`CLAUDE.md\` if you have one): how to name events, how to document them, and how to verify they arrive.
- **\`.claude/skills/glass/SKILL.md\`**: a skill with the query recipes below.
- **\`.mcp.json\`**: an MCP server entry (\`npx dataflare mcp\`) that forwards to your Worker with the key from \`.glass/credentials.json\`, so no secret goes into the config file.

From then on the agent has the [MCP tools](/docs/agents/#tools): overview, trends, funnels, retention, sources, site health, people, cohorts, replays, flags, experiments and read-only SQL. Every result includes a one-sentence summary, the SQL that ran and a link to the same view in the dashboard, so you can check its work.

## Questions that work well

- *"Why did signups drop last week?"* The agent compares periods, runs the funnel broken down by browser, finds sessions that started signup and didn't finish, and reads their replay transcripts.
- *"Add tracking for invites and show me a funnel from signup to first invite."*
- *"Which campaigns bring people who pay?"*
- *"Test a shorter pricing page against the current one."* It creates a flag and an experiment, branches on \`glass.flag()\` in your code, and reads the result when it's ready.

## Keep agents read-only if you prefer

\`\`\`sh
npx dataflare key --read
\`\`\`

Use the read key for agents that shouldn't change flags or experiments; write tools then return a clear error.

## Without MCP

The same operations are available as a CLI with \`--json\` on every command, and as an HTTP API (\`GET <worker>/api\` lists every endpoint). See [Agents: MCP, CLI and HTTP](/docs/agents/).
`,
  },
  {
    slug: 'cookieless-analytics',
    label: 'Cookieless analytics',
    title: 'Cookieless analytics on Cloudflare, without storing anything on the device',
    description:
      'How Dataflare counts visitors without cookies or local storage: a daily-rotating salted hash in your own Cloudflare Worker. What works, what needs consent, and how to switch.',
    kind: 'topic',
    body: `Dataflare can count visitors without storing anything on their device: no cookies, no local storage.

\`\`\`html
<script defer src="https://glass.<you>.workers.dev/s.js" data-project="my-app" data-persistence="cookieless"></script>
\`\`\`

## How it works

The Worker derives a visitor id from a secret salt that changes every day, your project, the IP address and the user agent. It hashes them with SHA-256 and keeps only the hash. Because the salt changes daily, ids can't be linked across days or turned back into an IP address. IP addresses are never stored. Sessions are 30-minute windows of that id.

Because Dataflare runs in your Cloudflare account, the hash is computed in your Worker, and nothing goes to a third party.

## What you get, and what you don't

Cookieless mode is enough for web analytics: visitors, page views, sessions, bounce rate, sources, campaigns, countries, devices, errors and Core Web Vitals.

It isn't enough for anything that needs to recognise someone on another day: funnels across days, retention, experiments and session replay. For those, ask for consent, then switch to a persistent id:

\`\`\`js
glass.consent(true);  // after the user agrees
glass.consent(false); // delete stored ids and go back to cookieless
\`\`\`

## Do you still need a cookie banner?

That depends on your jurisdiction and on everything else your site loads, so it's a question for your own legal advice. What Dataflare can tell you is exactly what it stores: see [Privacy](/docs/privacy/).

## Related

- [Delete everything about a person](/docs/privacy/#deleting-a-person) with one command
- Keep data in the EU with \`dataflare init --eu\`
`,
  },
  {
    slug: 'session-replay-for-agents',
    label: 'Replays agents can read',
    title: 'Session replay your coding agent can read',
    description:
      'Dataflare session replay comes with a text transcript of every session: pages, clicks with CSS selectors, rage and dead clicks, errors with stack frames and failed requests. Agents read it through MCP.',
    kind: 'topic',
    body: `Session replays are video for people. Dataflare also turns every session into text, so a coding agent can read what happened, find the selector in your code and fix it.

## Turn it on

\`\`\`html
<script defer src="https://glass.<you>.workers.dev/s.js" data-project="my-app"
  data-replay-sample-rate="0.1" data-replay-on-error-sample-rate="1"></script>
\`\`\`

This records one session in ten, plus any session where an error happens (the recorder keeps a short buffer, so you see what led up to it). Every input is masked. Network requests are recorded as method, URL without its query string, status and timing; headers and bodies never are.

## What the transcript contains

\`\`\`text
00:41 Clicked "Create account" (button)  #signup > button
00:41 Rage-clicked "Create account" (button) ×5
00:42 ERROR TypeError: crypto.randomUUID is not a function
      at submit (signup.js:88:14)
00:42 Request failed: POST /api/signup → 500 (210 ms)
\`\`\`

Pages, clicks with labels and CSS selectors, rage clicks, dead clicks (a click after which nothing changed), errors with stack frames, failed and slow requests, and console errors. \`replay_snapshot\` describes what was on screen at any moment: headings, buttons and whether they were disabled, dialogs, masked form fields.

## Ask about it

- *"Find sessions where people started checkout and didn't finish, and tell me what went wrong."* The agent calls \`list_replays\` with \`did_event\` and \`not_event\`, then \`summarise_replay\` on the most frustrated ones.
- *"What's annoying users this week?"* \`analyse_replays\` groups the most rage-clicked elements, common errors and failing requests across sessions, with example links.

Findings can be pinned to a moment with \`annotate_replay\`, and show up on the player's timeline for people too.

## Where recordings live

In an R2 bucket in your Cloudflare account, gzipped, deleted after 30 days by default (\`GLASS_REPLAY_RETENTION_DAYS\`). See the [cost calculator](/pricing/) for what recording costs at your volume.
`,
  },
  {
    slug: 'ab-testing-cloudflare',
    label: 'A/B tests on Cloudflare',
    title: 'Feature flags and A/B tests on Cloudflare Workers',
    description:
      'Run feature flags and A/B tests from your own Cloudflare Worker with Dataflare: server-side evaluation, targeting rules, Bayesian results and sample-ratio checks.',
    kind: 'topic',
    body: `Dataflare evaluates feature flags in your Worker and reports experiments on the same events as your analytics, so there's no second tool to wire up.

## A flag

\`\`\`js
if (glass.flag('new-checkout')) showNewCheckout();
\`\`\`

Flags have a rollout percentage and targeting rules on any event or person property (for example, \`person.plan\` is \`pro\`). Assignment is deterministic per person, so people see the same thing on every visit.

## An experiment

1. Create it with a goal event, in the dashboard or with your agent (\`create_experiment\`). It creates a flag with \`control\` and \`test\` variants.
2. Branch on the variant where it's shown, so exposure is recorded at the right moment:

   \`\`\`js
   const variant = glass.flag('pricing-page-v2'); // "control" or "test"
   \`\`\`
3. Start it. Results show exposures, conversion per variant, a 95% interval, the probability that each variant beats control, and the lift.
4. Ship the winner: the flag then serves that variant to everyone.

## How results are computed

Each person enters the experiment at their first exposure, and counts as converted if they do the goal event afterwards. People exposed to more than one variant are left out and counted separately. Dataflare checks for sample-ratio mismatch, which usually means the exposure is logged in the wrong place. The details are in [Flags and experiments](/docs/experiments/).
`,
  },
  {
    slug: 'self-hosted-analytics-without-servers',
    label: 'Self-hosted without servers',
    title: 'Self-hosted product analytics without running a server',
    description:
      'Self-host analytics with no servers, Docker or database to manage: Dataflare is a Cloudflare Worker, a D1 database and an R2 bucket in your own account, deployed with one command and upgraded from CI.',
    kind: 'topic',
    body: `Self-hosting analytics usually means a server, Docker, a database and a backup plan. Dataflare is three Cloudflare resources in your own account instead:

- a **Worker** that serves the SDK, ingests events, evaluates flags and runs the dashboard and API,
- a **D1 database** for events, people, flags and experiments,
- an **R2 bucket** for session recordings.

\`\`\`sh
CLOUDFLARE_API_TOKEN=… npx dataflare init
\`\`\`

## Upgrades from CI, not from your laptop

\`dataflare init\` writes \`.github/workflows/glass.yml\`. To upgrade, run \`npx dataflare@latest upgrade\`, which stages the new version in \`.glass/\`, then commit and push; CI deploys it. Dataflare refuses to replace a newer Worker with an older one.

## Limits to know about

- D1 databases hold up to 10 GB on Workers Paid (500 MB on Free). The [cost calculator](/pricing/) shows when you'd reach that at your volume. Set \`GLASS_RETENTION_DAYS\` to keep a rolling window, or use the lake store (\`--lake\`, beta), which streams events to Apache Iceberg tables in R2.
- Dataflare is new (0.x). The D1 store, SDK, dashboard, MCP server and CLI are covered by unit, integration and browser tests; the lake store depends on Cloudflare products in beta.

## Read and change everything

The Worker in your account is the code in the [repository](https://github.com/ISNIT0/glass-analytics), MIT licensed. Adding a query type, an MCP tool or a storage engine is a single file each: see [Extending Dataflare](/docs/extending/).
`,
  },
];

export const GUIDES: Guide[] = [
  ...(['nextjs', 'astro', 'sveltekit', 'nuxt', 'remix', 'vite', 'html', 'worker'] as Framework[])
    .map(frameworkGuide)
    .filter((g): g is Guide => g !== null),
  ...TOPICS,
];
