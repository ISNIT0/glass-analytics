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
  web: { label: 'Web', render: webPage },
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
    h('a', { class: 'brand', href: '#/web' }, h('span', { class: 'mark', 'aria-hidden': 'true' }), 'Glass'),
    h(
      'ul',
      {},
      Object.entries(PAGES).map(([key, page]) =>
        h('li', {}, h('a', { href: `#/${key}`, class: key === route.page ? 'active' : '', 'aria-current': key === route.page ? 'page' : null }, page.label)),
      ),
    ),
  );
}

function render(): void {
  const route = currentRoute();
  const page = PAGES[route.page] ?? PAGES.web!;
  const content = h('main', { class: 'content', id: 'content' });
  mount(root, h('div', { class: 'shell' }, sidebar(route), h('div', { class: 'main' }, topBar(route), content)));
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
    const r = await api.get<{ projects: { id: string }[] }>('/api/projects');
    projects = r.projects.map((p) => p.id);
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
