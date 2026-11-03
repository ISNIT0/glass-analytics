/**
 * People: identified users, and one person's timeline.
 */

import { api } from '../api.ts';
import { copyButton, empty, later, pageHeader, panel, table } from '../components/ui.ts';
import { h } from '../dom.ts';
import { ago, dateTime } from '../format.ts';
import { type Route, go, href, scope } from '../state.ts';

interface PersonSummary {
  id: string;
  properties: Record<string, unknown>;
  firstSeen: string;
  lastSeen: string;
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

function list(route: Route): Node[] {
  const q = route.params.get('q') ?? '';
  const search = h('input', { type: 'search', value: q, placeholder: 'Search by id or property value', 'aria-label': 'Search people' });
  const form = h('form', { class: 'search', role: 'search' }, search, h('button', { type: 'submit', class: 'ghost' }, 'Search'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go('users', { q: search.value });
  });
  return [
    pageHeader('People', 'Everyone you have identified with glass.identify(), most recently active first.'),
    form,
    later(async () => {
      const r = await api.get<{ persons: PersonSummary[] }>('/api/persons', { project: scope().project, query: q, limit: 100 });
      if (r.persons.length === 0) {
        return empty(
          q ? `No one matches "${q}".` : 'No identified people yet. Call glass.identify(userId) after login to see users here.',
        );
      }
      return table(
        ['Person', 'Properties', 'Last seen'],
        r.persons.map((p) => [h('a', { href: href(`users/${encodeURIComponent(p.id)}`) }, p.id), h('span', { class: 'muted' }, preview(p.properties)), ago(p.lastSeen)]),
      );
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
