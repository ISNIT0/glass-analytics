/**
 * Insights: trends, funnels and retention, built from a small form.
 *
 * The spec lives in the URL (`#/insights/funnel?spec={...}`), which is also the
 * link format agents receive in every query response — so an agent's query
 * opens here exactly as it ran.
 */

import type { FunnelResult } from '@glassanalytics/core/insights/funnel';
import type { RetentionResult } from '@glassanalytics/core/insights/retention';
import type { TrendsResult } from '@glassanalytics/core/insights/trends';
import { api } from '../api.ts';
import { funnelChart, lineChart, retentionGrid } from '../components/charts.ts';
import { copyButton, empty, errorState, loading, pageHeader, panel, table, tabs } from '../components/ui.ts';
import { h, mount } from '../dom.ts';
import { count, percent } from '../format.ts';
import { type Route, go, scope } from '../state.ts';

type Kind = 'trends' | 'funnel' | 'retention';
type Spec = Record<string, unknown>;

const DEFAULTS: Record<Kind, Spec> = {
  trends: { series: [{ event: '$pageview', math: 'total' }], interval: 'day' },
  funnel: { steps: [{ event: '$pageview' }, { event: '' }], window: '7d' },
  retention: { cohortEvent: { event: '$pageview' }, returnEvent: { event: '$pageview' }, period: 'week', periods: 8 },
};

let eventNames: Promise<string[]> | null = null;
function knownEvents(project?: string): Promise<string[]> {
  eventNames ??= api
    .get<{ events: { event: string }[] }>('/api/events', { project })
    .then((r) => r.events.map((e) => e.event))
    .catch(() => []);
  return eventNames;
}

function eventInput(value: string, onInput: (v: string) => void, label: string): HTMLElement {
  const input = h('input', { type: 'text', value, list: 'glass-events', placeholder: 'event name', 'aria-label': label, required: true });
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

function textInput(value: string | undefined, placeholder: string, onInput: (v: string) => void, label: string): HTMLElement {
  const input = h('input', { type: 'text', value: value ?? '', placeholder, 'aria-label': label });
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

function select(value: string, options: [string, string][], onChange: (v: string) => void, label: string): HTMLElement {
  const el = h('select', { 'aria-label': label }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function field(label: string, control: Node): HTMLElement {
  return h('label', { class: 'field' }, h('span', {}, label), control);
}

function builder(kind: Kind, spec: Spec, update: () => void): HTMLElement {
  if (kind === 'trends') {
    const series = spec.series as { event: string; math?: string; property?: string }[];
    return h(
      'div',
      { class: 'form-row' },
      series.map((s, i) =>
        h(
          'div',
          { class: 'series-row' },
          field(`Event ${series.length > 1 ? i + 1 : ''}`, eventInput(s.event, (v) => (s.event = v), 'Event')),
          field(
            'Measure',
            select(s.math ?? 'total', [
              ['total', 'Total count'],
              ['unique_persons', 'Unique people'],
              ['unique_sessions', 'Unique sessions'],
              ['sum', 'Sum of property'],
              ['avg', 'Average of property'],
            ], (v) => {
              s.math = v;
              update();
            }, 'Measure'),
          ),
          s.math === 'sum' || s.math === 'avg' ? field('Property', textInput(s.property, 'amount', (v) => (s.property = v), 'Property')) : null,
          series.length > 1 ? h('button', { type: 'button', class: 'ghost small', onclick: () => { series.splice(i, 1); update(); } }, 'Remove') : null,
        ),
      ),
      h('button', { type: 'button', class: 'ghost small', onclick: () => { series.push({ event: '', math: 'total' }); update(); } }, 'Add series'),
      field('Interval', select(String(spec.interval ?? 'day'), [['hour', 'Hour'], ['day', 'Day'], ['week', 'Week'], ['month', 'Month']], (v) => (spec.interval = v), 'Interval')),
      field('Break down by', textInput(spec.breakdown as string, 'browser, utm_source, person.plan', (v) => (spec.breakdown = v || undefined), 'Breakdown')),
    );
  }
  if (kind === 'funnel') {
    const steps = spec.steps as { event: string }[];
    return h(
      'div',
      { class: 'form-row' },
      h(
        'ol',
        { class: 'steps-editor' },
        steps.map((step, i) =>
          h(
            'li',
            {},
            eventInput(step.event, (v) => (step.event = v), `Step ${i + 1}`),
            steps.length > 2 ? h('button', { type: 'button', class: 'ghost small', onclick: () => { steps.splice(i, 1); update(); } }, 'Remove') : null,
          ),
        ),
      ),
      h('button', { type: 'button', class: 'ghost small', onclick: () => { steps.push({ event: '' }); update(); } }, 'Add step'),
      field('Within', textInput(String(spec.window ?? '7d'), '7d', (v) => (spec.window = v), 'Conversion window')),
      field('Break down by', textInput(spec.breakdown as string, 'utm_source', (v) => (spec.breakdown = v || undefined), 'Breakdown')),
    );
  }
  const cohort = spec.cohortEvent as { event: string };
  const ret = spec.returnEvent as { event: string };
  return h(
    'div',
    { class: 'form-row' },
    field('First did', eventInput(cohort.event, (v) => (cohort.event = v), 'Cohort event')),
    field('Came back and did', eventInput(ret.event, (v) => (ret.event = v), 'Return event')),
    field('Period', select(String(spec.period ?? 'week'), [['day', 'Day'], ['week', 'Week'], ['month', 'Month']], (v) => (spec.period = v), 'Period')),
    field('Periods', textInput(String(spec.periods ?? 8), '8', (v) => (spec.periods = Number(v) || 8), 'Number of periods')),
  );
}

function resultView(kind: Kind, result: Record<string, unknown>): HTMLElement {
  if (kind === 'trends') {
    const r = result as unknown as TrendsResult;
    return h(
      'div',
      {},
      lineChart(r.buckets, r.series.map((s) => ({ label: s.label, values: s.values })), r.interval),
      table(['Series', 'Total'], r.series.map((s) => [s.label, count(s.total)]), { numeric: [1] }),
    );
  }
  if (kind === 'funnel') {
    const r = result as unknown as FunnelResult;
    if (!r.steps[0]?.count) return empty('No one did the first step in this period.');
    return h(
      'div',
      {},
      funnelChart(r.steps),
      r.breakdowns
        ? table(
            ['Value', ...r.steps.map((s) => s.label), 'Conversion'],
            r.breakdowns.map((b) => [b.value, ...b.steps.map((s) => count(s.count)), percent(b.steps[b.steps.length - 1]!.conversionFromStart)]),
            { numeric: r.steps.map((_, i) => i + 1).concat(r.steps.length + 1) },
          )
        : null,
    );
  }
  const r = result as unknown as RetentionResult;
  return r.cohorts.length ? retentionGrid(r.cohorts, r.average, r.period) : empty('No one in any cohort for this period.');
}

export function insightsPage(route: Route): Node[] {
  const kind = (['trends', 'funnel', 'retention'].includes(route.rest[0] ?? '') ? route.rest[0] : 'trends') as Kind;
  let spec: Spec;
  try {
    spec = route.params.get('spec') ? (JSON.parse(route.params.get('spec')!) as Spec) : structuredClone(DEFAULTS[kind]);
  } catch {
    spec = structuredClone(DEFAULTS[kind]);
  }
  const sc = scope();
  const form = h('form', { class: 'builder' });
  const output = h('div', { class: 'insight-output' });
  const datalist = h('datalist', { id: 'glass-events' });
  knownEvents(sc.project).then((names) => mount(datalist, names.map((n) => h('option', { value: n }))));

  const fullSpec = () => ({ kind, ...spec, from: spec.from ?? sc.from, to: spec.to ?? sc.to, project: sc.project });

  const renderForm = () =>
    mount(
      form,
      builder(kind, spec, renderForm),
      h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'primary' }, 'Run query')),
    );

  const run = async () => {
    mount(output, loading('Running query'));
    try {
      const body = fullSpec();
      const result = await api.post<Record<string, unknown> & { summary: string; sql: string[]; dashboard: string }>('/api/query', body);
      const { kind: _k, project: _p, ...shareable } = body;
      const prompt = `Using the Glass MCP tool query_${kind}, run ${JSON.stringify(shareable)} and explain what it shows.`;
      mount(
        output,
        panel('Result', [h('p', { class: 'summary' }, result.summary), resultView(kind, result)], {
          sql: result.sql,
          actions: [copyButton(prompt, 'Copy as agent prompt'), copyButton(() => location.href, 'Copy link')],
        }),
      );
      history.replaceState(null, '', `#/insights/${kind}?${new URLSearchParams({ ...Object.fromEntries(route.params), spec: JSON.stringify(spec) })}`);
    } catch (err) {
      mount(output, errorState(err));
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void run();
  });
  renderForm();
  const ready = kind === 'funnel' ? (spec.steps as { event: string }[]).every((s) => s.event) : true;
  if (ready) void run();
  else mount(output, empty('Pick the events for each step, then run the query.'));

  return [
    pageHeader('Insights', 'Trends, funnels and retention over any event.'),
    tabs(
      [
        { value: 'trends', label: 'Trends' },
        { value: 'funnel', label: 'Funnel' },
        { value: 'retention', label: 'Retention' },
      ],
      kind,
      (k) => go(`insights/${k}`, { spec: null }),
    ),
    datalist,
    form,
    output,
  ];
}
