/**
 * Insights: saved analyses (library), and the analysis workspace — a query
 * rail on the left, the chart on the right, re-run automatically as you edit.
 *
 * Routes:
 *   #/insights                  — library of saved analyses
 *   #/insights/new[/:kind]      — create
 *   #/insights/:kind?spec=…     — ephemeral run (agent / share links)
 *   #/insights/:key             — open a saved analysis
 */

import type { FunnelResult } from '@dataflare/core/insights/funnel';
import type { RetentionResult } from '@dataflare/core/insights/retention';
import type { TrendsResult } from '@dataflare/core/insights/trends';
import { resolveRange } from '@dataflare/core/time';
import { api } from '../api.ts';
import { loadEventDetail, loadPersonProperties, loadPropertyValues } from '../catalog.ts';
import {
  type Annotation,
  barList,
  type ChartType,
  funnelChart,
  kpiStat,
  lineChart,
  periodReached,
  retentionCurve,
  retentionGrid,
  SERIES,
  sparkline,
} from '../components/charts.ts';
import { previousRange } from '../components/date-range.ts';
import { pieChart, seriesTable, worldMap } from '../components/display.ts';
import { cleanFilters, type FilterRow, filterEditor } from '../components/filter-editor.ts';
import { type IconName, icon } from '../components/icons.ts';
import {
  correlationView,
  countBySection,
  funnelOptions,
  funnelVizView,
  knownGroupTypes,
  MEASURES,
  PROPERTY_MATHS,
  retentionOptions,
  showActors,
  testAccountsToggle,
  trendsOptions,
} from '../components/insight-options.ts';
import { modal, popover, selectMenu, toggle } from '../components/menu.ts';
import { eventPicker, propertyPicker } from '../components/picker.ts';
import { INSIGHT_PROMPT } from '../components/prompts.ts';
import {
  copyButton,
  empty,
  errorState,
  iconButton,
  later,
  loading,
  pageHeader,
  panel,
  table,
  tabs,
  toast,
} from '../components/ui.ts';
import { type Child, h, mount } from '../dom.ts';
import { ago, bucketLabel, count, percent } from '../format.ts';
import { go, href, prefs, type Route, scope } from '../state.ts';

type Kind = 'trends' | 'funnel' | 'retention';
type Spec = Record<string, unknown>;

const KINDS: Kind[] = ['trends', 'funnel', 'retention'];
const KIND_LABEL: Record<Kind, string> = {
  trends: 'Trends',
  funnel: 'Funnel',
  retention: 'Retention',
};
const KIND_ICON: Record<Kind, IconName> = {
  trends: 'lineChart',
  funnel: 'funnel',
  retention: 'retention',
};
const KIND_BLURB: Record<Kind, string> = {
  trends: 'Counts, uniques or sums of any event over time.',
  funnel: 'How many people complete a sequence of steps.',
  retention: 'How many people come back after their first visit.',
};

const DEFAULTS: Record<Kind, Spec> = {
  trends: { series: [{ event: '$pageview', math: 'total' }], interval: 'day' },
  funnel: { steps: [{ event: '$pageview' }, { event: '' }], window: '7d' },
  retention: {
    cohortEvent: { event: '$pageview' },
    returnEvent: { event: '$pageview' },
    period: 'week',
    periods: 8,
  },
};

interface SavedInsight {
  key: string;
  name: string;
  description: string;
  kind: Kind;
  spec: Spec;
  updatedAt: string;
}

const letter = (i: number) => String.fromCharCode(65 + (i % 26));

function seriesTag(i: number): HTMLElement {
  return h('span', { class: 'series-tag', style: `--tag:${SERIES[i % SERIES.length]}` }, letter(i));
}

function section(title: string, ...children: Child[]): HTMLElement {
  return h('div', { class: 'rail-section' }, h('div', { class: 'rail-label' }, title), ...children);
}

function addButton(label: string, onClick: () => void): HTMLElement {
  return h(
    'button',
    { type: 'button', class: 'link-button add-button', onclick: onClick },
    icon('plus', 14),
    label,
  );
}

type SeriesSpec = {
  event: string;
  math?: string;
  property?: string;
  filters?: FilterRow[];
  label?: string;
};
type StepSpec = { event: string; filters?: FilterRow[]; label?: string; optional?: boolean };

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

/** Show `build()` once the catalog says `property` holds numbers (props.* or person.*). */
function numericOnly(
  property: string,
  event: string | undefined,
  project: string | undefined,
  build: () => HTMLElement,
): HTMLElement {
  const holder = h('div', { class: 'row' });
  const name = property.replace(/^(props|person)\./, '');
  const source = property.startsWith('person.')
    ? loadPersonProperties(project)
    : property.startsWith('props.') && event
      ? loadEventDetail(event, project).then((d) => d.properties)
      : Promise.resolve([]);
  void source.then((props) => {
    const types = props.find((p) => p.name === name)?.types ?? [];
    if (types.length && types.every((t) => t === 'number' || t === 'null')) mount(holder, build());
  });
  return holder;
}

/** Saved cohorts to compare, as toggles. */
function cohortChooser(spec: Spec, project: string | undefined, update: () => void): HTMLElement {
  const holder = h(
    'div',
    { class: 'chip-list cohort-chooser' },
    h('span', { class: 'muted small' }, 'Loading cohorts…'),
  );
  void loadPropertyValues('cohort', { project }).then((cohorts) => {
    const chosen = new Set((spec.breakdownCohorts as string[] | undefined) ?? []);
    mount(
      holder,
      cohorts.length
        ? cohorts.map((c) =>
            h(
              'button',
              {
                type: 'button',
                class: 'chip-toggle',
                'aria-pressed': String(chosen.has(c.value)),
                onclick: () => {
                  if (chosen.has(c.value)) chosen.delete(c.value);
                  else chosen.add(c.value);
                  if (chosen.size) spec.breakdownCohorts = [...chosen];
                  else delete spec.breakdownCohorts;
                  update();
                },
              },
              c.label,
            ),
          )
        : h('span', { class: 'muted small' }, 'No saved cohorts yet: make one on the People page.'),
    );
  });
  return holder;
}

function breakdownEditor(
  spec: Spec,
  event: string | undefined,
  project: string | undefined,
  update: () => void,
  kind: Kind,
): HTMLElement {
  const values = readBreakdowns(spec);
  const byCohort = values.includes('cohort');
  return h(
    'div',
    { class: 'breakdown-editor' },
    values.map((value, i) =>
      h(
        'div',
        { class: 'breakdown-row' },
        propertyPicker({
          value,
          event,
          project,
          cohorts: true,
          placeholder: i === 0 ? 'browser, utm_source, plan…' : 'Add another property',
          onChange: (v) => {
            // Cohorts are compared on their own, not combined with properties.
            let next = readBreakdowns(spec);
            if (v === 'cohort') next = ['cohort'];
            else if (v) next[i] = v;
            else next.splice(i, 1);
            writeBreakdowns(spec, next);
            if (!next.includes('cohort')) delete spec.breakdownCohorts;
            if (next.length !== 1) delete spec.breakdownBins;
            update();
          },
        }),
        iconButton('x', 'Remove breakdown', () => {
          const next = readBreakdowns(spec);
          next.splice(i, 1);
          writeBreakdowns(spec, next);
          if (!next.includes('cohort')) delete spec.breakdownCohorts;
          if (next.length !== 1) delete spec.breakdownBins;
          update();
        }),
      ),
    ),
    byCohort ? cohortChooser(spec, project, update) : null,
    values.length === 1 && values[0] && !byCohort && kind !== 'retention'
      ? numericOnly(values[0], event, project, () =>
          selectMenu({
            value: String(spec.breakdownBins ?? ''),
            label: 'Numeric ranges',
            options: [
              { value: '', label: 'One line per value' },
              { value: '5', label: 'Numbers in 5 ranges' },
              { value: '10', label: 'Numbers in 10 ranges' },
              { value: '20', label: 'Numbers in 20 ranges' },
            ],
            width: 220,
            onChange: (v) => {
              if (v) spec.breakdownBins = Number(v);
              else delete spec.breakdownBins;
              update();
            },
          }),
        )
      : null,
    values.length < 4 && !byCohort
      ? addButton(values.length ? 'Add another' : 'Add breakdown', () => {
          writeBreakdowns(spec, [...readBreakdowns(spec), '']);
          update();
        })
      : null,
    values.length > 1
      ? h('p', { class: 'muted small' }, 'Values are combined with “ · ”, e.g. Chrome · google.')
      : null,
  );
}

/** Set `key` when there is a value, or leave it out. */
function setOrDelete(out: Spec, key: string, value: unknown): void {
  if (value === undefined) delete out[key];
  else out[key] = value;
}

/** A series, step or event with its unfinished filter rows dropped. */
function withCleanFilters<T extends { filters?: FilterRow[] }>(s: T): T {
  const next = { ...s };
  const filters = cleanFilters(s.filters);
  if (filters) next.filters = filters;
  else delete next.filters;
  return next;
}

const KIND_CLEANERS: Partial<Record<Kind, (out: Spec) => void>> = {
  trends: (out) => {
    out.series = (out.series as SeriesSpec[]).map(withCleanFilters);
  },
  funnel: (out) => {
    out.steps = (out.steps as StepSpec[]).map(withCleanFilters);
    // Exclusions without an event yet are still being filled in.
    const exclusions = ((out.exclusions as { event: string }[] | undefined) ?? []).filter(
      (x) => x.event,
    );
    setOrDelete(out, 'exclusions', exclusions.length ? exclusions : undefined);
  },
  retention: (out) => {
    for (const key of ['cohortEvent', 'returnEvent'] as const) {
      const step = out[key] as StepSpec | undefined;
      if (step) out[key] = withCleanFilters(step);
    }
  },
};

function sanitizeSpec(kind: Kind, spec: Spec): Spec {
  const out = structuredClone(spec) as Spec;
  setOrDelete(out, 'filters', cleanFilters(out.filters as FilterRow[] | undefined));
  KIND_CLEANERS[kind]?.(out);
  const breakdowns = readBreakdowns(out)
    .map((v) => v.trim())
    .filter(Boolean);
  setOrDelete(out, 'breakdown', breakdowns.length ? breakdowns : undefined);
  // A map wants every country, not the top ten, however the breakdown got there.
  if (out.display === 'world_map' && breakdowns.join() === 'country') out.breakdownLimit ??= 50;
  return out;
}

const WINDOWS = ['1h', '1d', '3d', '7d', '14d', '30d', '90d'].map((w) => ({
  value: w,
  label: w
    .replace(/^(\d+)h$/, '$1 hour')
    .replace(/^1d$/, '1 day')
    .replace(/^(\d+)d$/, '$1 days'),
}));

function builder(kind: Kind, spec: Spec, update: () => void, project?: string): HTMLElement {
  if (!Array.isArray(spec.filters)) spec.filters = [];

  if (kind === 'trends') {
    const series = spec.series as SeriesSpec[];
    return h(
      'div',
      { class: 'builder-stack' },
      section(
        'Measure',
        series.map((s, i) => {
          ensureFilters(s);
          return h(
            'div',
            { class: 'query-card' },
            h(
              'div',
              { class: 'query-card-head' },
              seriesTag(i),
              eventPicker({
                value: s.event,
                project,
                label: `Event ${letter(i)}`,
                onChange: (v) => {
                  s.event = v;
                  update();
                },
              }),
              series.length > 1
                ? iconButton('x', 'Remove series', () => {
                    series.splice(i, 1);
                    update();
                  })
                : null,
            ),
            h(
              'div',
              { class: 'query-card-row' },
              selectMenu({
                value: s.math ?? 'total',
                label: 'Measure',
                options: MEASURES,
                width: 220,
                onChange: (v) => {
                  s.math = v;
                  update();
                },
              }),
              s.math === 'unique_groups'
                ? selectMenu({
                    value: String((s as { groupType?: string }).groupType ?? ''),
                    label: 'Group type',
                    options: knownGroupTypes(project, update).map((t) => ({ value: t, label: t })),
                    fallback: (s as { groupType?: string }).groupType ?? 'Pick a group type',
                    width: 180,
                    onChange: (v) => {
                      (s as { groupType?: string }).groupType = v;
                      update();
                    },
                  })
                : null,
              PROPERTY_MATHS.has(s.math ?? '')
                ? propertyPicker({
                    value: s.property ?? '',
                    event: s.event,
                    project,
                    columns: false,
                    placeholder: 'Property to aggregate',
                    onChange: (v) => {
                      s.property = v;
                      update();
                    },
                  })
                : null,
            ),
            filterEditor(s.filters!, update, { event: s.event, project, cohorts: true }),
          );
        }),
        addButton('Add series', () => {
          series.push({ event: '', math: 'total', filters: [] });
          update();
        }),
      ),
      section('Break down by', breakdownEditor(spec, series[0]?.event, project, update, kind)),
      section(
        'Filters on all series',
        filterEditor(spec.filters as FilterRow[], update, {
          event: series[0]?.event,
          project,
          cohorts: true,
        }),
        testAccountsToggle(spec, update),
      ),
      countBySection(spec, update, project),
      trendsOptions(spec, update, series.length),
    );
  }
  if (kind === 'funnel') {
    const steps = spec.steps as StepSpec[];
    const windowValue = String(spec.window ?? '7d');
    const windows = WINDOWS.some((w) => w.value === windowValue)
      ? WINDOWS
      : [...WINDOWS, { value: windowValue, label: windowValue }];
    return h(
      'div',
      { class: 'builder-stack' },
      section(
        'Steps',
        h(
          'ol',
          { class: 'steps-editor' },
          steps.map((step, i) => {
            ensureFilters(step);
            return h(
              'li',
              { class: 'query-card step-card' },
              h(
                'div',
                { class: 'query-card-head' },
                h('span', { class: 'funnel-step-index' }, String(i + 1)),
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
                  ? iconButton('x', 'Remove step', () => {
                      steps.splice(i, 1);
                      update();
                    })
                  : null,
              ),
              filterEditor(step.filters!, update, { event: step.event, project, cohorts: true }),
              // People may skip a middle step (not the first or last, and not in "any order").
              i > 0 && i < steps.length - 1 && spec.order !== 'unordered'
                ? toggle({
                    checked: Boolean(step.optional),
                    label: 'Optional step',
                    onChange: (c) => {
                      if (c) step.optional = true;
                      else delete step.optional;
                      update();
                    },
                  })
                : null,
            );
          }),
        ),
        addButton('Add step', () => {
          steps.push({ event: '', filters: [] });
          update();
        }),
      ),
      section(
        'Completed within',
        selectMenu({
          value: windowValue,
          label: 'Conversion window',
          options: windows,
          width: 200,
          onChange: (v) => {
            spec.window = v;
            update();
          },
        }),
      ),
      section('Break down by', breakdownEditor(spec, steps[0]?.event, project, update, kind)),
      section(
        'Filters on every step',
        filterEditor(spec.filters as FilterRow[], update, {
          event: steps[0]?.event,
          project,
          cohorts: true,
        }),
        testAccountsToggle(spec, update),
      ),
      funnelOptions(spec, update, steps.length, project),
      countBySection(spec, update, project),
    );
  }
  const cohort = spec.cohortEvent as StepSpec;
  const ret = spec.returnEvent as StepSpec;
  ensureFilters(cohort);
  ensureFilters(ret);
  const periods = Number(spec.periods ?? 8);
  return h(
    'div',
    { class: 'builder-stack' },
    section(
      'First did',
      h(
        'div',
        { class: 'query-card' },
        h(
          'div',
          { class: 'query-card-head' },
          seriesTag(0),
          eventPicker({
            value: cohort.event,
            project,
            anyEvent: true,
            label: 'Cohort event',
            onChange: (v) => {
              cohort.event = v;
              update();
            },
          }),
        ),
        filterEditor(cohort.filters!, update, { event: cohort.event, project, cohorts: true }),
      ),
    ),
    section(
      'Came back and did',
      h(
        'div',
        { class: 'query-card' },
        h(
          'div',
          { class: 'query-card-head' },
          seriesTag(1),
          eventPicker({
            value: ret.event,
            project,
            anyEvent: true,
            label: 'Return event',
            onChange: (v) => {
              ret.event = v;
              update();
            },
          }),
        ),
        filterEditor(ret.filters!, update, { event: ret.event, project, cohorts: true }),
      ),
    ),
    section(
      'Measured in',
      h(
        'div',
        { class: 'query-card-row' },
        tabs(
          [
            { value: 'hour', label: 'Hours' },
            { value: 'day', label: 'Days' },
            { value: 'week', label: 'Weeks' },
            { value: 'month', label: 'Months' },
          ],
          String(spec.period ?? 'week'),
          (v) => {
            spec.period = v;
            update();
          },
          'tabs-small',
        ),
        selectMenu({
          value: String(periods),
          label: 'Number of periods',
          options: [4, 6, 8, 10, 12, 16, 24].map((n) => ({
            value: String(n),
            label: `${n} periods`,
          })),
          fallback: `${periods} periods`,
          width: 160,
          onChange: (v) => {
            spec.periods = Number(v);
            update();
          },
        }),
      ),
    ),
    section(
      'Filters on both events',
      filterEditor(spec.filters as FilterRow[], update, {
        event: cohort.event,
        project,
        cohorts: true,
      }),
      testAccountsToggle(spec, update),
    ),
    section('Break down by', breakdownEditor(spec, cohort.event, project, update, kind)),
    retentionOptions(spec, update),
    countBySection(spec, update, project),
  );
}

interface RunResult extends Record<string, unknown> {
  summary: string;
  sql: string[];
}

const TIME_DISPLAYS = new Set(['line', 'area', 'bar']);

interface TrendsDisplay {
  /** line, area, bar, number, bar_value, table, pie or world_map. */
  display: string;
  spec: Spec;
  annotations: (Annotation & { id?: string })[];
  onPeople?: (series: number, label: string) => void;
  onAnnotate?: () => void;
  onDeleteNote?: (id: string) => void;
  onMapBreakdown: () => void;
}

function trendsView(r: TrendsResult, previous: TrendsResult | null, o: TrendsDisplay): HTMLElement {
  // Series, then formula lines (B / A * 100…), which come back separately.
  const lines = [...r.series, ...(r.formulas ?? [])];
  const before = previous ? [...previous.series, ...(previous.formulas ?? [])] : null;
  const stats = h(
    'div',
    { class: `stats ${o.display === 'number' ? 'stats-large' : ''}` },
    lines.map((s, i) => {
      const prior = before?.[i]?.total;
      const c = prior ? (s.total - prior) / prior : null;
      return kpiStat(
        s.label,
        count(s.total),
        c === null
          ? `by ${r.interval}`
          : h(
              'span',
              { class: `delta ${Math.abs(c) < 0.005 ? '' : c > 0 ? 'good' : 'bad'}` },
              c > 0 ? icon('arrowUp', 12) : icon('arrowDown', 12),
              `${Math.abs(c * 100).toFixed(0)}% vs previous`,
            ),
        { tag: letter(i), color: SERIES[i % SERIES.length] },
      );
    }),
  );
  if (o.display === 'number') return h('div', { class: 'insight-result' }, stats);
  const totals = lines.map((l) => ({ label: l.label, value: l.total }));
  // Tables, pies, bars and maps show every total themselves.
  const showStats = TIME_DISPLAYS.has(o.display);
  let body: Child;
  if (o.display === 'table') body = seriesTable(r.buckets, lines, r.interval);
  else if (o.display === 'pie') body = pieChart(totals);
  else if (o.display === 'bar_value') body = barList(totals, ['Series', 'Total'], { limit: 25 });
  else if (o.display === 'world_map') {
    const byCountry = readBreakdowns(o.spec).join() === 'country';
    body = byCountry
      ? worldMap(
          r.series
            .filter((x) => x.seriesIndex === 0 && x.breakdown)
            .map((x) => ({ code: x.breakdown!, value: x.total })),
        )
      : empty(
          'The map shades each country by its total, so it needs one line per country.',
          h(
            'button',
            { type: 'button', class: 'primary', onclick: o.onMapBreakdown },
            icon('globe', 15),
            'Break down by country',
          ),
          { icon: 'globe', title: 'Break down by country' },
        );
  } else {
    body = [
      lineChart(
        r.buckets,
        lines.map((s, i) => ({
          label: s.label,
          values: s.values,
          previous: before?.[i]?.values,
          trend: s.trendLine,
        })),
        r.interval,
        {
          height: 320,
          type: o.display as ChartType,
          logScale: Boolean(o.spec.logScale),
          percentStack: Boolean(o.spec.percentStack),
          showValues: Boolean(o.spec.showValues),
          annotations: o.annotations,
        },
      ),
      o.onAnnotate
        ? h(
            'div',
            { class: 'chart-notes' },
            o.annotations.map((a) =>
              h(
                'span',
                { class: 'note-chip' },
                h('span', { class: 'note-icon' }, icon('flag', 12)),
                h('span', { class: 'muted' }, bucketLabel(a.at, 'day')),
                a.text,
                a.id && o.onDeleteNote
                  ? h(
                      'button',
                      {
                        type: 'button',
                        class: 'icon-button note-remove',
                        'aria-label': `Delete note "${a.text}"`,
                        onclick: () => o.onDeleteNote?.(a.id!),
                      },
                      icon('x', 12),
                    )
                  : null,
              ),
            ),
            h(
              'button',
              { type: 'button', class: 'link-button add-button', onclick: o.onAnnotate },
              icon('plus', 13),
              'Add a note',
            ),
          )
        : null,
    ];
  }
  const rows = lines.map((s, i) => {
    const prior = before?.[i]?.total;
    return [
      h('span', { class: 'series-cell' }, seriesTag(i), s.label),
      sparkline(s.values, { color: SERIES[i % SERIES.length], height: 22 }),
      count(s.total),
      prior === undefined ? '–' : count(prior),
      prior
        ? h(
            'span',
            { class: `delta ${s.total >= prior ? 'good' : 'bad'}` },
            `${s.total >= prior ? '+' : '−'}${Math.abs(((s.total - prior) / prior) * 100).toFixed(0)}%`,
          )
        : '–',
      o.onPeople && i < r.series.length
        ? h(
            'button',
            { type: 'button', class: 'link-button', onclick: () => o.onPeople?.(i, s.label) },
            'People',
          )
        : '',
    ];
  });
  return h(
    'div',
    { class: 'insight-result' },
    showStats ? stats : null,
    body,
    TIME_DISPLAYS.has(o.display) && (lines.length > 1 || previous || o.onPeople)
      ? table(['Series', 'Trend', 'Total', 'Previous', 'Change', ''], rows, {
          numeric: [2, 3, 4],
          class: 'series-table',
        })
      : null,
  );
}

const PERIOD_ADJECTIVE: Record<string, string> = {
  hour: 'hourly',
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
};

/** What a spec counts, in the plural: people, sessions or groups of a type. */
function countedNoun(aggregateBy: unknown): string {
  if (!aggregateBy || aggregateBy === 'person') return 'people';
  if (aggregateBy === 'session') return 'sessions';
  return `${String(aggregateBy)} groups`;
}

function retentionView(
  r: RetentionResult,
  noun = 'people',
  onCell?: (cohortStart: number, k: number, breakdown?: string) => void,
): HTMLElement {
  if (!r.cohorts.length)
    return empty('No one in any cohort for this period.', undefined, { icon: 'retention' });
  const now = Date.now();
  const p = r.period[0]!.toUpperCase();
  const tables = r.breakdowns ?? [];
  const root = h('div', { class: 'insight-result' });
  let selected: string | null = null;
  const paint = () => {
    const t = (selected === null ? null : tables.find((b) => b.value === selected)) ?? r;
    let last = t.average.length - 1;
    while (last > 0 && !t.cohorts.some((c) => periodReached(c.start, last, r.period, now))) last--;
    mount(
      root,
      tables.length
        ? tabs(
            [
              { value: '', label: 'All' },
              ...tables.slice(0, 12).map((b) => ({ value: b.value, label: b.value || '(none)' })),
            ],
            selected ?? '',
            (v) => {
              selected = v || null;
              paint();
            },
            'tabs-small retention-breakdowns',
          )
        : null,
      h(
        'div',
        { class: 'stats' },
        kpiStat(
          `Retained at ${p}1`,
          t.average.length > 1 && last >= 1 ? percent(t.average[1] ?? 0, 1) : '–',
          `of ${noun} come back the next ${r.period}`,
        ),
        last > 1
          ? kpiStat(
              `Retained at ${p}${last}`,
              percent(t.average[last] ?? 0, 1),
              `latest ${r.period} any cohort has reached`,
            )
          : null,
        kpiStat(
          `${noun[0]!.toUpperCase()}${noun.slice(1)} in cohorts`,
          count(t.cohorts.reduce((n, c) => n + c.size, 0)),
          `${t.cohorts.length} ${PERIOD_ADJECTIVE[r.period] ?? r.period} cohorts`,
        ),
      ),
      t.cohorts.length
        ? [
            retentionCurve(t.cohorts, t.average, r.period, now),
            retentionGrid(
              t.cohorts,
              t.average,
              r.period,
              now,
              onCell ? (start, k) => onCell(start, k, selected ?? undefined) : undefined,
            ),
            onCell
              ? h('p', { class: 'muted small' }, 'Click a percentage to see who it counts.')
              : null,
          ]
        : empty('No one in this group’s cohorts.', undefined, { icon: 'retention' }),
    );
  };
  paint();
  return root;
}

function newMenu(label = 'New analysis'): HTMLElement {
  const trigger = h(
    'button',
    { type: 'button', class: 'primary' },
    icon('plus', 15),
    label,
    icon('chevronDown', 14),
  );
  popover(
    trigger,
    (close) =>
      h(
        'div',
        { class: 'menu new-menu' },
        KINDS.map((k) =>
          h(
            'button',
            {
              type: 'button',
              class: 'menu-item menu-item-rich',
              onclick: () => {
                close();
                go(`insights/new/${k}`, { spec: null });
              },
            },
            h('span', { class: 'menu-icon' }, icon(KIND_ICON[k], 18)),
            h(
              'span',
              { class: 'menu-rich-text' },
              h('strong', {}, KIND_LABEL[k]),
              h('span', { class: 'muted small' }, KIND_BLURB[k]),
            ),
          ),
        ),
        h('div', { class: 'menu-divider', role: 'separator' }),
        h(
          'button',
          {
            type: 'button',
            class: 'menu-item menu-item-rich agent-item',
            onclick: async (e: Event) => {
              const button = e.currentTarget as HTMLElement;
              try {
                await navigator.clipboard.writeText(INSIGHT_PROMPT);
                button.querySelector('strong')!.textContent = 'Prompt copied';
                setTimeout(close, 900);
              } catch {
                toast(
                  'Could not copy. Use "Ask your agent to build analyses" on the Insights page.',
                  'error',
                );
              }
            },
          },
          h('span', { class: 'menu-icon' }, icon('bot', 18)),
          h(
            'span',
            { class: 'menu-rich-text' },
            h('strong', {}, 'Ask your coding agent'),
            h(
              'span',
              { class: 'muted small' },
              'Copy a prompt that has your agent read the product, then build and save the funnel, retention and trends it needs.',
            ),
          ),
          icon('copy', 14),
        ),
      ),
    { width: 320, align: 'end' },
  );
  return trigger;
}

/** A small async preview for a library card. */
function cardPreview(insight: SavedInsight): HTMLElement {
  const sc = scope();
  return later(
    async () => {
      const body = {
        kind: insight.kind,
        ...insight.spec,
        from: (insight.spec.from as string) ?? sc.from,
        to: (insight.spec.to as string) ?? sc.to,
        project: sc.project,
      };
      const r = await api.post<Record<string, unknown>>('/api/query', body);
      if (insight.kind === 'trends') {
        const t = r as unknown as TrendsResult;
        const s = t.series[0];
        if (!s) return h('div', { class: 'card-preview muted small' }, 'No data');
        return h(
          'div',
          { class: 'card-preview' },
          h(
            'div',
            { class: 'card-number' },
            count(s.total),
            h('span', { class: 'muted small' }, ` ${s.label}`),
          ),
          sparkline(s.values, { height: 44 }),
        );
      }
      if (insight.kind === 'funnel') {
        const f = r as unknown as FunnelResult;
        const first = f.steps[0]?.count ?? 0;
        const lastStep = f.steps[f.steps.length - 1]?.count ?? 0;
        return h(
          'div',
          { class: 'card-preview' },
          h(
            'div',
            { class: 'card-number' },
            percent(first ? lastStep / first : 0, 1),
            h('span', { class: 'muted small' }, ' converted'),
          ),
          h(
            'div',
            { class: 'mini-funnel' },
            f.steps.map((st) =>
              h('span', { style: `height:${first ? Math.max(4, (st.count / first) * 100) : 4}%` }),
            ),
          ),
        );
      }
      const rr = r as unknown as RetentionResult;
      const now = Date.now();
      let last = rr.average.length - 1;
      while (last > 0 && !rr.cohorts.some((c) => periodReached(c.start, last, rr.period, now)))
        last--;
      return h(
        'div',
        { class: 'card-preview' },
        h(
          'div',
          { class: 'card-number' },
          last >= 1 ? percent(rr.average[1] ?? 0, 0) : '–',
          h('span', { class: 'muted small' }, ` back after 1 ${rr.period}`),
        ),
        last >= 1
          ? sparkline(rr.average.slice(0, last + 1), { height: 44 })
          : h('div', { class: 'sparkline' }),
      );
    },
    'Loading preview',
    'block',
  );
}

function listView(route: Route): Node[] {
  const project = scope().project;
  const filterKind = (route.params.get('kind') as Kind | null) ?? null;
  let query = '';
  const grid = h('div', { class: 'insight-library' });
  let all: SavedInsight[] = [];
  const paint = () => {
    const q = query.trim().toLowerCase();
    const shown = all.filter(
      (i) =>
        (!filterKind || i.kind === filterKind) &&
        (!q || `${i.name} ${i.description}`.toLowerCase().includes(q)),
    );
    if (!shown.length) {
      mount(
        grid,
        empty(
          q ? `Nothing matches “${query}”.` : 'No saved analyses of this type yet.',
          undefined,
          { icon: 'search' },
        ),
      );
      return;
    }
    mount(
      grid,
      shown.map((insight) =>
        h(
          'a',
          { class: 'insight-card', href: href(`insights/${insight.key}`) },
          h(
            'div',
            { class: 'insight-card-head' },
            h(
              'span',
              { class: `kind-chip kind-${insight.kind}` },
              icon(KIND_ICON[insight.kind], 14),
              KIND_LABEL[insight.kind],
            ),
            h(
              'span',
              { class: 'muted small' },
              insight.updatedAt ? `Updated ${ago(insight.updatedAt)}` : '',
            ),
          ),
          h('h2', {}, insight.name),
          h('p', { class: 'muted insight-card-desc' }, insight.description || 'No description'),
          cardPreview(insight),
        ),
      ),
    );
  };
  const search = h('input', {
    type: 'search',
    placeholder: 'Search analyses',
    'aria-label': 'Search analyses',
  });
  search.addEventListener('input', () => {
    query = search.value;
    paint();
  });
  return [
    pageHeader(
      'Insights',
      'Saved analyses you and your agents can reopen. New projects start with DAU, WAU, retention and a few other defaults.',
      [copyButton(INSIGHT_PROMPT, 'Ask your agent to build analyses', 'bot'), newMenu()],
    ),
    h(
      'div',
      { class: 'toolbar' },
      h('label', { class: 'search-field' }, icon('search', 15), search),
      tabs(
        [
          { value: 'all', label: 'All' },
          ...KINDS.map((k) => ({ value: k as string, label: KIND_LABEL[k], icon: KIND_ICON[k] })),
        ],
        filterKind ?? 'all',
        (v) => go('insights', { kind: v === 'all' ? null : v }),
      ),
    ),
    later(
      async () => {
        const r = await api.get<{ insights: SavedInsight[] }>('/api/insights', { project });
        if (r.insights.length === 0) {
          return empty(
            'Build a trends, funnel or retention chart, then save it here so you and your agents can reopen it.',
            newMenu('Create your first analysis'),
            { icon: 'insights', title: 'No saved analyses yet' },
          );
        }
        all = r.insights;
        paint();
        return grid;
      },
      'Loading analyses',
      'cards',
    ),
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
  const kind = options.kind;
  const spec = structuredClone(options.spec);
  const sc = scope();
  const form = h('form', { class: 'builder' });
  const output = h('div', { class: 'insight-output' });
  const status = h('span', { class: 'run-status muted small', 'aria-live': 'polite' });
  // How trends are drawn: saved with the analysis (an old ?chart= link still works).
  let display = String(spec.display ?? options.route.params.get('chart') ?? 'line');
  let notes: (Annotation & { id: string })[] = [];
  let runId = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const fullSpec = () => {
    const cleaned = sanitizeSpec(kind, spec);
    return {
      kind,
      ...cleaned,
      from: cleaned.from ?? sc.from,
      to: cleaned.to ?? sc.to,
      project: sc.project,
    };
  };
  const shareable = () => {
    const { kind: _k, project: _p, ...rest } = fullSpec();
    return rest;
  };
  const agentPrompt = () =>
    `Using the Dataflare MCP tool query_${kind}, run ${JSON.stringify(shareable())} and explain what it shows.`;

  const cohortsMissing = () =>
    readBreakdowns(spec).includes('cohort') &&
    !(spec.breakdownCohorts as string[] | undefined)?.length;
  const ready = () => {
    if (cohortsMissing()) return false;
    if (kind === 'funnel') return (spec.steps as StepSpec[]).every((s) => s.event);
    if (kind === 'trends')
      return (spec.series as SeriesSpec[]).every(
        (s) =>
          s.event &&
          (!PROPERTY_MATHS.has(s.math ?? '') || s.property) &&
          (s.math !== 'unique_groups' || (s as { groupType?: string }).groupType),
      );
    return Boolean((spec.cohortEvent as StepSpec).event && (spec.returnEvent as StepSpec).event);
  };

  const run = async () => {
    clearTimeout(timer);
    if (!ready()) {
      mount(
        output,
        empty(
          cohortsMissing()
            ? 'Pick the cohorts to compare under “Break down by”.'
            : kind === 'funnel'
              ? 'Pick an event for every step to see the funnel.'
              : 'Pick an event to see results.',
          undefined,
          { icon: KIND_ICON[kind], title: 'Almost there' },
        ),
      );
      status.textContent = '';
      return;
    }
    const id = ++runId;
    status.textContent = 'Running…';
    output.classList.add('running');
    if (!output.firstChild || output.querySelector('.state.empty'))
      mount(output, loading('Running query', 'chart'));
    try {
      const body = fullSpec();
      const prev =
        kind === 'trends' && prefs.compare
          ? previousRange(String(body.from), body.to ? String(body.to) : null)
          : null;
      const [result, previous, pinned] = await Promise.all([
        api.post<RunResult>('/api/query', body),
        prev
          ? api
              .post<TrendsResult>('/api/query', { ...body, from: prev.from, to: prev.to })
              .catch(() => null)
          : Promise.resolve(null),
        kind === 'trends'
          ? api
              .get<{ annotations: { id: string; at: string; text: string }[] }>(
                '/api/annotations',
                {
                  project: sc.project,
                  from: String(body.from),
                  to: body.to ? String(body.to) : undefined,
                  insight: options.key,
                },
              )
              .then((x) =>
                x.annotations.map((a) => ({ id: a.id, at: Date.parse(a.at), text: a.text })),
              )
              .catch(() => [])
          : Promise.resolve([]),
      ]);
      notes = pinned;
      if (id !== runId) return;
      const shared = shareable();
      const funnel = result as unknown as FunnelResult;
      const view =
        kind === 'trends'
          ? trendsView(result as unknown as TrendsResult, previous, {
              display,
              spec,
              annotations: notes,
              onPeople: (series, label) =>
                showActors('trends', shared, { series }, `Who did ${label}`),
              onAnnotate: addNote,
              onDeleteNote: deleteNote,
              onMapBreakdown: () => {
                spec.breakdown = ['country'];
                spec.breakdownLimit = 50;
                delete spec.breakdownBins;
                delete spec.breakdownCohorts;
                update();
              },
            })
          : kind === 'funnel'
            ? funnel.steps[0]?.count
              ? (funnelVizView(funnel) ??
                h(
                  'div',
                  {},
                  funnelChart(funnel.steps, {
                    windowSeconds: funnel.windowSeconds,
                    breakdowns: funnel.breakdowns,
                    noun: countedNoun(spec.aggregateBy),
                  }),
                  h(
                    'div',
                    { class: 'row people-row' },
                    h('span', { class: 'muted small' }, 'Who:'),
                    funnel.steps.map((st, i) => [
                      h(
                        'button',
                        {
                          type: 'button',
                          class: 'chip',
                          onclick: () =>
                            showActors(
                              'funnel',
                              shared,
                              { step: i + 1, status: 'converted' },
                              `Reached step ${i + 1}`,
                            ),
                        },
                        `reached ${i + 1}`,
                      ),
                      i > 0 && st.count < (funnel.steps[i - 1]?.count ?? 0)
                        ? h(
                            'button',
                            {
                              type: 'button',
                              class: 'chip',
                              onclick: () =>
                                showActors(
                                  'funnel',
                                  shared,
                                  { step: i + 1, status: 'dropped' },
                                  `Dropped before step ${i + 1}`,
                                ),
                            },
                            `dropped before ${i + 1}`,
                          )
                        : null,
                    ]),
                  ),
                  funnel.breakdowns?.length ? null : correlationView(shared),
                ))
              : empty('No one did the first step in this period.', undefined, { icon: 'funnel' })
            : retentionView(
                result as unknown as RetentionResult,
                countedNoun(spec.aggregateBy),
                (cohort, period, breakdown) =>
                  showActors(
                    'retention',
                    shared,
                    { cohort, period, ...(breakdown === undefined ? {} : { breakdown }) },
                    period === 0
                      ? `Who joined the ${bucketLabel(cohort, 'day')} cohort`
                      : `Who came back in ${String((result as unknown as RetentionResult).period)} ${period}`,
                  ),
              );
      mount(
        output,
        panel(
          '',
          [h('p', { class: 'summary' }, icon('bot', 15), h('span', {}, result.summary)), view],
          { sql: result.sql, class: 'result-panel' },
        ),
      );
      status.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      if (options.mode === 'ephemeral' || options.mode === 'new') {
        const params = new URLSearchParams(Object.fromEntries(options.route.params));
        params.set('spec', JSON.stringify(spec));
        const path = options.mode === 'new' ? `insights/new/${kind}` : `insights/${kind}`;
        history.replaceState(null, '', `#/${path}?${params}`);
      }
    } catch (err) {
      if (id !== runId) return;
      mount(output, errorState(err));
      status.textContent = '';
    } finally {
      if (id === runId) output.classList.remove('running');
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), 450);
  };

  function addNote(): void {
    const pad = (n: number) => String(n).padStart(2, '0');
    const d = new Date();
    const when = h('input', {
      type: 'datetime-local',
      value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
    });
    const text = h('input', {
      type: 'text',
      maxlength: 500,
      placeholder: 'e.g. Launched pricing v2',
      required: true,
    });
    let onlyHere = false;
    const save = async () => {
      if (!text.value.trim() || !when.value) {
        toast('Say what happened, and when', 'error');
        return;
      }
      try {
        await api.post('/api/annotations', {
          project: sc.project,
          at: new Date(when.value).toISOString(),
          text: text.value.trim(),
          ...(onlyHere && options.key ? { insight: options.key } : {}),
        });
        toast('Note added');
        close();
        void run();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    };
    const close = modal({
      title: 'Add a note to the chart',
      width: 480,
      body: h(
        'div',
        { class: 'stack' },
        h('label', { class: 'field' }, h('span', {}, 'What happened'), text),
        h('label', { class: 'field' }, h('span', {}, 'When'), when),
        options.mode === 'saved'
          ? toggle({
              checked: false,
              label: 'Only on this analysis (otherwise on every time chart)',
              onChange: (c) => {
                onlyHere = c;
              },
            })
          : h('p', { class: 'muted small' }, 'Notes show on every time chart in this project.'),
      ),
      actions: [
        h('button', { type: 'button', onclick: () => close() }, 'Cancel'),
        h('button', { type: 'button', class: 'primary', onclick: () => void save() }, 'Add note'),
      ],
    });
    text.focus();
  }

  function deleteNote(id: string): void {
    if (!confirm('Delete this note? It disappears from every chart.')) return;
    void api
      .delete(`/api/annotations/${encodeURIComponent(id)}`, { project: sc.project })
      .then(() => {
        toast('Note deleted');
        void run();
      })
      .catch((err) => toast(err instanceof Error ? err.message : String(err), 'error'));
  }

  const renderForm = () => mount(form, builder(kind, spec, update, sc.project));
  function update() {
    renderForm();
    schedule();
  }
  // Text and number inputs inside filters change without a structural update.
  form.addEventListener('change', schedule);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void run();
  });

  const openSave = () => {
    const titleInput = h('input', {
      type: 'text',
      value: options.name ?? '',
      placeholder: 'e.g. Daily active users',
      'aria-label': 'Title',
      required: true,
    });
    const descriptionInput = h(
      'textarea',
      {
        rows: 3,
        placeholder: 'What question does this answer? Agents read this too.',
        'aria-label': 'Description',
        class: 'prose',
      },
      options.description ?? '',
    );
    const save = async () => {
      if (!titleInput.value.trim()) {
        toast('Add a title', 'error');
        titleInput.focus();
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
        close();
        toast(options.mode === 'saved' ? 'Changes saved' : 'Saved to library');
        go(`insights/${saved.key}`);
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    };
    const formEl = h(
      'form',
      { class: 'stack modal-form' },
      h('label', { class: 'field' }, h('span', {}, 'Title'), titleInput),
      h('label', { class: 'field' }, h('span', {}, 'Description'), descriptionInput),
    );
    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      void save();
    });
    const close = modal({
      title: options.mode === 'saved' ? 'Save changes' : 'Save analysis',
      body: formEl,
      actions: [
        h('button', { type: 'button', class: 'ghost', onclick: () => close() }, 'Cancel'),
        h(
          'button',
          { type: 'button', class: 'primary', onclick: () => void save() },
          icon('save', 14),
          options.mode === 'saved' ? 'Save changes' : 'Save to library',
        ),
      ],
    });
  };

  const headerActions = [
    copyButton(agentPrompt, 'Agent prompt', 'bot'),
    copyButton(() => location.href, 'Link', 'link'),
    options.mode === 'saved'
      ? iconButton('trash', 'Delete analysis', () => {
          if (!confirm('Delete this saved analysis?')) return;
          void api
            .delete(`/api/insights/${encodeURIComponent(options.key!)}`, { project: sc.project })
            .then(() => {
              toast('Deleted');
              go('insights');
            });
        })
      : null,
    h(
      'button',
      { type: 'button', class: 'primary', onclick: openSave },
      icon('save', 15),
      options.mode === 'saved' ? 'Save changes' : 'Save',
    ),
  ];

  const title =
    options.mode === 'new'
      ? `New ${KIND_LABEL[kind].toLowerCase()} analysis`
      : options.mode === 'saved'
        ? (options.name ?? 'Analysis')
        : `${KIND_LABEL[kind]} query`;
  const blurb =
    options.mode === 'saved' ? options.description || KIND_BLURB[kind] : KIND_BLURB[kind];

  const kindSwitch =
    options.mode === 'new' || options.mode === 'ephemeral'
      ? tabs(
          KINDS.map((k) => ({ value: k, label: KIND_LABEL[k], icon: KIND_ICON[k] })),
          kind,
          (next) =>
            go(options.mode === 'new' ? `insights/new/${next}` : `insights/${next}`, {
              spec: null,
            }),
          'tabs-block',
        )
      : h('span', { class: `kind-chip kind-${kind}` }, icon(KIND_ICON[kind], 14), KIND_LABEL[kind]);

  const toolbar = h('div', { class: 'canvas-toolbar' });
  /** Minute buckets only for ranges up to two days (the query refuses longer ones). */
  const minuteAllowed = () => {
    try {
      const r = resolveRange(sc.from, sc.to ?? undefined);
      return r.to - r.from <= 2 * 86_400_000 + 60_000;
    } catch {
      return false;
    }
  };
  if (spec.interval === 'minute' && !minuteAllowed()) spec.interval = 'hour';
  function setDisplay(v: string): void {
    display = v;
    if (v === 'line') delete spec.display;
    else spec.display = v;
    // A map wants every country, not the top ten.
    if (v === 'world_map' && readBreakdowns(spec).join() === 'country') spec.breakdownLimit ??= 50;
    paintToolbar();
    renderForm();
    void run();
  }
  const paintToolbar = (): void =>
    mount(
      toolbar,
      kind === 'trends'
        ? [
            tabs(
              [
                { value: 'line', label: 'Line', icon: 'lineChart' as IconName },
                { value: 'area', label: 'Area', icon: 'areaChart' as IconName },
                { value: 'bar', label: 'Bar', icon: 'barChart' as IconName },
                { value: 'number', label: 'Number', icon: 'hash' as IconName },
              ],
              display,
              setDisplay,
              'tabs-small',
            ),
            selectMenu({
              value: display,
              label: 'More ways to show it',
              options: [
                { value: 'bar_value', label: 'Bars by total', icon: 'barChart' as IconName },
                { value: 'table', label: 'Table of values', icon: 'table' as IconName },
                { value: 'pie', label: 'Pie of totals', icon: 'gauge' as IconName },
                { value: 'world_map', label: 'World map', icon: 'globe' as IconName },
              ],
              fallback: 'More views',
              width: 200,
              onChange: setDisplay,
            }),
            tabs(
              [
                ...(minuteAllowed() ? [{ value: 'minute', label: 'Minute' }] : []),
                { value: 'hour', label: 'Hour' },
                { value: 'day', label: 'Day' },
                { value: 'week', label: 'Week' },
                { value: 'month', label: 'Month' },
              ],
              String(spec.interval ?? 'day'),
              (v) => {
                spec.interval = v;
                paintToolbar();
                void run();
              },
              'tabs-small',
            ),
          ]
        : h(
            'span',
            { class: 'muted small' },
            kind === 'funnel'
              ? `Counts unique ${countedNoun(spec.aggregateBy)} who did each step ${spec.order === 'unordered' ? 'in any order' : spec.order === 'strict' ? 'one right after another' : 'in order'}.`
              : `Cohorts by the period of each ${countedNoun(spec.aggregateBy) === 'people' ? 'person' : countedNoun(spec.aggregateBy).replace(/s$/, '')}’s ${spec.retentionType === 'recurring' ? 'events' : 'first event'}.`,
          ),
      h('span', { class: 'toolbar-spacer' }),
      status,
    );
  paintToolbar();

  renderForm();
  void run();

  return [
    pageHeader(title, blurb, headerActions),
    h(
      'div',
      { class: 'analysis' },
      h(
        'aside',
        { class: 'query-rail', 'aria-label': 'Query' },
        h('div', { class: 'rail-kind' }, kindSwitch),
        form,
        options.mode !== 'saved'
          ? null
          : h(
              'a',
              { class: 'link-button rail-back', href: href('insights') },
              icon('chevronLeft', 14),
              'Back to library',
            ),
      ),
      h('section', { class: 'query-canvas' }, toolbar, output),
    ),
  ];
}

export function insightsPage(route: Route): Node[] {
  const head = route.rest[0];
  if (!head) return listView(route);

  const parseSpec = (kind: Kind): Spec => {
    try {
      return route.params.get('spec')
        ? (JSON.parse(route.params.get('spec')!) as Spec)
        : structuredClone(DEFAULTS[kind]);
    } catch {
      return structuredClone(DEFAULTS[kind]);
    }
  };

  if (head === 'new') {
    const kind = (KINDS.includes(route.rest[1] as Kind) ? route.rest[1] : 'trends') as Kind;
    return editorView({ mode: 'new', kind, spec: parseSpec(kind), route });
  }

  if (KINDS.includes(head as Kind)) {
    const kind = head as Kind;
    return editorView({ mode: 'ephemeral', kind, spec: parseSpec(kind), route });
  }

  return [
    later(
      async () => {
        const project = scope().project;
        const insight = await api.get<SavedInsight>(`/api/insights/${encodeURIComponent(head)}`, {
          project,
        });
        return editorView({
          mode: 'saved',
          kind: insight.kind,
          key: insight.key,
          name: insight.name,
          description: insight.description,
          spec: insight.spec,
          route,
        });
      },
      'Loading analysis',
      'chart',
    ),
  ];
}
