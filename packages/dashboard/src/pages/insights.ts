/**
 * Insights: saved analyses (list), create flow, and ephemeral agent links.
 *
 * Routes:
 *   #/insights                  — library of saved analyses
 *   #/insights/new[/:kind]      — create (builder behind "Create new")
 *   #/insights/:kind?spec=…     — ephemeral run (agent / share links)
 *   #/insights/:key             — open a saved analysis
 */

import type { FunnelResult } from '@glassanalytics/core/insights/funnel';
import type { RetentionResult } from '@glassanalytics/core/insights/retention';
import type { TrendsResult } from '@glassanalytics/core/insights/trends';
import { api } from '../api.ts';
import { funnelChart, lineChart, retentionGrid } from '../components/charts.ts';
import { type FilterRow, cleanFilters, filterEditor } from '../components/filter-editor.ts';
import { eventPicker, propertyPicker } from '../components/picker.ts';
import { copyButton, empty, errorState, later, loading, pageHeader, panel, table, tabs, toast } from '../components/ui.ts';
import { h, mount } from '../dom.ts';
import { count, percent } from '../format.ts';
import { type Route, go, href, scope } from '../state.ts';

type Kind = 'trends' | 'funnel' | 'retention';
type Spec = Record<string, unknown>;

const KINDS: Kind[] = ['trends', 'funnel', 'retention'];
const KIND_LABEL: Record<Kind, string> = { trends: 'Trends', funnel: 'Funnel', retention: 'Retention' };

const DEFAULTS: Record<Kind, Spec> = {
  trends: { series: [{ event: '$pageview', math: 'total' }], interval: 'day' },
  funnel: { steps: [{ event: '$pageview' }, { event: '' }], window: '7d' },
  retention: { cohortEvent: { event: '$pageview' }, returnEvent: { event: '$pageview' }, period: 'week', periods: 8 },
};

interface SavedInsight {
  key: string;
  name: string;
  description: string;
  kind: Kind;
  spec: Spec;
  updatedAt: string;
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

type SeriesSpec = { event: string; math?: string; property?: string; filters?: FilterRow[]; label?: string };
type StepSpec = { event: string; filters?: FilterRow[]; label?: string };

function readBreakdowns(spec: Spec): string[] {
  const b = spec.breakdown;
  if (Array.isArray(b)) return b.filter((x): x is string => typeof x === 'string');
  if (typeof b === 'string' && b) return [b];
  return [];
}

function writeBreakdowns(spec: Spec, values: string[]): void {
  if (values.length === 0) delete spec.breakdown;
  else spec.breakdown = values;
}

function ensureFilters(target: { filters?: FilterRow[] }): FilterRow[] {
  target.filters ??= [];
  return target.filters;
}

function breakdownEditor(spec: Spec, event: string | undefined, project: string | undefined, update: () => void): HTMLElement {
  const values = readBreakdowns(spec);
  return h(
    'div',
    { class: 'breakdown-editor' },
    h('div', { class: 'filter-editor-label' }, 'Break down by'),
    values.map((value, i) =>
      h(
        'div',
        { class: 'breakdown-row' },
        propertyPicker({
          value,
          event,
          project,
          placeholder: i === 0 ? 'browser, utm_source, plan…' : 'Add another property',
          onChange: (v) => {
            const next = readBreakdowns(spec);
            if (v) next[i] = v;
            else next.splice(i, 1);
            writeBreakdowns(spec, next);
            update();
          },
        }),
        h(
          'button',
          {
            type: 'button',
            class: 'ghost small',
            'aria-label': 'Remove breakdown',
            onclick: () => {
              const next = readBreakdowns(spec);
              next.splice(i, 1);
              writeBreakdowns(spec, next);
              update();
            },
          },
          'Remove',
        ),
      ),
    ),
    values.length < 4
      ? h(
          'button',
          {
            type: 'button',
            class: 'ghost small',
            onclick: () => {
              writeBreakdowns(spec, [...readBreakdowns(spec), '']);
              update();
            },
          },
          values.length ? 'Add breakdown' : 'Add breakdown',
        )
      : null,
    values.length > 1 ? h('p', { class: 'muted small' }, 'Values are combined with “ · ”, e.g. Chrome · google.') : null,
  );
}

function sanitizeSpec(kind: Kind, spec: Spec): Spec {
  const out = structuredClone(spec) as Spec;
  const global = cleanFilters(out.filters as FilterRow[] | undefined);
  if (global) out.filters = global;
  else delete out.filters;

  if (kind === 'trends') {
    const series = (out.series as SeriesSpec[]).map((s) => {
      const filters = cleanFilters(s.filters);
      const next = { ...s };
      if (filters) next.filters = filters;
      else delete next.filters;
      return next;
    });
    out.series = series;
  }
  if (kind === 'funnel') {
    out.steps = (out.steps as StepSpec[]).map((s) => {
      const filters = cleanFilters(s.filters);
      const next = { ...s };
      if (filters) next.filters = filters;
      else delete next.filters;
      return next;
    });
  }
  if (kind === 'retention') {
    for (const key of ['cohortEvent', 'returnEvent'] as const) {
      const step = out[key] as StepSpec | undefined;
      if (!step) continue;
      const filters = cleanFilters(step.filters);
      if (filters) step.filters = filters;
      else delete step.filters;
    }
  }
  const breakdowns = readBreakdowns(out).map((v) => v.trim()).filter(Boolean);
  if (breakdowns.length) out.breakdown = breakdowns;
  else delete out.breakdown;
  return out;
}

function builder(kind: Kind, spec: Spec, update: () => void, project?: string): HTMLElement {
  if (!Array.isArray(spec.filters)) spec.filters = [];

  if (kind === 'trends') {
    const series = spec.series as SeriesSpec[];
    return h(
      'div',
      { class: 'builder-stack' },
      series.map((s, i) => {
        ensureFilters(s);
        return h(
          'div',
          { class: 'series-block' },
          h(
            'div',
            { class: 'series-row' },
            field(
              `Event ${series.length > 1 ? i + 1 : ''}`,
              eventPicker({
                value: s.event,
                project,
                label: 'Event',
                onChange: (v) => {
                  s.event = v;
                  update();
                },
              }),
            ),
            field(
              'Measure',
              select(
                s.math ?? 'total',
                [
                  ['total', 'Total count'],
                  ['unique_persons', 'Unique people'],
                  ['unique_sessions', 'Unique sessions'],
                  ['sum', 'Sum of property'],
                  ['avg', 'Average of property'],
                ],
                (v) => {
                  s.math = v;
                  update();
                },
                'Measure',
              ),
            ),
            s.math === 'sum' || s.math === 'avg'
              ? field(
                  'Property',
                  propertyPicker({
                    value: s.property ?? '',
                    event: s.event,
                    project,
                    columns: false,
                    placeholder: 'Select a property to aggregate',
                    onChange: (v) => {
                      s.property = v;
                      update();
                    },
                  }),
                )
              : null,
            series.length > 1
              ? h('button', { type: 'button', class: 'ghost small', onclick: () => { series.splice(i, 1); update(); } }, 'Remove series')
              : null,
          ),
          filterEditor(s.filters!, update, { event: s.event, project, label: 'Series filters', cohorts: true }),
        );
      }),
      h('button', { type: 'button', class: 'ghost small', onclick: () => { series.push({ event: '', math: 'total', filters: [] }); update(); } }, 'Add series'),
      field('Interval', select(String(spec.interval ?? 'day'), [['hour', 'Hour'], ['day', 'Day'], ['week', 'Week'], ['month', 'Month']], (v) => (spec.interval = v), 'Interval')),
      breakdownEditor(spec, series[0]?.event, project, update),
      filterEditor(spec.filters as FilterRow[], update, { event: series[0]?.event, project, label: 'Filters on all series', cohorts: true }),
    );
  }
  if (kind === 'funnel') {
    const steps = spec.steps as StepSpec[];
    return h(
      'div',
      { class: 'builder-stack' },
      h(
        'ol',
        { class: 'steps-editor' },
        steps.map((step, i) => {
          ensureFilters(step);
          return h(
            'li',
            { class: 'step-block' },
            h(
              'div',
              { class: 'step-row' },
              eventPicker({
                value: step.event,
                project,
                label: `Step ${i + 1}`,
                placeholder: `Step ${i + 1} event`,
                onChange: (v) => {
                  step.event = v;
                  update();
                },
              }),
              steps.length > 2
                ? h('button', { type: 'button', class: 'ghost small', onclick: () => { steps.splice(i, 1); update(); } }, 'Remove')
                : null,
            ),
            filterEditor(step.filters!, update, { event: step.event, project, label: `Step ${i + 1} filters`, cohorts: true }),
          );
        }),
      ),
      h('button', { type: 'button', class: 'ghost small', onclick: () => { steps.push({ event: '', filters: [] }); update(); } }, 'Add step'),
      field('Within', textInput(String(spec.window ?? '7d'), '7d', (v) => (spec.window = v), 'Conversion window')),
      breakdownEditor(spec, steps[0]?.event, project, update),
      filterEditor(spec.filters as FilterRow[], update, { event: steps[0]?.event, project, label: 'Filters on every step', cohorts: true }),
    );
  }
  const cohort = spec.cohortEvent as StepSpec;
  const ret = spec.returnEvent as StepSpec;
  ensureFilters(cohort);
  ensureFilters(ret);
  return h(
    'div',
    { class: 'builder-stack' },
    field(
      'First did',
      eventPicker({
        value: cohort.event,
        project,
        label: 'Cohort event',
        onChange: (v) => {
          cohort.event = v;
          update();
        },
      }),
    ),
    filterEditor(cohort.filters!, update, { event: cohort.event, project, label: 'First event filters', cohorts: true }),
    field(
      'Came back and did',
      eventPicker({
        value: ret.event,
        project,
        label: 'Return event',
        onChange: (v) => {
          ret.event = v;
          update();
        },
      }),
    ),
    filterEditor(ret.filters!, update, { event: ret.event, project, label: 'Return event filters', cohorts: true }),
    field('Period', select(String(spec.period ?? 'week'), [['day', 'Day'], ['week', 'Week'], ['month', 'Month']], (v) => (spec.period = v), 'Period')),
    field('Periods', textInput(String(spec.periods ?? 8), '8', (v) => (spec.periods = Number(v) || 8), 'Number of periods')),
    filterEditor(spec.filters as FilterRow[], update, { event: cohort.event, project, label: 'Filters on both events', cohorts: true }),
  );
}

function resultView(kind: Kind, result: Record<string, unknown>): HTMLElement {
  if (kind === 'trends') {
    const r = result as unknown as TrendsResult;
    const primary = r.series[0];
    return h(
      'div',
      { class: 'insight-result' },
      primary
        ? h(
            'div',
            { class: 'funnel-kpis trends-kpis' },
            h(
              'div',
              { class: 'funnel-kpi' },
              h('div', { class: 'funnel-kpi-value' }, count(primary.total)),
              h('div', { class: 'funnel-kpi-label' }, primary.label),
              h('div', { class: 'funnel-kpi-hint muted' }, `by ${r.interval}`),
            ),
            r.series.length > 1
              ? h(
                  'div',
                  { class: 'funnel-kpi' },
                  h('div', { class: 'funnel-kpi-value' }, String(r.series.length)),
                  h('div', { class: 'funnel-kpi-label' }, 'Series'),
                )
              : null,
          )
        : null,
      lineChart(
        r.buckets,
        r.series.map((s) => ({ label: s.label, values: s.values })),
        r.interval,
      ),
      r.series.length > 1 ? table(['Series', 'Total'], r.series.map((s) => [s.label, count(s.total)]), { numeric: [1] }) : null,
    );
  }
  if (kind === 'funnel') {
    const r = result as unknown as FunnelResult;
    if (!r.steps[0]?.count) return empty('No one did the first step in this period.');
    return funnelChart(r.steps, { windowSeconds: r.windowSeconds, breakdowns: r.breakdowns });
  }
  const r = result as unknown as RetentionResult;
  if (!r.cohorts.length) return empty('No one in any cohort for this period.');
  const day0 = r.average[0] ?? 0;
  const end = r.average[r.average.length - 1] ?? 0;
  return h(
    'div',
    { class: 'insight-result' },
    h(
      'div',
      { class: 'funnel-kpis' },
      h(
        'div',
        { class: 'funnel-kpi' },
        h('div', { class: 'funnel-kpi-value' }, percent(end, 0)),
        h('div', { class: 'funnel-kpi-label' }, `Retained (${r.period} ${r.average.length - 1})`),
        h('div', { class: 'funnel-kpi-hint muted' }, `${percent(day0, 0)} on day/period 0`),
      ),
      h(
        'div',
        { class: 'funnel-kpi' },
        h('div', { class: 'funnel-kpi-value' }, count(r.cohorts.reduce((n, c) => n + c.size, 0))),
        h('div', { class: 'funnel-kpi-label' }, 'People in cohorts'),
        h('div', { class: 'funnel-kpi-hint muted' }, `${r.cohorts.length} cohorts`),
      ),
    ),
    retentionGrid(r.cohorts, r.average, r.period),
  );
}

function listView(): Node[] {
  const project = scope().project;
  return [
    pageHeader(
      'Insights',
      'Saved analyses you and your agents can reopen. New projects start with DAU, WAU, retention and a few other defaults.',
      h('a', { class: 'button primary', href: href('insights/new') }, 'Create new'),
    ),
    later(async () => {
      const r = await api.get<{ insights: SavedInsight[] }>('/api/insights', { project });
      if (r.insights.length === 0) {
        return empty('No saved analyses yet.', h('a', { class: 'button primary', href: href('insights/new') }, 'Create new'));
      }
      return h(
        'div',
        { class: 'insight-library' },
        r.insights.map((insight) =>
          h(
            'a',
            { class: 'insight-card', href: href(`insights/${insight.key}`) },
            h('div', { class: 'insight-card-head' }, h('h2', {}, insight.name), h('span', { class: 'badge' }, KIND_LABEL[insight.kind])),
            insight.description ? h('p', { class: 'muted' }, insight.description) : h('p', { class: 'muted' }, 'No description'),
          ),
        ),
      );
    }),
  ];
}

function editorView(options: {
  mode: 'new' | 'saved' | 'ephemeral';
  kind: Kind;
  key?: string;
  name?: string;
  description?: string;
  spec: Spec;
  route: Route;
}): Node[] {
  let kind = options.kind;
  let spec = structuredClone(options.spec);
  const sc = scope();
  const form = h('form', { class: 'builder' });
  const output = h('div', { class: 'insight-output' });

  const titleInput = h('input', {
    type: 'text',
    value: options.name ?? '',
    placeholder: 'Title, e.g. Daily active users',
    'aria-label': 'Analysis title',
    required: true,
  });
  const descriptionInput = h('textarea', {
    rows: 2,
    placeholder: 'What question does this answer?',
    'aria-label': 'Description',
  }, options.description ?? '');

  const fullSpec = () => {
    const cleaned = sanitizeSpec(kind, spec);
    return { kind, ...cleaned, from: cleaned.from ?? sc.from, to: cleaned.to ?? sc.to, project: sc.project };
  };

  const renderForm = () =>
    mount(
      form,
      builder(kind, spec, renderForm, sc.project),
      h(
        'div',
        { class: 'form-actions' },
        h('button', { type: 'submit', class: 'primary' }, 'Run query'),
        options.mode === 'saved'
          ? h(
              'button',
              {
                type: 'button',
                class: 'ghost',
                onclick: () => {
                  if (!confirm('Delete this saved analysis?')) return;
                  void api.delete(`/api/insights/${encodeURIComponent(options.key!)}`, { project: sc.project }).then(() => {
                    toast('Deleted');
                    go('insights');
                  });
                },
              },
              'Delete',
            )
          : null,
        h('a', { class: 'button ghost', href: href('insights') }, 'Back to library'),
      ),
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
        panel(
          'Result',
          [h('p', { class: 'summary muted' }, result.summary), resultView(kind, result)],
          {
            sql: result.sql,
            actions: [copyButton(prompt, 'Copy as agent prompt'), copyButton(() => location.href, 'Copy link')],
          },
        ),
      );
      if (options.mode === 'ephemeral' || options.mode === 'new') {
        const params = new URLSearchParams(Object.fromEntries(options.route.params));
        params.set('spec', JSON.stringify(spec));
        const path = options.mode === 'new' ? `insights/new/${kind}` : `insights/${kind}`;
        history.replaceState(null, '', `#/${path}?${params}`);
      }
    } catch (err) {
      mount(output, errorState(err));
    }
  };

  const savePanel = panel(
    options.mode === 'saved' ? 'Save changes' : 'Save analysis',
    h(
      'form',
      { class: 'stack save-insight' },
      field('Title', titleInput),
      field('Description', descriptionInput),
      h(
        'div',
        { class: 'form-actions' },
        h('button', { type: 'submit', class: 'primary' }, options.mode === 'saved' ? 'Update' : 'Save to library'),
      ),
    ),
  );
  savePanel.querySelector('form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      if (!titleInput.value.trim()) {
        toast('Add a title', 'error');
        return;
      }
      try {
        const saved = await api.post<{ key: string }>('/api/insights', {
          project: sc.project,
          key: options.mode === 'saved' ? options.key : undefined,
          name: titleInput.value.trim(),
          description: descriptionInput.value.trim(),
          kind,
          spec: sanitizeSpec(kind, spec),
        });
        toast(options.mode === 'saved' ? 'Updated' : 'Saved');
        go(`insights/${saved.key}`);
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    })();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void run();
  });
  renderForm();
  const ready = kind === 'funnel' ? (spec.steps as { event: string }[]).every((s) => s.event) : true;
  if (ready) void run();
  else mount(output, empty('Pick the events for each step, then run the query.'));

  const title =
    options.mode === 'new' ? 'New analysis' : options.mode === 'saved' ? (options.name ?? 'Analysis') : `${KIND_LABEL[kind]} query`;
  const blurb =
    options.mode === 'new'
      ? 'Build a trends, funnel or retention chart, then save it to the library.'
      : options.description || 'Run, tweak, and save.';

  return [
    pageHeader(title, blurb),
    options.mode === 'new' || options.mode === 'ephemeral'
      ? tabs(
          KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })),
          kind,
          (next) => {
            if (options.mode === 'new') go(`insights/new/${next}`, { spec: null });
            else go(`insights/${next}`, { spec: null });
          },
        )
      : h('p', { class: 'muted' }, KIND_LABEL[kind]),
    form,
    savePanel,
    output,
  ];
}

export function insightsPage(route: Route): Node[] {
  const head = route.rest[0];
  if (!head) return listView();

  if (head === 'new') {
    const kind = (KINDS.includes(route.rest[1] as Kind) ? route.rest[1] : 'trends') as Kind;
    let spec: Spec;
    try {
      spec = route.params.get('spec') ? (JSON.parse(route.params.get('spec')!) as Spec) : structuredClone(DEFAULTS[kind]);
    } catch {
      spec = structuredClone(DEFAULTS[kind]);
    }
    return editorView({ mode: 'new', kind, spec, route });
  }

  if (KINDS.includes(head as Kind)) {
    const kind = head as Kind;
    let spec: Spec;
    try {
      spec = route.params.get('spec') ? (JSON.parse(route.params.get('spec')!) as Spec) : structuredClone(DEFAULTS[kind]);
    } catch {
      spec = structuredClone(DEFAULTS[kind]);
    }
    return editorView({ mode: 'ephemeral', kind, spec, route });
  }

  return [
    later(async () => {
      const project = scope().project;
      const insight = await api.get<SavedInsight>(`/api/insights/${encodeURIComponent(head)}`, { project });
      return editorView({
        mode: 'saved',
        kind: insight.kind,
        key: insight.key,
        name: insight.name,
        description: insight.description,
        spec: insight.spec,
        route,
      });
    }),
  ];
}
