/**
 * Regenerate the landing page's product images and the public demo from a
 * real Glass build with synthetic data (scripts/demo-data.ts):
 *
 *   site/public/img/*.webp     dashboard screenshots, light and dark
 *   site/public/img/og.png     the social preview card
 *   site/public/demo/          the dashboard, answering from recorded responses
 *
 *   node scripts/site-assets.ts            # everything
 *   node scripts/site-assets.ts --shots    # screenshots only
 *   node scripts/site-assets.ts --demo     # demo only
 *
 * Needs Node >= 22.18 and Playwright's Chromium (`npx playwright install chromium`).
 * Nothing here talks to Cloudflare.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium, type Page } from 'playwright';
import { fixtureName } from '../packages/dashboard/src/demo.ts';
import { createStore } from '../packages/worker/src/app.ts';
import { runMaintenance } from '../packages/worker/src/cron.ts';
import { startDevServer } from '../packages/worker/test/server.ts';
import { seedDemo } from './demo-data.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'site', 'public');
const args = new Set(process.argv.slice(2));
const all = !args.has('--shots') && !args.has('--demo');

execFileSync(process.execPath, [join(root, 'scripts', 'build.ts')], { stdio: 'inherit' });

const server = await startDevServer({ memory: true, port: 0, demoPort: 0 });
const G = server.glassUrl;
console.log('seeding…', await seedDemo(server));

// The example site is served as a public-looking host but loads Glass from 127.0.0.1,
// which Chrome's private/local network checks would block. Local and synthetic only.
const browser = await chromium.launch({
  args: [
    '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks',
  ],
});

// ── Real replays: sessions on the example site, styled like a product ─────────
const APP_CSS = `
  :root { color-scheme: light; }
  body { font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #1d2a26; max-width: none; margin: 0; padding: 0; background: #fbfaf7; }
  nav { display: flex; gap: 22px; align-items: center; padding: 16px 40px; border-bottom: 1px solid #e7e3da; background: #fff; }
  nav::before { content: 'Inkwell'; font-weight: 700; margin-right: auto; letter-spacing: -0.01em; }
  nav a { color: #4a5a54; text-decoration: none; margin: 0; }
  h1 { font-size: 40px; letter-spacing: -0.02em; margin: 56px 40px 12px; }
  p, form, ol { margin-left: 40px; margin-right: 40px; max-width: 640px; }
  button, .cta a { background: #1d2a26; color: #fff; border: 0; border-radius: 10px; padding: 10px 18px; font: inherit; cursor: pointer; }
  input { border: 1px solid #d6d1c6; border-radius: 10px; padding: 10px 14px; font: inherit; min-width: 260px; }
  li { padding: 6px 0; border-bottom: 1px solid #efebe3; }
`;

const DESKTOP = {
  viewport: { width: 1280, height: 800 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};
const PHONE = {
  viewport: { width: 390, height: 844 },
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  isMobile: true,
  hasTouch: true,
};
/** The example site, served as http://inkwell.example so recordings show a real-looking URL. */
const INKWELL = 'http://inkwell.example';

/** One visitor: a fresh browser, so every run is its own session. */
async function session(
  options: typeof DESKTOP | typeof PHONE,
  steps: (page: Page) => Promise<void>,
): Promise<void> {
  const ctx = await browser.newContext(options);
  await ctx.route(`${INKWELL}/**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: server.demoUrl + url.pathname + url.search });
    await route.fulfill({ response });
  });
  await ctx.addInitScript((css) => {
    addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    });
  }, APP_CSS);
  const page = await ctx.newPage();
  page.on('pageerror', () => undefined);
  await steps(page);
  await page.waitForTimeout(2000);
  await ctx.close();
}

async function recordReplays(): Promise<void> {
  await Promise.all([
    // Signs up, then hits the broken upgrade button: an error click, a failed request, rage clicks.
    session(DESKTOP, async (page) => {
      await page.goto(`${INKWELL}/`);
      await page.waitForTimeout(3000);
      await page.click('text=See pricing');
      await page.waitForTimeout(4000);
      await page.click('text=Choose Team');
      await page.waitForTimeout(2000);
      await page.type('#email', 'maya@example.com', { delay: 90 });
      await page.waitForTimeout(800);
      await page.click('button[type=submit]');
      await page.waitForURL('**/app');
      await page.waitForTimeout(3000);
      await page.click('#pay');
      await page.waitForTimeout(2000);
      for (let i = 0; i < 5; i++) {
        await page.click('#pay');
        await page.waitForTimeout(160);
      }
      await page.waitForTimeout(6000);
    }),
    // Reads the changelog on a phone.
    session(PHONE, async (page) => {
      await page.goto(`${INKWELL}/`);
      await page.waitForTimeout(2500);
      await page.goto(`${INKWELL}/changelog`);
      for (let i = 0; i < 10; i++) {
        await page.mouse.wheel(0, 500);
        await page.waitForTimeout(900);
      }
      await page.goto(`${INKWELL}/pricing`);
      await page.waitForTimeout(4000);
    }),
    // Compares plans, signs up for free.
    session(DESKTOP, async (page) => {
      await page.goto(`${INKWELL}/pricing`);
      await page.waitForTimeout(4000);
      await page.hover('text=Choose Team');
      await page.waitForTimeout(1500);
      await page.click('text=Choose Free');
      await page.waitForTimeout(2500);
      await page.type('#email', 'sam@example.com', { delay: 110 });
      await page.click('button[type=submit]');
      await page.waitForURL('**/app');
      await page.waitForTimeout(5000);
    }),
  ]);
  // Summarise the sessions as the hourly cron would once they've settled.
  for (let i = 0; i < 3; i++)
    await runMaintenance(server.env, createStore(server.env), Date.now() + 2 * 3_600_000);
}
await recordReplays();

const H = { Authorization: 'Bearer dev-admin-key' };
const replays = (await (await fetch(`${G}/api/replays?project=demo`, { headers: H })).json()) as {
  replays: { session: string; errors?: number }[];
};
const firstReplay =
  replays.replays.find((r) => (r.errors ?? 0) > 0)?.session ?? replays.replays[0]?.session;

async function dashboard(
  scheme: 'light' | 'dark',
  viewport = { width: 1440, height: 900 },
): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => {
    localStorage.setItem('glass:key', 'dev-admin-key');
    localStorage.setItem('glass:project', 'demo');
  });
  return ctx;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page
    .waitForFunction(() => !document.querySelector('[aria-busy="true"]'), undefined, {
      timeout: 8000,
    })
    .catch(() => undefined);
  await page.waitForTimeout(700);
}

/** PNG → WebP inside Chromium, so no image tools are needed. */
async function toWebp(png: Buffer, out: string): Promise<void> {
  const page = await browser.newPage();
  const dataUrl = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    return canvas.toDataURL('image/webp', 0.86);
  }, png.toString('base64'));
  await page.close();
  writeFileSync(out, Buffer.from(dataUrl.split(',')[1]!, 'base64'));
}

// ── Screenshots ──────────────────────────────────────────────────────────────
const SHOTS: {
  name: string;
  hash: string;
  dark?: boolean;
  prepare?: (page: Page) => Promise<void>;
}[] = [
  {
    name: 'web',
    hash: '#/reports?project=demo&from=-30d',
    dark: true,
    prepare: async (page) => {
      // The homepage hero: collapse the agent prompts so the chart sits high, then
      // record where the chart and the SQL switch are, so the site can lay its
      // "see-through" SQL pane exactly over them (site/public/img/web-layout.json).
      await page
        .getByRole('button', { name: 'Hide', exact: true })
        .first()
        .click()
        .catch(() => undefined);
      await page.waitForTimeout(600);
      const layout = await page.evaluate(() => {
        const vw = innerWidth;
        const vh = innerHeight;
        const pct = (el: Element | null | undefined) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const top = Math.max(0, r.top);
          const bottom = Math.min(vh, r.bottom);
          return {
            left: +((r.left / vw) * 100).toFixed(2),
            top: +((top / vh) * 100).toFixed(2),
            width: +((r.width / vw) * 100).toFixed(2),
            height: +(((bottom - top) / vh) * 100).toFixed(2),
          };
        };
        return {
          sql: pct(document.querySelector('.sql-switch')),
          chart: pct(document.querySelector('svg.chart')?.closest('.panel')),
        };
      });
      if (!layout.sql || !layout.chart)
        throw new Error('Hero layout: chart or SQL switch not found');
      writeFileSync(join(site, 'img', 'web-layout.json'), `${JSON.stringify(layout, null, 2)}\n`);
    },
  },
  { name: 'funnel', hash: '#/insights/visit-to-paid?project=demo&from=-30d', dark: true },
  { name: 'retention', hash: '#/insights/writer-retention?project=demo&from=-56d', dark: true },
  { name: 'trends', hash: '#/insights/signups-by-plan?project=demo&from=-30d' },
  { name: 'insights', hash: '#/insights?project=demo&from=-30d' },
  { name: 'people', hash: '#/users?project=demo&from=-30d' },
  { name: 'replays', hash: '#/replays?project=demo&from=-7d' },
  {
    name: 'replay',
    hash: `#/replays/${firstReplay}?project=demo&from=-7d`,
    dark: true,
    prepare: async (page) => {
      // Pause on the moment of the error rather than the first frame.
      await page.waitForTimeout(2500);
      await page
        .locator('.activity-item', { hasText: 'Upgrade now' })
        .last()
        .click()
        .catch(() => undefined);
      await page.waitForTimeout(1200);
      // Clicking a moment scrolls the activity list into view; frame the whole player again.
      await page.evaluate(() => {
        for (const el of [
          document.scrollingElement,
          ...document.querySelectorAll('main, .main, .content'),
        ])
          if (el) el.scrollTop = 0;
      });
      await page.waitForTimeout(300);
    },
  },
  { name: 'experiment', hash: '#/experiments/pricing-page-v2?project=demo&from=-30d', dark: true },
  { name: 'flags', hash: '#/flags?project=demo&from=-30d' },
  { name: 'events', hash: '#/events?project=demo&from=-30d' },
  { name: 'sql', hash: '#/sql?project=demo&from=-7d', dark: true },
  {
    name: 'show-sql',
    hash: '#/reports?project=demo&from=-30d',
    prepare: async (page) => {
      await page.keyboard.press('s');
      await page.waitForTimeout(600);
      await page.locator('.sql-pane').first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
    },
  },
];

async function screenshots(): Promise<void> {
  const out = join(site, 'img');
  mkdirSync(out, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    const ctx = await dashboard(scheme);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const shot of SHOTS) {
      if (scheme === 'dark' && !shot.dark) continue;
      await page.goto(`${G}/app${shot.hash}`);
      await settle(page);
      await shot.prepare?.(page);
      await toWebp(await page.screenshot(), join(out, `${shot.name}-${scheme}.webp`));
      console.log(`img/${shot.name}-${scheme}.webp`);
    }
    if (errors.length) throw new Error(`Dashboard errors while shooting: ${errors.join('; ')}`);
    await ctx.close();
  }
  // Phone width, for the responsive claim.
  const phone = await dashboard('light', { width: 390, height: 844 });
  const page = await phone.newPage();
  await page.goto(`${G}/app#/reports?project=demo&from=-30d`);
  await settle(page);
  await toWebp(await page.screenshot(), join(out, 'web-phone-light.webp'));
  await phone.close();

  // The social card: the product, the line and the command.
  const card = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  const shot = readFileSync(join(out, 'web-dark.webp')).toString('base64');
  await card.setContent(`<!doctype html><html><body style="margin:0;width:1200px;height:630px;overflow:hidden;background:#0d1714;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#eef5f2">
    <div style="position:absolute;inset:0;background:radial-gradient(900px 500px at 85% 10%,rgba(62,170,140,.28),transparent 60%)"></div>
    <div style="position:absolute;left:64px;top:64px;width:520px">
      <div style="display:flex;align-items:center;gap:12px;font-size:28px;font-weight:700;letter-spacing:-.01em"><span style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#7fd6bd,#2a7a67);display:inline-block"></span>Glass Analytics</div>
      <div style="margin-top:38px;font-size:54px;line-height:1.05;font-weight:700;letter-spacing:-.03em">Product analytics that lives in your Cloudflare account.</div>
      <div style="margin-top:26px;font-size:22px;color:#a9bdb5;line-height:1.4">Web analytics, funnels, session replay and A/B tests. Open source, and your agent can query it.</div>
      <div style="margin-top:34px;display:inline-block;font:22px ui-monospace,Menlo,monospace;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:14px 20px">$ npx @glassanalytics/cli init</div>
    </div>
    <img src="data:image/webp;base64,${shot}" style="position:absolute;left:640px;top:70px;width:900px;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.12)">
  </body></html>`);
  await card.waitForTimeout(300);
  await card.screenshot({ path: join(out, 'og.png') });
  await card.close();
  console.log('img/og.png');
}

// ── The demo: crawl the dashboard and keep every API response ────────────────
async function demo(): Promise<void> {
  const dir = join(site, 'demo');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  const now = Date.now();
  const ctx = await dashboard('light');
  await ctx.addInitScript(() => localStorage.setItem('glass:compare', '1'));
  const page = await ctx.newPage();
  await page.clock.setFixedTime(now);
  const saved = new Set<string>();
  await page.route(`${G}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/health') return route.continue();
    const response = await route.fetch();
    const body = await response.text();
    if (response.ok() && req.method() !== 'DELETE') {
      let json = body;
      if (url.pathname === '/health') {
        const health = JSON.parse(body) as Record<string, unknown>;
        json = JSON.stringify({ ...health, upgradeAvailable: false, latest: null });
      }
      const name = fixtureName(req.method(), url.pathname + url.search, req.postData());
      writeFileSync(join(dir, 'data', `${name}.json`), json);
      saved.add(name);
    }
    await route.fulfill({ response, body });
  });

  const start = [
    '#/reports',
    '#/reports/marketing',
    '#/reports/health',
    '#/insights',
    '#/insights/new/trends',
    '#/insights/new/funnel',
    '#/insights/new/retention',
    '#/users',
    '#/users?tab=cohorts',
    '#/replays',
    '#/flags',
    '#/experiments',
    '#/events',
    '#/sql',
    '#/settings',
  ];
  const queue: string[] = [];
  for (const from of ['-7d', '-30d', '-90d'])
    for (const s of start)
      queue.push(`${s}${s.includes('?') ? '&' : '?'}project=demo&from=${from}`);
  for (const metric of ['visitors', 'pageviews', 'sessions', 'bounce', 'duration'])
    queue.push(`#/reports?project=demo&from=-30d&metric=${metric}`);
  const seen = new Set<string>();
  const normal = (hash: string) => {
    const [path, query = ''] = hash.split('?');
    const q = new URLSearchParams(query);
    q.delete('t');
    q.sort();
    return `${path}?${q}`;
  };
  while (queue.length && seen.size < 220) {
    const hash = queue.shift()!;
    const key = normal(hash);
    if (seen.has(key)) continue;
    seen.add(key);
    await page.goto(`${G}/app${hash}`);
    await settle(page);
    // Follow links one level deeper from list pages (insights, people, replays, experiments…).
    if (!hash.includes('from=-30d')) continue;
    const links = await page.$$eval('a[href^="#/"]', (as) =>
      as.map((a) => a.getAttribute('href')!),
    );
    for (const link of links) {
      const page_ = link.split('?')[0]!;
      if (
        /^#\/(insights\/[^/]+|users\/[^/?]+|replays\/[^/?]+|experiments\/[^/?]+|flags\/[^/?]+|events\/[^/?]+)$/.test(
          page_,
        ) &&
        !page_.endsWith('/new')
      )
        queue.push(link);
    }
  }
  await ctx.close();

  // The dashboard bundle, with the clock pinned to the recording time so every
  // relative range ("last 7 days") asks for exactly what was recorded.
  const dash = join(root, 'packages', 'dashboard', 'dist');
  writeFileSync(join(dir, 'app.js'), readFileSync(join(dash, 'app.js')));
  writeFileSync(join(dir, 'app.css'), readFileSync(join(dash, 'app.css')));
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live demo · Glass Analytics</title>
<meta name="description" content="Click through a Glass Analytics dashboard with sample data: web analytics, funnels, retention, session replay, feature flags and A/B tests.">
<link rel="canonical" href="/demo/">
<meta name="glass-base" content="">
<meta name="glass-demo" content="/demo/data">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script>
(() => {
  const NOW = ${now};
  const Real = Date;
  class DemoDate extends Real {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  globalThis.Date = DemoDate;
})();
</script>
<link rel="stylesheet" href="/demo/app.css">
<script type="module" src="/demo/app.js"></script>
</head>
<body><div id="app"></div></body>
</html>
`,
  );
  console.log(`demo: ${seen.size} views, ${saved.size} recorded responses`);
}

try {
  if (all || args.has('--shots')) await screenshots();
  if (all || args.has('--demo')) await demo();
} finally {
  await browser.close();
  await server.close();
}
