/**
 * People: identified users, anonymous device counts, and saved cohorts.
 */

import { api } from '../api.ts';
import { invalidateValues } from '../catalog.ts';
import { type FilterRow, cleanFilters, filterEditor } from '../components/filter-editor.ts';
import { eventPicker } from '../components/picker.ts';
import { icon } from '../components/icons.ts';
import { avatar, copyButton, empty, later, pageHeader, panel, table, tabs, toast } from '../components/ui.ts';
import { type Child, h, mount } from '../dom.ts';
import { ago, count, dateTime, hue, initials } from '../format.ts';
import { type Route, go, href, scope } from '../state.ts';

interface PersonSummary {
  id: string;
  properties: Record<string, unknown>;
  firstSeen: string;
  lastSeen: string;
}

interface PeopleStats {
  identified: number;
  anonymousDevices: number;
  days: number;
}

interface Cohort {
  key: string;
  name: string;
  filters: { property: string; op?: string; value?: unknown }[];
  didEvent: string | null;
  from: string | number;
  count: number;
  retention: string;
}

interface Person {
  id: string;
  identified: boolean;
  properties: Record<string, unknown>;
  firstSeen: string | null;
  lastSeen: string | null;
  devices: string[];
  recentEvents: { event: string; time: string; path: string; session: string; properties: Record<string, unknown> }[];
  replays: { session: string; started: string; errors: number; url: string }[];
  summary: string;
  sql: string[];
}

const preview = (props: Record<string, unknown>) =>
  Object.entries(props)
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');

function peopleKpis(stats: PeopleStats): HTMLElement {
  const total = stats.identified + stats.anonymousDevices;
  const share = total ? stats.identified / total : 0;
  return h(
    'dl',
    { class: 'kpis kpis-3' },
    h('div', { class: 'kpi' }, h('dt', {}, 'Identified people'), h('dd', {}, count(stats.identified)), h('div', { class: 'kpi-note muted small' }, 'Called glass.identify()')),
    h('div', { class: 'kpi' }, h('dt', {}, `Anonymous devices (${stats.days}d)`), h('dd', {}, count(stats.anonymousDevices)), h('div', { class: 'kpi-note muted small' }, 'Visited without signing in')),
    h(
      'div',
      { class: 'kpi' },
      h('dt', {}, 'Identified share'),
      h('dd', {}, total ? `${Math.round(share * 100)}%` : '–'),
      h('div', { class: 'meter', 'aria-hidden': 'true' }, h('span', { style: `width:${share * 100}%` })),
    ),
  );
}

const OP_TEXT: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  in: 'is any of',
  not_in: 'is none of',
  contains: 'contains',
  not_contains: 'does not contain',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  is_set: 'is set',
  is_not_set: 'is not set',
};

function cohortLabel(c: Cohort): string {
  const bits = [
    ...c.filters.map((f) =>
      [f.property, OP_TEXT[f.op ?? 'eq'] ?? f.op, f.value === undefined ? '' : Array.isArray(f.value) ? f.value.join(', ') : String(f.value)]
        .filter(Boolean)
        .join(' '),
    ),
    c.didEvent ? `did ${c.didEvent}` : null,
  ].filter(Boolean);
  return bits.length ? bits.join(', ') : 'everyone with events';
}

function cohortsPanel(project: string | undefined): HTMLElement {
  const body = h('div', {});
  const name = h('input', { type: 'text', placeholder: 'Name, e.g. Pro plan', 'aria-label': 'Cohort name', required: true });
  let filters: FilterRow[] = [{ property: '', op: 'eq', value: '' }];
  let didEventValue = '';
  const estimate = h('p', { class: 'muted small cohort-estimate', 'aria-live': 'polite' });
  let countReq = 0;
  let countTimer: ReturnType<typeof setTimeout> | undefined;
  const recount = () => {
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      const id = ++countReq;
      const body = { project, filters: cleanFilters(filters) ?? [], didEvent: didEventValue || undefined };
      if (!body.filters.length && !body.didEvent) {
        estimate.textContent = 'Add a person property or a did-event to see how many people match.';
        return;
      }
      estimate.textContent = 'Counting…';
      void api
        .post<{ count: number }>('/api/cohorts/count', body)
        .then((r) => {
          if (id === countReq) estimate.textContent = `${count(r.count)} ${r.count === 1 ? 'person matches' : 'people match'} in the last 90 days.`;
        })
        .catch(() => {
          if (id === countReq) estimate.textContent = 'Could not count this definition yet. Check the filter values.';
        });
    }, 250);
  };
  const filtersField = h('div', { class: 'cohort-filters' });
  const paintFilters = () => mount(filtersField, filterEditor(filters, recount, { project, personOnly: true }));
  const didEventSlot = h('div', {});
  const paintDidEvent = () =>
    mount(
      didEventSlot,
      eventPicker({
        value: didEventValue,
        project,
        label: 'Did event',
        placeholder: 'Optional — people who did this event',
        onChange: (v) => {
          didEventValue = v;
          recount();
        },
      }),
    );
  paintFilters();
  paintDidEvent();
  recount();
  const form = h(
    'form',
    { class: 'cohort-form' },
    h('div', { class: 'form-row' }, h('label', { class: 'field' }, h('span', {}, 'Name'), name)),
    h('div', { class: 'field' }, h('span', {}, 'Person properties'), filtersField),
    h('div', { class: 'field' }, h('span', {}, 'Did event'), didEventSlot),
    h('div', { class: 'form-row cohort-submit' }, h('button', { type: 'submit', class: 'primary' }, 'Save cohort'), estimate),
  );

  const render = async () => {
    mount(body, h('p', { class: 'muted' }, 'Loading cohorts…'));
    try {
      const r = await api.get<{ cohorts: Cohort[] }>('/api/cohorts', { project });
      const list =
        r.cohorts.length === 0
          ? empty('Save a filter below. Counts update live, and each cohort links to its retention.', undefined, { icon: 'layers', title: 'No cohorts yet' })
          : table(
              ['Cohort', 'Definition', 'People', ''],
              r.cohorts.map((c) => [
                h('strong', {}, c.name),
                h('span', { class: 'muted' }, cohortLabel(c)),
                count(c.count),
                h(
                  'span',
                  { class: 'row-actions' },
                  h('a', { class: 'button ghost small', href: c.retention }, 'Retention'),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'ghost small',
                      onclick: async () => {
                        if (!confirm(`Delete cohort “${c.name}”?`)) return;
                        await api.delete(`/api/cohorts/${encodeURIComponent(c.key)}`, { project });
                        toast(`Deleted ${c.name}`);
                        void render();
                      },
                    },
                    'Delete',
                  ),
                ),
              ]),
              { numeric: [2] },
            );
      mount(body, list, form);
    } catch (err) {
      mount(body, h('p', { class: 'state error' }, err instanceof Error ? err.message : 'Could not load cohorts.'), form);
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      const cleaned = cleanFilters(filters) ?? [];
      if (!name.value.trim()) {
        toast('Name the cohort', 'error');
        return;
      }
      if (!cleaned.length && !didEventValue.trim()) {
        toast('Add a person property or a did-event', 'error');
        return;
      }
      try {
        await api.post('/api/cohorts', {
          project,
          name: name.value.trim(),
          filters: cleaned,
          didEvent: didEventValue.trim() || undefined,
        });
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not save the cohort', 'error');
        return;
      }
      toast('Cohort saved');
      invalidateValues('cohort');
      name.value = '';
      filters = [{ property: '', op: 'eq', value: '' }];
      didEventValue = '';
      paintFilters();
      paintDidEvent();
      recount();
      void render();
    })();
  });

  void render();
  return body;
}

/** The most common property keys, shown as their own columns. */
function topKeys(persons: PersonSummary[], limit = 3): string[] {
  const seen = new Map<string, number>();
  for (const p of persons) for (const k of Object.keys(p.properties)) seen.set(k, (seen.get(k) ?? 0) + 1);
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

const show = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** The best human label for a person: name, then email, then id. */
function personLabel(id: string, props: Record<string, unknown>): { primary: string; secondary: string | null; via: string | null } {
  const name = show(props.name);
  const email = show(props.email);
  if (name) return { primary: name, secondary: email || id, via: email ? 'email' : null };
  if (email) return { primary: email, secondary: email === id ? null : id, via: 'email' };
  return { primary: id, secondary: null, via: null };
}

function personCell(id: string, props: Record<string, unknown>): HTMLElement {
  const label = personLabel(id, props);
  return h(
    'a',
    { class: 'person-cell', href: href(`users/${encodeURIComponent(id)}`) },
    avatar(id, initials(label.primary), hue(id)),
    h('span', { class: 'person-text' }, h('span', { class: 'person-id' }, label.primary), label.secondary ? h('span', { class: 'muted small' }, label.secondary) : null),
  );
}

const PAGE_SIZE = 25;

function peopleTable(persons: PersonSummary[]): HTMLElement {
  const keys = topKeys(persons, 4).filter((k) => k !== 'name' && k !== 'email').slice(0, 3);
  const holder = h('div', {});
  let page = 0;
  const pages = Math.max(1, Math.ceil(persons.length / PAGE_SIZE));
  const paint = () => {
    const rows = persons.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    mount(
      holder,
      table(
        ['Person', ...keys, 'First seen', 'Last seen'],
        rows.map((p) => [
          personCell(p.id, p.properties),
          ...keys.map((k) => {
            const v = show(p.properties[k]);
            return v ? (k === 'plan' || k.endsWith('_plan') || k === 'role' ? h('span', { class: 'badge' }, v) : h('span', { class: 'cell-clip', title: v }, v)) : h('span', { class: 'muted' }, '–');
          }),
          h('span', { class: 'muted' }, dateTime(p.firstSeen)),
          ago(p.lastSeen),
        ]),
        { class: 'people-table' },
      ),
      pages > 1
        ? h(
            'div',
            { class: 'pager' },
            h('span', { class: 'muted small' }, `${page * PAGE_SIZE + 1}–${Math.min(persons.length, (page + 1) * PAGE_SIZE)} of ${count(persons.length)}${persons.length >= 100 ? ' most recently active' : ''}`),
            h(
              'div',
              { class: 'pager-buttons' },
              h('button', { type: 'button', class: 'ghost small', disabled: page === 0, 'aria-label': 'Previous page', onclick: () => { page--; paint(); } }, icon('chevronLeft', 14)),
              h('button', { type: 'button', class: 'ghost small', disabled: page >= pages - 1, 'aria-label': 'Next page', onclick: () => { page++; paint(); } }, icon('chevronRight', 14)),
            ),
          )
        : null,
    );
  };
  paint();
  return holder;
}

function list(route: Route): Node[] {
  const tab = route.params.get('tab') === 'cohorts' ? 'cohorts' : 'people';
  const q = route.params.get('q') ?? '';
  const search = h('input', { type: 'search', value: q, placeholder: 'Search by id or property value', 'aria-label': 'Search people' });
  const form = h('form', { class: 'search-field', role: 'search' }, icon('search', 15), search);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go('users', { q: search.value });
  });
  const project = scope().project;
  const switcher = tabs(
    [
      { value: 'people', label: 'People', icon: 'users' },
      { value: 'cohorts', label: 'Cohorts', icon: 'layers' },
    ],
    tab,
    (v) => go('users', { tab: v === 'people' ? null : v }),
  );
  if (tab === 'cohorts') {
    return [
      pageHeader('People', 'Saved cohorts: reusable groups of people for filters, funnels and retention.', switcher),
      panel('Cohorts', cohortsPanel(project), { icon: 'layers', subtitle: 'Counts update live. Each cohort links to its retention.' }),
    ];
  }
  return [
    pageHeader('People', 'Identified users from glass.identify(), and how much traffic is still anonymous.', switcher),
    later(
      async () => {
        const r = await api.get<{ persons: PersonSummary[]; stats: PeopleStats; summary: string; sql?: string[] }>('/api/persons', { project, query: q, limit: 100 });
        const body: Child =
          r.persons.length === 0
            ? empty(
                q ? `No identified people match "${q}".` : 'Call glass.identify(userId) after login. Anonymous devices still count in the overview above.',
                undefined,
                { icon: 'users', title: q ? 'No matches' : 'No identified people yet' },
              )
            : peopleTable(r.persons);
        return [
          peopleKpis(r.stats),
          panel('Identified people', body, { sql: r.sql, actions: form, subtitle: r.summary, class: 'people-panel' }),
        ];
      },
      'Loading people',
      'table',
    ),
  ];
}

function detail(id: string): Node[] {
  return [
    later(async () => {
      const p = await api.get<Person>(`/api/persons/${encodeURIComponent(id)}`, { project: scope().project });
      return [
        h(
          'div',
          { class: 'person-head' },
          avatar(p.id, initials(personLabel(p.id, p.properties).primary), hue(p.id), 52),
          pageHeader(personLabel(p.id, p.properties).primary, p.summary, copyButton(p.id, 'Copy id')),
        ),
        h(
          'div',
          { class: 'grid-2' },
          panel(
            'Properties',
            Object.keys(p.properties).length
              ? h('dl', { class: 'props' }, Object.entries(p.properties).map(([k, v]) => [h('dt', {}, k), h('dd', {}, typeof v === 'object' ? JSON.stringify(v) : String(v))]))
              : empty(p.identified ? 'No properties set.' : 'Anonymous device: identify() has not been called.'),
          ),
          panel(
            'Devices and sessions',
            h(
              'div',
              {},
              h('p', { class: 'muted' }, `First seen ${p.firstSeen ? dateTime(p.firstSeen) : 'never'}, last seen ${p.lastSeen ? ago(p.lastSeen) : 'never'}.`),
              p.devices.length ? h('p', {}, `${p.devices.length} linked device${p.devices.length === 1 ? '' : 's'}.`) : null,
              p.replays.length
                ? h('ul', { class: 'plain' }, p.replays.map((r) => h('li', {}, h('a', { href: href(`replays/${r.session}`) }, dateTime(r.started)), r.errors ? h('span', { class: 'badge bad' }, `${r.errors} errors`) : null)))
                : h('p', { class: 'muted' }, 'No recorded sessions.'),
            ),
          ),
        ),
        panel(
          'Recent events',
          p.recentEvents.length
            ? table(
                ['Time', 'Event', 'Page', 'Properties'],
                p.recentEvents.map((e) => [h('span', { class: 'muted' }, dateTime(e.time)), h('span', { class: 'event-pill' }, e.event), e.path, h('span', { class: 'muted cell-clip' }, preview(e.properties))]),
              )
            : empty('No events in the last 90 days.'),
          { sql: p.sql },
        ),
      ];
    }),
  ];
}

export function peoplePage(route: Route): Node[] {
  return route.rest[0] ? detail(route.rest[0]) : list(route);
}
