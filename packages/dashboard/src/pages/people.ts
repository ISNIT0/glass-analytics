/**
 * People: identified users, anonymous device counts, and saved cohorts.
 */

import { api } from '../api.ts';
import { invalidateValues } from '../catalog.ts';
import { type FilterRow, cleanFilters, filterEditor } from '../components/filter-editor.ts';
import { eventPicker } from '../components/picker.ts';
import { copyButton, empty, later, pageHeader, panel, table, toast } from '../components/ui.ts';
import { h, mount } from '../dom.ts';
import { ago, count, dateTime } from '../format.ts';
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
  return h(
    'dl',
    { class: 'kpis' },
    h('div', { class: 'kpi' }, h('dt', {}, 'Identified'), h('dd', {}, count(stats.identified))),
    h(
      'div',
      { class: 'kpi' },
      h('dt', {}, `Anonymous devices (${stats.days}d)`),
      h('dd', {}, count(stats.anonymousDevices)),
    ),
    h(
      'div',
      { class: 'kpi' },
      h('dt', {}, 'Identified share'),
      h(
        'dd',
        {},
        stats.identified + stats.anonymousDevices
          ? `${Math.round((stats.identified / (stats.identified + stats.anonymousDevices)) * 100)}%`
          : '–',
      ),
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
          ? empty('No cohorts yet. Save a filter below — counts update live, and each cohort links to retention.')
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

function list(route: Route): Node[] {
  const q = route.params.get('q') ?? '';
  const search = h('input', { type: 'search', value: q, placeholder: 'Search by id or property value', 'aria-label': 'Search people' });
  const form = h('form', { class: 'search', role: 'search' }, search, h('button', { type: 'submit', class: 'ghost' }, 'Search'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go('users', { q: search.value });
  });
  const project = scope().project;
  return [
    pageHeader(
      'People',
      'Identified users from glass.identify(), anonymous device volume, and saved cohorts you can reuse in insights.',
    ),
    later(async () => {
      const r = await api.get<{ persons: PersonSummary[]; stats: PeopleStats; summary: string; sql?: string[] }>(
        '/api/persons',
        { project, query: q, limit: 100 },
      );
      return [
        panel('Overview', [peopleKpis(r.stats), h('p', { class: 'summary' }, r.summary)], { sql: r.sql }),
        panel('Cohorts', cohortsPanel(project)),
        form,
        r.persons.length === 0
          ? empty(
              q
                ? `No identified people match "${q}".`
                : 'No identified people yet. Call glass.identify(userId) after login — anonymous devices still count in the overview above.',
            )
          : panel(
              'Identified people',
              table(
                ['Person', 'Properties', 'Last seen'],
                r.persons.map((p) => [
                  h('a', { href: href(`users/${encodeURIComponent(p.id)}`) }, p.id),
                  h('span', { class: 'muted' }, preview(p.properties)),
                  ago(p.lastSeen),
                ]),
              ),
            ),
      ];
    }),
  ];
}

function detail(id: string): Node[] {
  return [
    later(async () => {
      const p = await api.get<Person>(`/api/persons/${encodeURIComponent(id)}`, { project: scope().project });
      return [
        pageHeader(p.id, p.summary, copyButton(p.id, 'Copy id')),
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
                p.recentEvents.map((e) => [dateTime(e.time), h('code', {}, e.event), e.path, h('span', { class: 'muted' }, preview(e.properties))]),
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
