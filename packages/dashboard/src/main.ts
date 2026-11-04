/**
 * Dashboard shell: navigation, project and date range, the "Show SQL" switch,
 * and hash routing to pages. Each page is a function from the route to DOM.
 */

import './styles.css';
import { api } from './api.ts';
import { h, mount } from './dom.ts';
import { eventsPage, sqlPage } from './pages/data.ts';
import { experimentsPage } from './pages/experiments.ts';
import { flagsPage } from './pages/flags.ts';
import { insightsPage } from './pages/insights.ts';
import { peoplePage } from './pages/people.ts';
import { replaysPage } from './pages/replays.ts';
import { keyScreen, settingsPage } from './pages/settings.ts';
import { webPage } from './pages/web.ts';
import { type Route, currentRoute, go, prefs } from './state.ts';

const PAGES: Record<string, { label: string; render: (route: Route) => Node[] }> = {
  reports: { label: 'Reports', render: webPage },
  // Old #/web bookmarks land on Reports.
  web: { label: 'Reports', render: webPage },
  insights: { label: 'Insights', render: insightsPage },
  users: { label: 'People', render: peoplePage },
  replays: { label: 'Replays', render: replaysPage },
  flags: { label: 'Flags', render: flagsPage },
  experiments: { label: 'Experiments', render: experimentsPage },
  events: { label: 'Events', render: eventsPage },
  sql: { label: 'SQL', render: sqlPage },
  settings: { label: 'Settings', render: settingsPage },
};

const RANGES: [string, string][] = [
  ['today', 'Today'],
  ['-24h', 'Last 24 hours'],
  ['-7d', 'Last 7 days'],
  ['-30d', 'Last 30 days'],
  ['-90d', 'Last 90 days'],
  ['-12mo', 'Last 12 months'],
];

const UNITS: Record<string, [string, string]> = { m: ['minute', 'minutes'], h: ['hour', 'hours'], d: ['day', 'days'], w: ['week', 'weeks'], mo: ['month', 'months'], y: ['year', 'years'] };

/** "-1h" → "Last hour", "-14d" → "Last 14 days"; ISO dates → "Since 2026-10-01". */
function rangeLabel(from: string): string {
  const m = /^-(\d+)(mo|m|h|d|w|y)$/.exec(from);
  if (!m) return `Since ${from}`;
  const n = Number(m[1]);
  const [one, many] = UNITS[m[2]!]!;
  return n === 1 ? `Last ${one}` : `Last ${n} ${many}`;
}

const root = document.getElementById('app')!;
let projects: string[] = [];
let upgradeBanner: { version: string; latest: string; command: string } | null = null;

function topBar(route: Route): HTMLElement {
  const project = route.params.get('project') ?? prefs.project ?? projects[0] ?? '';
  const projectSelect = h('select', { 'aria-label': 'Project' }, projects.map((p) => h('option', { value: p, selected: p === project }, p)));
  projectSelect.addEventListener('change', () => {
    prefs.project = projectSelect.value;
    go(route.page, { project: projectSelect.value });
  });
  const from = route.params.get('from') ?? '-30d';
  const rangeSelect = h('select', { 'aria-label': 'Date range' }, RANGES.map(([v, l]) => h('option', { value: v, selected: v === from }, l)));
  if (!RANGES.some(([v]) => v === from)) rangeSelect.appendChild(h('option', { value: from, selected: true }, rangeLabel(from)));
  rangeSelect.addEventListener('change', () => go([route.page, ...route.rest].join('/'), { from: rangeSelect.value, to: null }));
  const sqlToggle = h('input', { type: 'checkbox', checked: prefs.showSql });
  sqlToggle.addEventListener('change', () => {
    prefs.showSql = sqlToggle.checked;
  });
  return h(
    'div',
    { class: 'topbar' },
    projects.length > 1 ? projectSelect : h('span', { class: 'project-name' }, project),
    rangeSelect,
    h('label', { class: 'switch sql-switch', title: 'Show the SQL behind every panel (press s)' }, sqlToggle, 'Show SQL'),
  );
}

function sidebar(route: Route): HTMLElement {
  return h(
    'nav',
    { class: 'sidebar', 'aria-label': 'Sections' },
    h('a', { class: 'brand', href: '#/reports' }, h('span', { class: 'mark', 'aria-hidden': 'true' }), 'Glass'),
    h(
      'ul',
      {},
      Object.entries(PAGES)
        .filter(([key]) => key !== 'web')
        .map(([key, page]) => {
          const active = key === route.page || (key === 'reports' && route.page === 'web');
          return h('li', {}, h('a', { href: `#/${key}`, class: active ? 'active' : '', 'aria-current': active ? 'page' : null }, page.label));
        }),
    ),
  );
}

function upgradeNotice(): HTMLElement | null {
  if (!upgradeBanner) return null;
  const dismissedKey = `upgrade-dismissed:${upgradeBanner.latest}`;
  try {
    if (localStorage.getItem(`glass:${dismissedKey}`) === '1') return null;
  } catch {
    // ignore
  }
  const info = upgradeBanner;
  return h(
    'div',
    { class: 'upgrade-banner', role: 'status' },
    h(
      'p',
      {},
      `Glass ${info.latest} is available (this deployment is ${info.version}). Run `,
      h('code', {}, info.command),
      ` in your project to upgrade.`,
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'ghost small',
        onclick: () => {
          try {
            localStorage.setItem(`glass:${dismissedKey}`, '1');
          } catch {
            // ignore
          }
          upgradeBanner = null;
          render();
        },
      },
      'Dismiss',
    ),
  );
}

function render(): void {
  const route = currentRoute();
  const page = PAGES[route.page] ?? PAGES.reports!;
  const content = h('main', { class: 'content', id: 'content' });
  mount(root, h('div', { class: 'shell' }, sidebar(route), h('div', { class: 'main' }, upgradeNotice(), topBar(route), content)));
  mount(content, page.render(route));
  document.title = `Glass: ${page.label}`;
}

async function start(): Promise<void> {
  prefs.showSql = prefs.showSql;
  if (!prefs.key) {
    mount(root, keyScreen(() => void start()));
    return;
  }
  try {
    const [r, health] = await Promise.all([
      api.get<{ projects: { id: string }[] }>('/api/projects'),
      api.get<{ version: string; latest?: string | null; upgradeAvailable?: boolean; upgradeCommand?: string }>('/health'),
    ]);
    projects = r.projects.map((p) => p.id);
    upgradeBanner =
      health.upgradeAvailable && health.latest
        ? { version: health.version, latest: health.latest, command: health.upgradeCommand ?? 'npx @glassanalytics/cli@latest upgrade' }
        : null;
  } catch {
    if (!prefs.key) return;
  }
  if (!currentRoute().params.get('project') && projects[0]) {
    const preferred = prefs.project && projects.includes(prefs.project) ? prefs.project : projects[0];
    go(currentRoute().page, { project: preferred });
    return;
  }
  render();
}

window.addEventListener('hashchange', () => (prefs.key ? render() : undefined));
window.addEventListener('glass:unauthorized', () => {
  prefs.key = null;
  mount(root, keyScreen(() => void start()));
});
window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (e.key === 's' && !e.metaKey && !e.ctrlKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
    prefs.showSql = !prefs.showSql;
    const toggle = document.querySelector<HTMLInputElement>('.sql-switch input');
    if (toggle) toggle.checked = prefs.showSql;
  }
});

void start();
