# Getting started

Glass deploys into your Cloudflare account with one command. You need a Cloudflare account and Node 20+.

## 1. Create an API token

At [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens), create a custom token with:

| Permission | Why |
| --- | --- |
| Account › Workers Scripts › Edit | Deploy the Glass Worker |
| Account › D1 › Edit | Create and migrate the database |
| Account › Workers R2 Storage › Edit | Store session replays |
| Account › Account Settings › Read | Find your account |
| Zone › Workers Routes › Edit | Only with `--route` |
| Account › Pipelines › Edit, Workers R2 Data Catalog › Edit, Workers R2 SQL › Read | Only with `--lake` |

The token is used by the CLI on your machine. It is not stored by Glass, except in lake mode, where it becomes a Worker secret so the Worker can query Basin SQL. (Use a separate read-only token there if you prefer; see [lake.md](lake.md).)

## 2. Run `glass init`

From your project's root:

```sh
CLOUDFLARE_API_TOKEN=… npx glass init
```

It will:

1. Create a D1 database (`glass`) and an R2 bucket for replays (`glass-replays`). If R2 isn't enabled on your account yet, replay is skipped; enable R2 in the dashboard and run `glass upgrade` later.
2. Deploy the Glass Worker to `https://glass.<your-subdomain>.workers.dev`, apply migrations, and set its secrets (two API keys and a salt).
3. Create a project named after your `package.json` (override with `--project`).
4. Send a test event and check it arrived.
5. Print the install snippet for your framework, and write files for your coding agent: `AGENTS.md` (and `CLAUDE.md` if you have one), `.claude/skills/glass/SKILL.md` and `.mcp.json`.

It also creates `.glass/` in your project. Commit it (`config.json`, `wrangler.jsonc`, `worker.js`, `migrations/`); `credentials.json` holds your keys and is git-ignored automatically.

Useful flags:

| Flag | |
| --- | --- |
| `--dry-run` | Show what would be created, change nothing |
| `--account <id>` | Choose the account non-interactively |
| `--project <id>` | Project id (lowercase letters, digits, `-`, `_`) |
| `--eu` | Create the database and buckets in the EU jurisdiction |
| `--route acme.com/_glass/*` | Also serve Glass from your own domain (first-party, so ad blockers don't block it) |
| `--lake` | Store events in Iceberg on R2 instead of D1 (beta; for high volume) |
| `--no-replay` | Skip replay storage |
| `--no-agent-files` | Don't write AGENTS.md, SKILL.md or .mcp.json |
| `--json` | Machine-readable output |

`glass init` is safe to re-run: it finds existing resources and keeps your keys.

## 3. Add the snippet

The script tag works everywhere and needs no build step:

```html
<script defer src="https://glass.<you>.workers.dev/s.js" data-project="my-app"></script>
```

| Framework | Where |
| --- | --- |
| Next.js | `app/layout.tsx`: `<Script src="…/s.js" data-project="my-app" strategy="afterInteractive" />` from `next/script` |
| Astro | `src/layouts/Layout.astro`, with `is:inline` on the script tag |
| SvelteKit | `src/app.html` |
| Nuxt | `app.head.script` in `nuxt.config.ts` |
| Remix / React Router | `app/root.tsx` |
| Vite apps | `npm i @glass/web`, then `glass.init({ host, project })` in `main.ts` |
| Server-side | `POST <host>/e`; see [sdk.md](sdk.md#server-side-events) |

## 4. Track what matters

Pageviews, clicks on links and buttons, JavaScript errors and web vitals are captured automatically. Add the events that describe your product:

```js
glass.capture('signup_completed', { plan: 'pro' });
glass.identify(user.id, { plan: user.plan, company_size: 12 }); // after login or signup
```

Without JavaScript:

```html
<button data-glass-event="pricing_cta_clicked" data-glass-prop-plan="pro">Start trial</button>
```

Name events `object_action` in snake_case and past tense. Put details in properties, and never send emails, names or other personal data.

## 5. Look at the data

- **Dashboard:** `https://glass.<you>.workers.dev/app`. Sign in with the key from `npx glass key`. Share a view-only dashboard with `npx glass key --read`.
- **Your agent:** with `.mcp.json` in place, ask "what were our top traffic sources this week?". See [agents.md](agents.md).
- **Terminal:** `npx glass query web --from -7d`, `npx glass events`, `npx glass --help`.

## Upgrading

```sh
npx glass@latest upgrade
```

This copies the new Worker into `.glass/`, applies new migrations and redeploys. `npx glass status` tells you when an upgrade is available.

## Removing Glass

Delete the Worker, the D1 database and the R2 buckets from the Cloudflare dashboard (they're all named after `--name`, `glass` by default), then delete `.glass/` and the Glass section of `AGENTS.md`.
