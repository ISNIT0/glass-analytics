/**
 * Dashboard smoke run (local only, not part of CI): start the dev Worker in memory, seed errors,
 * revenue, groups and pipelines, open every page in Chromium, and save a screenshot of each plus
 * any console errors. Usage: node scripts/ui-smoke.ts <out-dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { transformSync } from 'esbuild';
import { chromium, type Page } from 'playwright';
import { startDevServer } from '../packages/worker/test/server.ts';

const out = process.argv[2] ?? 'test-results/ui';
mkdirSync(out, { recursive: true });
const server = await startDevServer({ port: 0, demoPort: 0, memory: true });
const base = server.glassUrl;
// Destinations post here (never to a real service).
const echo = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
});
await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
const hook = `http://127.0.0.1:${(echo.address() as AddressInfo).port}/hook`;
// A real minified bundle with its source map, so the issue page shows mapped frames.
const SOURCE = [
  'export function total(cart) {',
  '  return cart.items.reduce((sum, item) => sum + item.price, 0);',
  '}',
  'export function checkout(cart) {',
  '  if (!cart.items) {',
  "    throw new TypeError('Cart has no items');",
  '  }',
  '  return total(cart);',
  '}',
].join('\n');
const built = transformSync(SOURCE, {
  minify: true,
  sourcemap: 'external',
  sourcefile: 'src/cart.js',
  sourcesContent: true,
});
const throwColumn = built.code.indexOf('throw') + 1;
const call = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: 'Bearer dev-admin-key',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
};
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const now = Date.now();
let n = 0;
const ev = (event: string, extra: Record<string, unknown> = {}) => ({
  id: `seed-${++n}`,
  event,
  ts: now - Math.floor(Math.random() * 6 * 86_400_000) - 60_000,
  distinct_id: `dev-${n % 7}`,
  session_id: `s-${n % 11}`,
  url: `https://demo.test/${['', 'pricing', 'checkout', 'docs'][n % 4]}`,
  ...extra,
});
await call('PATCH', '/api/settings', {
  project: 'demo',
  settings: {
    baseCurrency: 'GBP',
    revenueEvents: [
      {
        event: 'order_paid',
        amountProperty: 'amount',
        productProperty: 'plan',
        subscriptionProperty: 'sub',
      },
    ],
    internalFilters: [{ property: 'person.email', op: 'contains', value: '@demo.test' }],
  },
});
const events = [];
for (let i = 0; i < 60; i++) {
  const company = `co-${i % 3}`;
  events.push(ev('$pageview', { props: { $groups: { company } } }));
  if (i % 3 === 0) {
    events.push(
      ev('$exception', {
        props: {
          type: 'TypeError',
          message: `Cannot read properties of undefined (reading 'price') #${i}`,
          stack: `TypeError: boom\n    at a (https://demo.test/assets/app-BxT8QXh2.js:1:${throwColumn})\n    at b (https://demo.test/assets/app-BxT8QXh2.js:1:1)\n    at https://cdn.vendor.test/lib.js:3:10`,
          $release: 'v1.4.0',
          $groups: { company },
        },
      }),
    );
  }
  if (i % 7 === 0)
    events.push(
      ev('$exception', {
        props: { type: 'RangeError', message: 'Invalid time value', handled: true },
      }),
    );
  if (i % 5 === 0)
    events.push(
      ev('order_paid', {
        props: {
          amount: 29 + (i % 4) * 20,
          plan: ['starter', 'pro', 'team'][i % 3],
          sub: `sub-${i % 6}`,
          $groups: { company },
        },
      }),
    );
}
await call(
  'POST',
  '/e',
  { project: 'demo', sent_at: Date.now(), lib: 'seed', events },
  { 'User-Agent': UA, 'Content-Type': 'text/plain' },
);
await call('POST', '/api/projects', { id: 'shop', name: 'Shop' }).catch(() => {});
const dest = await call('POST', '/api/destinations', {
  project: 'demo',
  template: 'slack',
  name: 'Signups to Slack',
  events: ['signup_completed'],
  inputs: { url: hook },
});
await call(
  'PUT',
  '/api/sourcemaps?project=demo&release=v1.4.0&path=/assets/app-BxT8QXh2.js',
  built.map,
);
await call('POST', '/api/transformations', {
  project: 'demo',
  rule: { kind: 'redact', patterns: ['email'] },
});
await call('POST', '/api/exports', {
  project: 'demo',
  target: 'http',
  settings: { url: hook },
});
const issues = await call('GET', '/api/issues?project=demo&from=-7d');
// An experiment with two primary metrics, a guardrail and a holdout, started a week ago.
await call('PUT', '/api/holdouts/q4-holdout', { project: 'demo', percentage: 10 });
await call('POST', '/api/experiments', {
  project: 'demo',
  key: 'checkout-test',
  hypothesis: 'A shorter checkout gets more people to pay',
  metrics: [
    { kind: 'conversion', event: 'order_paid', name: 'Paid' },
    {
      kind: 'mean',
      event: 'order_paid',
      math: 'sum',
      property: 'amount',
      name: 'Revenue per person',
    },
  ],
  secondary: [{ kind: 'conversion', event: '$exception', goal: 'decrease', name: 'Errors' }],
  holdout: 'q4-holdout',
  minimumDays: 0,
});
await call('POST', '/api/experiments/checkout-test/start', { project: 'demo' });
const exposures = [];
for (let i = 0; i < 80; i++) {
  const variant = i % 2 ? 'test' : 'control';
  // After the start: only exposures from then on count.
  const ts = Date.now() + i;
  exposures.push({
    id: `exp-${i}`,
    event: '$exposure',
    ts,
    distinct_id: `exp-user-${i}`,
    session_id: `xs-${i}`,
    url: 'https://demo.test/checkout',
    props: { flag: 'checkout-test', variant },
    flags: { 'checkout-test': variant },
  });
  if (i % (variant === 'test' ? 3 : 5) === 0)
    exposures.push({
      id: `exp-paid-${i}`,
      event: 'order_paid',
      ts: ts + 1,
      distinct_id: `exp-user-${i}`,
      session_id: `xs-${i}`,
      url: 'https://demo.test/checkout',
      props: { amount: 40 + (i % 3) * 10 },
      flags: { 'checkout-test': variant },
    });
}
await call('POST', '/api/import', { project: 'demo', events: exposures });
await call('PUT', '/api/flags/new-checkout', {
  project: 'demo',
  description: 'The redesigned checkout',
  rollout: 50,
  variants: [
    { key: 'control', weight: 50 },
    { key: 'test', weight: 50 },
  ],
  payloads: { control: { cta: 'Buy now' }, test: { cta: 'Get it today' } },
  bucketBy: 'person',
  rules: [
    { conditions: [{ property: 'person.plan', value: 'pro' }], rollout: 100, variant: 'test' },
  ],
  earlyAccess: { name: 'New checkout', stage: 'beta', description: 'A faster checkout' },
});
await call('POST', '/api/flags/new-checkout/schedule', {
  project: 'demo',
  at: new Date(Date.now() + 86_400_000).toISOString(),
  change: { rollout: 100 },
});

const routes: [string, string][] = [
  ['errors', 'errors?project=demo&from=-7d'],
  ['issue', `errors/${issues.issues[0].id}?project=demo&from=-7d`],
  ['revenue', 'revenue?project=demo&from=-30d&interval=week&breakdown=product'],
  ['groups', 'groups?project=demo'],
  ['group', 'groups/company/co-1?project=demo&from=-7d'],
  ['destinations', 'pipelines/destinations?project=demo'],
  ['destination', `pipelines/destinations/${dest.destination.id}?project=demo`],
  ['destination-new', 'pipelines/destinations/new?project=demo&template=meta-capi'],
  ['transformations', 'pipelines/transformations?project=demo'],
  ['exports', 'pipelines/exports?project=demo'],
  ['settings', 'settings?project=demo'],
  [
    'insights-trends',
    'insights/new/trends?project=demo&from=-7d&spec=%7B%22series%22%3A%5B%7B%22event%22%3A%22%24pageview%22%2C%22math%22%3A%22total%22%7D%2C%7B%22event%22%3A%22%24exception%22%2C%22math%22%3A%22total%22%7D%5D%2C%22interval%22%3A%22day%22%2C%22aggregateBy%22%3A%22company%22%2C%22formulas%22%3A%5B%7B%22expr%22%3A%22B%20/%20A%20%2A%20100%22%7D%5D%2C%22cumulative%22%3Atrue%7D',
  ],
  [
    'insights-funnel-ttc',
    'insights/new/funnel?project=demo&from=-7d&spec=%7B%22steps%22%3A%5B%7B%22event%22%3A%22%24pageview%22%7D%2C%7B%22event%22%3A%22order_paid%22%7D%5D%2C%22window%22%3A%227d%22%2C%22order%22%3A%22strict%22%2C%22viz%22%3A%22time_to_convert%22%7D',
  ],
  [
    'insights-funnel',
    'insights/new/funnel?project=demo&from=-7d&spec=%7B%22steps%22%3A%5B%7B%22event%22%3A%22%24pageview%22%7D%2C%7B%22event%22%3A%22order_paid%22%7D%5D%2C%22window%22%3A%227d%22%2C%22exclusions%22%3A%5B%7B%22event%22%3A%22%24exception%22%2C%22fromStep%22%3A1%2C%22toStep%22%3A2%7D%5D%7D',
  ],
  [
    'insights-retention',
    'insights/new/retention?project=demo&from=-7d&spec=%7B%22cohortEvent%22%3A%7B%22event%22%3A%22%24pageview%22%7D%2C%22returnEvent%22%3A%7B%22event%22%3A%22%24pageview%22%7D%2C%22period%22%3A%22day%22%2C%22periods%22%3A6%2C%22retentionType%22%3A%22recurring%22%2C%22cumulative%22%3Atrue%2C%22aggregateBy%22%3A%22company%22%7D',
  ],
  ['people', 'users?project=demo'],
  ['flag', 'flags/new-checkout?project=demo'],
  ['experiments-list', 'experiments?project=demo'],
  ['experiment', 'experiments/checkout-test?project=demo'],
  ['experiment-new', 'experiments/new?project=demo'],
  ['holdout', 'experiments/holdouts/q4-holdout?project=demo'],
];
const browser = await chromium.launch({ args: [`--user-agent=${UA}`] });
const problems: string[] = [];
async function session(theme: 'light' | 'dark', width: number, height: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  await context.addInitScript((t) => localStorage.setItem('glass:theme', t), theme);
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${theme}/${width} ${page.url()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${theme}/${width} ${page.url()}: ${e.message}`));
  page.on('response', async (r) => {
    if (r.status() >= 400)
      problems.push(
        `${theme}/${width} HTTP ${r.status()} ${r.request().method()} ${r.url()}: ${(await r.text().catch(() => '')).slice(0, 200)}`,
      );
  });
  await page.goto(`${base}/app?project=demo#key=dev-admin-key`);
  await page.waitForTimeout(300);
  problems.length = 0;
  return page;
}
const actions: Record<string, (p: Page) => Promise<void>> = {
  'insights-trends': async (p) => {
    await p.getByRole('button', { name: 'People' }).first().click();
    await p.waitForTimeout(700);
  },
  destination: async (p) => {
    await p.getByRole('button', { name: 'Send a test event' }).click();
    await p.waitForTimeout(700);
  },
  transformations: async (p) => {
    await p.getByRole('button', { name: 'Try it' }).click();
    await p.waitForTimeout(700);
  },
  exports: async (p) => {
    await p.locator('table .link-button').first().click();
    await p.waitForTimeout(700);
  },
};
const MOBILE = new Set([
  'errors',
  'issue',
  'revenue',
  'groups',
  'group',
  'destinations',
  'destination-new',
  'settings',
  'insights-trends',
  'insights-funnel',
]);
for (const [theme, width, height, suffix] of [
  ['light', 1360, 900, ''],
  ['dark', 1360, 900, '-dark'],
  ['light', 390, 844, '-mobile'],
] as const) {
  const page = await session(theme, width, height);
  for (const [name, route] of routes) {
    if (suffix === '-mobile' && !MOBILE.has(name)) continue;
    await page.goto(`${base}/app#/${route}`);
    await page.waitForTimeout(900);
    const text = await page
      .locator('.main')
      .first()
      .textContent()
      .then((t) => t ?? '')
      .catch(() => '');
    if (
      /Request failed|Something went wrong|is not a function|of undefined \(reading '(?!price)/.test(
        text.slice(0, 4000),
      )
    )
      problems.push(
        `${name}${suffix}: page text mentions an error: ${text.slice(0, 300).replace(/\n/g, ' | ')}`,
      );
    await page.screenshot({ path: `${out}/${name}${suffix}.png`, fullPage: true });
    const act = actions[name];
    if (act && suffix !== '-mobile') {
      await act(page).catch((e) => problems.push(`${name}${suffix}: action failed: ${e.message}`));
      await page.screenshot({ path: `${out}/${name}${suffix}-after.png`, fullPage: true });
      await page.keyboard.press('Escape');
    }
  }
  await page.context().close();
}
writeFileSync(`${out}/problems.json`, JSON.stringify(problems, null, 2));
console.log(JSON.stringify({ problems }, null, 2));
await browser.close();
await server.close();
echo.close();
