/**
 * Dashboard shell: sidebar navigation, project switcher, date range, the
 * "Show SQL" switch, the ⌘K command palette, and hash routing to pages.
 * Each page is a function from the route to DOM.
 */

import './styles.css';
import { api } from './api.ts';
import { dateRangeControl } from './components/date-range.ts';
import { type IconName, icon } from './components/icons.ts';
import { listKeys, selectMenu, toggle } from './components/menu.ts';
import { h, mount } from './dom.ts';
import { eventsPage, sqlPage } from './pages/data.ts';
import { experimentsPage } from './pages/experiments.ts';
import { flagsPage } from './pages/flags.ts';
import { insightsPage } from './pages/insights.ts';
import { peoplePage } from './pages/people.ts';
import { replaysPage } from './pages/replays.ts';
import { keyScreen, settingsPage } from './pages/settings.ts';
import { webPage } from './pages/web.ts';
import { type Route, currentRoute, go, href, prefs } from './state.ts';

interface PageDef {
  label: string;
  icon: IconName;
  render: (route: Route) => Node[];
}

const PAGES: Record<string, PageDef> = {
  reports: { label: 'Reports', icon: 'reports', render: webPage },
  // Old #/web bookmarks land on Reports.
  web: { label: 'Reports', icon: 'reports', render: webPage },
  insights: { label: 'Insights', icon: 'insights', render: insightsPage },
  users: { label: 'People', icon: 'users', render: peoplePage },
  replays: { label: 'Replays', icon: 'replay', render: replaysPage },
  flags: { label: 'Flags', icon: 'flag', render: flagsPage },
  experiments: { label: 'Experiments', icon: 'flask', render: experimentsPage },
  events: { label: 'Events', icon: 'events', render: eventsPage },
  sql: { label: 'SQL', icon: 'database', render: sqlPage },
  settings: { label: 'Settings', icon: 'settings', render: settingsPage },
};

const GROUPS: { label: string; pages: string[] }[] = [
  { label: 'Analytics', pages: ['reports', 'insights', 'users', 'replays'] },
  { label: 'Release', pages: ['flags', 'experiments'] },
  { label: 'Data', pages: ['events', 'sql'] },
];

const root = document.getElementById('app')!;
let projects: string[] = [];
let version = '';
let upgradeBanner: { version: string; latest: string; command: string } | null = null;

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

function projectMark(id: string): HTMLElement {
  return h('span', { class: 'project-mark', 'aria-hidden': 'true' }, (id[0] ?? '?').toUpperCase());
}

function projectSwitcher(route: Route): HTMLElement {
  const project = route.params.get('project') ?? prefs.project ?? projects[0] ?? '';
  if (projects.length <= 1) {
    return h('div', { class: 'project-switch static', title: project }, projectMark(project), h('span', { class: 'project-text' }, h('span', { class: 'project-kicker' }, 'Project'), h('span', { class: 'project-name' }, project)));
  }
  const trigger = selectMenu({
    value: project,
    label: 'Project',
    options: projects.map((p) => ({ value: p, label: p })),
    width: 220,
    onChange: (value) => {
      prefs.project = value;
      go(route.page, { project: value });
    },
    class: 'project-switch',
  });
  trigger.prepend(projectMark(project), h('span', { class: 'project-kicker' }, 'Project'));
  return trigger;
}

const THEMES: { value: 'system' | 'light' | 'dark'; label: string; icon: IconName }[] = [
  { value: 'system', label: 'System theme', icon: 'monitor' },
  { value: 'light', label: 'Light theme', icon: 'sun' },
  { value: 'dark', label: 'Dark theme', icon: 'moon' },
];

function navLink(key: string, route: Route): HTMLElement {
  const page = PAGES[key]!;
  const active = key === route.page || (key === 'reports' && route.page === 'web');
  return h(
    'li',
    {},
    h('a', { href: href(key), class: active ? 'active' : '', 'aria-current': active ? 'page' : null, title: page.label }, icon(page.icon, 17), h('span', { class: 'nav-label' }, page.label)),
  );
}

function sidebar(route: Route): HTMLElement {
  const theme = THEMES.find((t) => t.value === prefs.theme) ?? THEMES[0]!;
  return h(
    'nav',
    { class: 'sidebar', 'aria-label': 'Sections' },
    h(
      'div',
      { class: 'sidebar-top' },
      h('a', { class: 'brand', href: href('reports') }, h('span', { class: 'mark', 'aria-hidden': 'true' }), h('span', { class: 'brand-name' }, 'Glass')),
      h(
        'button',
        {
          type: 'button',
          class: 'icon-button collapse-button',
          'aria-label': prefs.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
          title: prefs.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
          onclick: () => {
            prefs.sidebarCollapsed = !prefs.sidebarCollapsed;
            render();
          },
        },
        icon('panel', 16),
      ),
    ),
    projectSwitcher(route),
    h(
      'button',
      { type: 'button', class: 'cmdk-trigger', onclick: () => openPalette(), title: 'Search and jump (⌘K)' },
      icon('search', 15),
      h('span', { class: 'nav-label' }, 'Search'),
      h('kbd', {}, isMac ? '⌘K' : 'Ctrl K'),
    ),
    h(
      'div',
      { class: 'nav-groups' },
      GROUPS.map((g) => h('div', { class: 'nav-group' }, h('div', { class: 'nav-group-label' }, g.label), h('ul', {}, g.pages.map((p) => navLink(p, route))))),
    ),
    h(
      'div',
      { class: 'sidebar-foot' },
      h('ul', {}, navLink('settings', route)),
      h(
        'button',
        {
          type: 'button',
          class: 'theme-button',
          title: `${theme.label} (click to change)`,
          onclick: () => {
            const i = THEMES.findIndex((t) => t.value === prefs.theme);
            prefs.theme = THEMES[(i + 1) % THEMES.length]!.value;
            render();
          },
        },
        icon(theme.icon, 16),
        h('span', { class: 'nav-label' }, theme.label),
      ),
      version ? h('div', { class: 'sidebar-version nav-label' }, `Glass ${version}`) : null,
    ),
  );
}

function crumbs(route: Route): HTMLElement {
  const page = PAGES[route.page] ?? PAGES.reports!;
  const sub = route.rest[0];
  const subLabel = sub ? (route.page === 'insights' && sub === 'new' ? 'New analysis' : route.page === 'reports' ? sub[0]!.toUpperCase() + sub.slice(1) : sub) : null;
  return h(
    'div',
    { class: 'crumbs' },
    h('span', { class: 'crumb-icon' }, icon(page.icon, 16)),
    sub ? h('a', { href: href(route.page === 'web' ? 'reports' : route.page) }, page.label) : h('span', { class: 'crumb-current' }, page.label),
    subLabel ? [icon('chevronRight', 14), h('span', { class: 'crumb-current', title: subLabel }, subLabel)] : null,
  );
}

function topBar(route: Route): HTMLElement {
  const sql = toggle({
    checked: prefs.showSql,
    label: 'SQL',
    title: 'Show the SQL behind every panel (press s)',
    class: 'sql-switch',
    onChange: (v) => {
      prefs.showSql = v;
    },
  });
  return h(
    'div',
    { class: 'topbar' },
    crumbs(route),
    h('div', { class: 'topbar-actions' }, dateRangeControl(route, render), sql),
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
    icon('zap', 16),
    h('p', {}, `Glass ${info.latest} is available (this deployment is ${info.version}). Run `, h('code', {}, info.command), ` in your project to upgrade.`),
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

// ── Command palette ─────────────────────────────────────

interface Command {
  label: string;
  group: string;
  icon: IconName;
  hint?: string;
  run: () => void;
}

function baseCommands(): Command[] {
  const pages = Object.entries(PAGES)
    .filter(([key]) => key !== 'web')
    .map(([key, p]) => ({ label: p.label, group: 'Go to', icon: p.icon, run: () => go(key) }));
  return [
    ...pages,
    { label: 'New trends analysis', group: 'Create', icon: 'lineChart', run: () => go('insights/new/trends', { spec: null }) },
    { label: 'New funnel', group: 'Create', icon: 'funnel', run: () => go('insights/new/funnel', { spec: null }) },
    { label: 'New retention analysis', group: 'Create', icon: 'retention', run: () => go('insights/new/retention', { spec: null }) },
    { label: 'New feature flag', group: 'Create', icon: 'flag', run: () => go('flags/new') },
    { label: 'New experiment', group: 'Create', icon: 'flask', run: () => go('experiments/new') },
    {
      label: prefs.showSql ? 'Hide SQL' : 'Show SQL',
      group: 'Preferences',
      icon: 'code',
      hint: 'S',
      run: () => {
        prefs.showSql = !prefs.showSql;
        render();
      },
    },
    {
      label: prefs.compare ? 'Stop comparing to previous period' : 'Compare to previous period',
      group: 'Preferences',
      icon: 'trendingUp',
      run: () => {
        prefs.compare = !prefs.compare;
        render();
      },
    },
    ...THEMES.map((t) => ({
      label: t.label,
      group: 'Preferences',
      icon: t.icon,
      run: () => {
        prefs.theme = t.value;
        render();
      },
    })),
  ];
}

let paletteOpen = false;

function openPalette(): void {
  if (paletteOpen) return;
  paletteOpen = true;
  let commands = baseCommands();
  let active = 0;
  const input = h('input', { type: 'text', class: 'palette-input', placeholder: 'Search pages, saved analyses and actions…', 'aria-label': 'Command', autocomplete: 'off', spellcheck: false });
  const list = h('div', { class: 'palette-list', role: 'listbox' });
  const overlay = h('div', { class: 'modal-overlay palette-overlay' }, h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Command palette' }, h('div', { class: 'palette-search' }, icon('search', 18), input, h('kbd', {}, 'Esc')), list));
  const close = () => {
    overlay.remove();
    paletteOpen = false;
    document.removeEventListener('keydown', onKey, true);
  };
  const matches = () => {
    const q = input.value.trim().toLowerCase();
    return q ? commands.filter((c) => `${c.label} ${c.group}`.toLowerCase().includes(q)) : commands;
  };
  const paint = () => {
    const found = matches();
    active = Math.min(active, Math.max(0, found.length - 1));
    list.replaceChildren();
    if (!found.length) {
      list.append(h('p', { class: 'palette-empty muted' }, 'No matches.'));
      return;
    }
    let group = '';
    found.forEach((c, i) => {
      if (c.group !== group) {
        group = c.group;
        list.append(h('div', { class: 'palette-group' }, group));
      }
      list.append(
        h(
          'button',
          {
            type: 'button',
            role: 'option',
            class: `menu-item ${i === active ? 'active' : ''}`,
            'aria-selected': String(i === active),
            onmousemove: () => {
              if (active !== i) {
                active = i;
                paint();
              }
            },
            onclick: () => {
              close();
              c.run();
            },
          },
          icon(c.icon, 16),
          h('span', { class: 'menu-label' }, c.label),
          c.hint ? h('kbd', {}, c.hint) : null,
        ),
      );
    });
    list.querySelector('.menu-item.active')?.scrollIntoView({ block: 'nearest' });
  };
  const onKey = (e: KeyboardEvent) => {
    const found = matches();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + found.length) % Math.max(1, found.length);
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const c = found[active];
      if (c) {
        close();
        c.run();
      }
    }
  };
  input.addEventListener('input', () => {
    active = 0;
    paint();
  });
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey, true);
  listKeys(list);
  document.body.appendChild(overlay);
  paint();
  input.focus();
  const project = currentRoute().params.get('project') ?? prefs.project ?? undefined;
  void api
    .get<{ insights: { key: string; name: string; kind: string }[] }>('/api/insights', { project })
    .then((r) => {
      if (!paletteOpen) return;
      const kindIcon: Record<string, IconName> = { trends: 'lineChart', funnel: 'funnel', retention: 'retention' };
      commands = [...commands, ...r.insights.map((i) => ({ label: i.name, group: 'Saved analyses', icon: kindIcon[i.kind] ?? 'insights', run: () => go(`insights/${i.key}`) }))];
      paint();
    })
    .catch(() => undefined);
}

// ── Render ──────────────────────────────────────────────

function render(): void {
  const route = currentRoute();
  const page = PAGES[route.page] ?? PAGES.reports!;
  const content = h('main', { class: 'content', id: 'content' });
  mount(
    root,
    h(
      'div',
      { class: `shell ${prefs.sidebarCollapsed ? 'collapsed' : ''} page-${route.page}` },
      sidebar(route),
      h('div', { class: 'main' }, upgradeNotice(), topBar(route), content),
    ),
  );
  mount(content, page.render(route));
  document.title = `${page.label} · Glass`;
}

async function start(): Promise<void> {
  prefs.showSql = prefs.showSql;
  prefs.theme = prefs.theme;
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
    version = health.version;
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
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
  if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && prefs.key) {
    e.preventDefault();
    openPalette();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/' && prefs.key) {
    e.preventDefault();
    openPalette();
  } else if (e.key === 's') {
    prefs.showSql = !prefs.showSql;
    const sqlToggle = document.querySelector<HTMLInputElement>('.sql-switch input');
    if (sqlToggle) sqlToggle.checked = prefs.showSql;
  }
});

void start();
