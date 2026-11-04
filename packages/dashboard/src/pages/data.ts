/**
 * Events (the tracking plan) and raw SQL.
 */

import { api } from '../api.ts';
import { copyButton, empty, errorState, later, loading, pageHeader, panel, table, toast } from '../components/ui.ts';
import { h, mount } from '../dom.ts';
import { ago, count, percent } from '../format.ts';
import { type Route, href, scope } from '../state.ts';

interface EventRow {
  event: string;
  count: number;
  lastSeen: string;
  description: string;
  system: boolean;
}

interface EventDetail {
  event: string;
  sampled: number;
  lastSeen: string | null;
  description: string;
  owner: string;
  properties: { name: string; types: string[]; coverage: number; examples: string[]; description: string }[];
  summary: string;
  sql: string[];
}

function eventDetail(name: string): Node[] {
  const project = scope().project;
  return [
    later(async () => {
      const e = await api.get<EventDetail>(`/api/events/${encodeURIComponent(name)}`, { project });
      const description = h('input', {
        type: 'text',
        value: e.description,
        placeholder: 'How and when this fires, e.g. Fired when payment succeeds after checkout',
      });
      const owner = h('input', { type: 'text', value: e.owner, placeholder: 'team or person' });
      const propInputs = new Map(
        e.properties.map((p) => [
          p.name,
          h('input', {
            type: 'text',
            value: p.description,
            placeholder: 'What this property means and which values to expect',
            'aria-label': `Description of ${p.name}`,
          }),
        ]),
      );
      const form = h(
        'form',
        { class: 'stack' },
        h('label', { class: 'field' }, h('span', {}, 'Description'), description),
        h('label', { class: 'field' }, h('span', {}, 'Owner'), owner),
        h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'primary' }, 'Save description')),
      );
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        try {
          await api.put(`/api/events/${encodeURIComponent(name)}`, {
            project,
            description: description.value,
            owner: owner.value,
            properties: Object.fromEntries([...propInputs].map(([k, input]) => [k, input.value]).filter(([, v]) => v)),
          });
          toast('Saved');
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'error');
        }
      });
      return [
        pageHeader(e.event, e.summary, copyButton(`glass.capture('${e.event}', {})`, 'Copy capture code')),
        h('div', { class: 'grid-2' }, panel('Definition', form), panel('Explore', h('ul', { class: 'plain' },
          h('li', {}, h('a', { href: href('insights/trends', { spec: JSON.stringify({ series: [{ event: e.event }], interval: 'day' }) }) }, 'Trend over time')),
          h('li', {}, h('a', { href: href('insights/retention', { spec: JSON.stringify({ cohortEvent: { event: e.event }, returnEvent: { event: e.event }, period: 'week', periods: 8 }) }) }, 'Retention of people who did it')),
        ))),
        panel(
          'Properties',
          e.properties.length
            ? table(
                ['Property', 'Type', 'Present on', 'Examples', 'Meaning'],
                e.properties.map((p) => [h('code', {}, p.name), p.types.join(', '), percent(p.coverage, 0), h('span', { class: 'muted' }, p.examples.join(', ')), propInputs.get(p.name)!]),
                { numeric: [2] },
              )
            : empty('No properties sent with this event.'),
          { sql: e.sql },
        ),
      ];
    }),
  ];
}

export function eventsPage(route: Route): Node[] {
  if (route.rest[0]) return eventDetail(route.rest[0]);
  const project = scope().project;
  return [
    pageHeader(
      'Events',
      'Everything tracked in the last 30 days. Document custom events with how/when they fire and what each property means — agents need that before querying them.',
    ),
    later(async () => {
      const r = await api.get<{ events: EventRow[]; undocumented: string[] }>('/api/events', { project });
      if (r.events.length === 0) return empty('No events yet.');
      return [
        r.undocumented.length
          ? h(
              'p',
              { class: 'notice' },
              `${r.undocumented.length} custom event${r.undocumented.length === 1 ? ' has' : 's have'} no description yet. Open each and add how/when it fires plus property meanings.`,
            )
          : null,
        table(
          ['Event', 'Count', 'Last seen', 'Description'],
          r.events.map((e) => [
            h('a', { href: href(`events/${encodeURIComponent(e.event)}`) }, h('code', {}, e.event)),
            count(e.count),
            ago(e.lastSeen),
            e.system ? h('span', { class: 'muted' }, 'Built in') : e.description || h('span', { class: 'muted' }, 'No description'),
          ]),
          { numeric: [1] },
        ),
      ];
    }),
  ];
}

export function sqlPage(route: Route): Node[] {
  const project = scope().project;
  const initial =
    route.params.get('query') ??
    `SELECT event, COUNT(*) AS n\nFROM events\nWHERE project = '${project ?? 'default'}'\n  AND ts_ms >= ${Date.now() - 7 * 86_400_000}\nGROUP BY event\nORDER BY n DESC`;
  const editor = h('textarea', { class: 'sql-editor', rows: 10, spellcheck: false, 'aria-label': 'SQL query' }, initial);
  const output = h('div', {});
  const run = async () => {
    mount(output, loading('Running'));
    try {
      const r = await api.post<{ columns: string[]; rows: Record<string, unknown>[]; summary: string }>('/api/sql', { project, query: editor.value });
      mount(
        output,
        panel(
          'Rows',
          r.rows.length
            ? table(
                r.columns,
                r.rows.map((row) => r.columns.map((c) => (row[c] === null ? h('span', { class: 'muted' }, 'null') : String(row[c])))),
              )
            : empty('The query returned no rows.'),
          { actions: h('span', { class: 'muted' }, r.summary) },
        ),
      );
      // replaceState (not go()) so the shareable URL updates without a hashchange remount that would wipe these results.
      const params = new URLSearchParams(route.params);
      params.set('query', editor.value);
      history.replaceState(null, '', `#/sql?${params}`);
    } catch (err) {
      mount(output, errorState(err));
    }
  };
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run();
  });
  return [
    pageHeader('SQL', 'One read-only SELECT against your events. Timestamps are epoch milliseconds in ts_ms.'),
    panel('Query', [editor, h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'primary', onclick: () => void run() }, 'Run'), h('span', { class: 'muted small' }, 'Ctrl or ⌘ + Enter'))]),
    output,
  ];
}
