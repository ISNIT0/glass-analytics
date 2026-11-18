/**
 * The deeper insight options in the builder: what to count by (people,
 * sessions or a group type), formulas, cumulative and smoothed trends, funnel
 * step order, exclusions and views, retention type and averaging; plus the
 * "who is behind this number" list.
 */

import { api } from '../api.ts';
import { type Child, h, mount } from '../dom.ts';
import { count } from '../format.ts';
import { href, scope } from '../state.ts';
import { lineChart } from './charts.ts';
import { icon } from './icons.ts';
import { modal, selectMenu, toggle } from './menu.ts';
import { eventPicker, propertyPicker } from './picker.ts';
import { empty, errorState, loading, table, tabs, toast } from './ui.ts';

type Spec = Record<string, unknown>;

/** Every trends measure, grouped by what it needs. */
export const MEASURES: { value: string; label: string }[] = [
  { value: 'total', label: 'Total count' },
  { value: 'unique_persons', label: 'Unique people' },
  { value: 'unique_sessions', label: 'Unique sessions' },
  { value: 'unique_groups', label: 'Unique groups' },
  { value: 'wau', label: 'Weekly active (rolling 7 days)' },
  { value: 'mau', label: 'Monthly active (rolling 30 days)' },
  { value: 'first_time', label: 'First time ever' },
  { value: 'sum', label: 'Sum of property' },
  { value: 'avg', label: 'Average of property' },
  { value: 'min', label: 'Minimum of property' },
  { value: 'max', label: 'Maximum of property' },
  { value: 'median', label: 'Median of property' },
  { value: 'p90', label: '90th percentile of property' },
  { value: 'p95', label: '95th percentile of property' },
  { value: 'p99', label: '99th percentile of property' },
  { value: 'avg_count_per_actor', label: 'Times per person (average)' },
  { value: 'median_count_per_actor', label: 'Times per person (median)' },
  { value: 'max_count_per_actor', label: 'Times per person (most)' },
  { value: 'revenue', label: 'Revenue' },
];
export const PROPERTY_MATHS = new Set([
  'sum',
  'avg',
  'min',
  'max',
  'median',
  'p75',
  'p90',
  'p95',
  'p99',
]);

let groupTypes: { project: string | undefined; types: string[] } | null = null;

/** The project's group types, loaded once per project; `onLoad` re-renders when they arrive. */
export function knownGroupTypes(project: string | undefined, onLoad: () => void): string[] {
  if (groupTypes && groupTypes.project === project) return groupTypes.types;
  groupTypes = { project, types: [] };
  api
    .get<{ types: { type: string }[] }>('/api/groups/types', { project })
    .then((r) => {
      groupTypes = { project, types: r.types.map((t) => t.type) };
      if (r.types.length) onLoad();
    })
    .catch(() => {});
  return [];
}

function section(title: string, ...children: Child[]): HTMLElement {
  return h('div', { class: 'rail-section' }, h('div', { class: 'rail-label' }, title), ...children);
}

/** People, sessions or a group type. */
export function countBySection(
  spec: Spec,
  update: () => void,
  project?: string,
): HTMLElement | null {
  const types = knownGroupTypes(project, update);
  const value = String(spec.aggregateBy ?? 'person');
  return section(
    'Count by',
    selectMenu({
      value,
      label: 'What to count',
      options: [
        { value: 'person', label: 'People' },
        { value: 'session', label: 'Sessions' },
        ...types.map((t) => ({ value: t, label: `${t} (group)` })),
      ],
      fallback: value,
      width: 200,
      onChange: (v) => {
        if (v === 'person') delete spec.aggregateBy;
        else spec.aggregateBy = v;
        update();
      },
    }),
  );
}

/** A toggle for a boolean spec field that is left out when off. */
function flag(spec: Spec, key: string, label: string, update: () => void): HTMLElement {
  return toggle({
    checked: Boolean(spec[key]),
    label,
    onChange: (c) => {
      if (c) spec[key] = true;
      else delete spec[key];
      update();
    },
  });
}

/** Leave out the project's internal and test traffic (Settings › Internal traffic). */
export function testAccountsToggle(spec: Spec, update: () => void): HTMLElement {
  const el = flag(spec, 'filterTestAccounts', 'Filter out internal and test traffic', update);
  el.title = 'Uses the internal traffic filters in Settings';
  return el;
}

export function trendsOptions(spec: Spec, update: () => void, seriesCount: number): HTMLElement[] {
  const display = String(spec.display ?? 'line');
  const timeChart = ['line', 'area', 'bar'].includes(display);
  const lines =
    seriesCount + (Array.isArray(spec.breakdown) ? spec.breakdown.length : spec.breakdown ? 1 : 0);
  const formulas = (spec.formulas as { expr: string }[] | undefined) ?? [];
  const formula = h('input', {
    type: 'text',
    value: formulas[0]?.expr ?? '',
    placeholder: seriesCount > 1 ? 'e.g. B / A * 100' : 'Add a second series to combine them',
    class: 'formula-input',
  });
  formula.addEventListener('change', () => {
    const expr = formula.value.trim();
    if (expr) spec.formulas = [{ expr }];
    else delete spec.formulas;
    update();
  });
  const smoothing = Number(spec.smoothing ?? 0);
  // Sections, not a wrapper: they sit in the builder's grid and get its spacing.
  return [
    section('Formula', formula),
    section(
      'Display',
      h(
        'div',
        { class: 'stack tight' },
        toggle({
          checked: Boolean(spec.cumulative),
          label: 'Cumulative',
          onChange: (c) => {
            if (c) spec.cumulative = true;
            else delete spec.cumulative;
            update();
          },
        }),
        formulas.length
          ? toggle({
              checked: Boolean(spec.formulaOnly),
              label: 'Only the formula',
              onChange: (c) => {
                if (c) spec.formulaOnly = true;
                else delete spec.formulaOnly;
                update();
              },
            })
          : null,
        selectMenu({
          value: String(smoothing),
          label: 'Smoothing',
          options: [
            { value: '0', label: 'No smoothing' },
            { value: '7', label: '7-interval average' },
            { value: '28', label: '28-interval average' },
          ],
          width: 200,
          onChange: (v) => {
            if (v === '0') delete spec.smoothing;
            else spec.smoothing = Number(v);
            update();
          },
        }),
        timeChart
          ? [
              flag(spec, 'trendLine', 'Trend line', update),
              flag(spec, 'logScale', 'Log scale', update),
              lines > 1 ? flag(spec, 'percentStack', 'Stack to 100%', update) : null,
              flag(spec, 'showValues', 'Show values', update),
            ]
          : null,
      ),
    ),
  ];
}

export function funnelOptions(
  spec: Spec,
  update: () => void,
  stepCount: number,
  project?: string,
): (HTMLElement | null)[] {
  const exclusions =
    (spec.exclusions as { event: string; fromStep: number; toStep: number }[] | undefined) ?? [];
  const viz = String(spec.viz ?? 'steps');
  const broken = Array.isArray(spec.breakdown)
    ? spec.breakdown.length > 0
    : Boolean(spec.breakdown);
  const attribution = String(spec.breakdownAttribution ?? 'first_touch');
  return [
    broken && spec.breakdown !== 'cohort'
      ? section(
          'Breakdown value from',
          selectMenu({
            value: attribution,
            label: 'Breakdown attribution',
            options: [
              { value: 'first_touch', label: 'The first step' },
              { value: 'last_touch', label: 'The last step reached' },
              { value: 'all_steps', label: 'Every step (must match)' },
              ...Array.from({ length: Math.max(0, stepCount - 1) }, (_, i) => ({
                value: String(i + 2),
                label: `Step ${i + 2}`,
              })),
            ],
            fallback: `Step ${attribution}`,
            width: 220,
            onChange: (v) => {
              if (v === 'first_touch') delete spec.breakdownAttribution;
              else spec.breakdownAttribution = /^\d+$/.test(v) ? Number(v) : v;
              update();
            },
          }),
        )
      : null,
    section(
      'Step order',
      tabs(
        [
          { value: 'ordered', label: 'In order' },
          { value: 'strict', label: 'Strict' },
          { value: 'unordered', label: 'Any order' },
        ],
        String(spec.order ?? 'ordered'),
        (v) => {
          if (v === 'ordered') delete spec.order;
          else spec.order = v;
          update();
        },
        'tabs-small',
      ),
    ),
    section(
      'Exclude people who did',
      h(
        'div',
        { class: 'stack tight' },
        exclusions.map((x, i) =>
          h(
            'div',
            { class: 'row' },
            eventPicker({
              value: x.event,
              project,
              label: `Exclusion ${i + 1}`,
              onChange: (v) => {
                x.event = v;
                update();
              },
            }),
            h(
              'button',
              {
                type: 'button',
                class: 'icon-button',
                'aria-label': 'Remove exclusion',
                onclick: () => {
                  exclusions.splice(i, 1);
                  if (!exclusions.length) delete spec.exclusions;
                  update();
                },
              },
              icon('x', 14),
            ),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'link-button add-button',
            onclick: () => {
              spec.exclusions = [
                ...exclusions,
                { event: '', fromStep: 1, toStep: Math.max(2, stepCount) },
              ];
              update();
            },
          },
          icon('plus', 14),
          'Add exclusion',
        ),
      ),
    ),
    section(
      'Show',
      tabs(
        [
          { value: 'steps', label: 'Steps' },
          { value: 'time_to_convert', label: 'Time to convert' },
          { value: 'trends', label: 'Conversion over time' },
        ],
        viz,
        (v) => {
          if (v === 'steps') delete spec.viz;
          else spec.viz = v;
          update();
        },
        'tabs-small',
      ),
    ),
  ];
}

export function retentionOptions(spec: Spec, update: () => void): HTMLElement[] {
  return [
    section(
      'Who is in a cohort',
      tabs(
        [
          { value: 'first_time', label: 'First time' },
          { value: 'recurring', label: 'Every time' },
        ],
        String(spec.retentionType ?? 'first_time'),
        (v) => {
          if (v === 'first_time') delete spec.retentionType;
          else spec.retentionType = v;
          update();
        },
        'tabs-small',
      ),
    ),
    section(
      'Options',
      h(
        'div',
        { class: 'stack tight' },
        toggle({
          checked: Boolean(spec.cumulative),
          label: 'On or after (cumulative)',
          onChange: (c) => {
            if (c) spec.cumulative = true;
            else delete spec.cumulative;
            update();
          },
        }),
        selectMenu({
          value: String(spec.meanMethod ?? 'weighted'),
          label: 'Average',
          options: [
            { value: 'weighted', label: 'Weighted by cohort size' },
            { value: 'simple', label: 'Simple average' },
          ],
          width: 220,
          onChange: (v) => {
            if (v === 'weighted') delete spec.meanMethod;
            else spec.meanMethod = v;
            update();
          },
        }),
      ),
    ),
  ];
}

interface CorrelationItem {
  name: string;
  event?: string;
  successCount: number;
  failureCount: number;
  conversionRate: number;
  oddsRatio: number;
  significant: boolean;
}

/**
 * What goes with converting through a funnel, and with dropping off: other
 * events people did (or values of a property they had), by odds ratio. Runs on
 * demand, since it reads every event of everyone who entered the funnel.
 */
export function correlationView(spec: Spec): HTMLElement {
  const project = scope().project;
  const root = h('div', { class: 'correlation' });
  let mode: 'events' | 'properties' = 'events';
  let property = '';
  const results = h('div', {});
  const list = (items: CorrelationItem[], title: string, good: boolean) =>
    h(
      'div',
      { class: 'correlation-list' },
      h('h4', {}, title),
      items.length
        ? table(
            [
              mode === 'events' ? 'Event' : 'Value',
              'Converted',
              'Dropped off',
              'Conversion',
              'Odds',
            ],
            items.map((it) => [
              mode === 'events'
                ? h('span', { class: 'event-pill' }, it.event ?? it.name)
                : h('span', { class: 'cell-clip', title: it.name }, it.name),
              count(it.successCount),
              count(it.failureCount),
              `${Math.round(it.conversionRate * 100)}%`,
              h(
                'span',
                {
                  class: it.significant ? (good ? 'good' : 'bad') : 'muted',
                  title: it.significant ? 'Significant (p < 0.05)' : 'Not significant yet',
                },
                `${it.oddsRatio >= 10 ? Math.round(it.oddsRatio) : it.oddsRatio.toFixed(1)}×`,
              ),
            ]),
            { numeric: [1, 2, 3, 4] },
          )
        : h('p', { class: 'muted small' }, 'Nothing stands out.'),
    );
  const run = async () => {
    if (mode === 'properties' && !property) {
      mount(results, h('p', { class: 'muted small' }, 'Pick a property to compare its values.'));
      return;
    }
    mount(results, loading('Comparing converters with drop-offs', 'table'));
    try {
      const r = await api.post<{
        converters: number;
        dropOffs: number;
        success: CorrelationItem[];
        failure: CorrelationItem[];
        summary: string;
      }>('/api/query', {
        ...spec,
        kind: 'funnel_correlation',
        project,
        correlation: mode,
        ...(mode === 'properties' ? { properties: [property] } : {}),
      });
      mount(
        results,
        h(
          'p',
          { class: 'muted small' },
          `${count(r.converters)} converted, ${count(r.dropOffs)} dropped off.`,
        ),
        h(
          'div',
          { class: 'grid-2 correlation-grid' },
          list(r.success, 'Goes with converting', true),
          list(r.failure, 'Goes with dropping off', false),
        ),
      );
    } catch (err) {
      mount(results, errorState(err));
    }
  };
  const paint = () =>
    mount(
      root,
      h(
        'div',
        { class: 'correlation-head' },
        h(
          'div',
          {},
          h('strong', {}, 'What goes with converting'),
          h(
            'p',
            { class: 'muted small correlation-note' },
            'Events or property values far more common among people who converted, or who dropped off.',
          ),
        ),
        tabs(
          [
            { value: 'events', label: 'Events' },
            { value: 'properties', label: 'A property' },
          ],
          mode,
          (v) => {
            mode = v;
            paint();
            void run();
          },
          'tabs-small',
        ),
      ),
      mode === 'properties'
        ? h(
            'div',
            { class: 'correlation-property' },
            propertyPicker({
              value: property,
              project,
              event: (spec.steps as { event: string }[] | undefined)?.[0]?.event,
              placeholder: 'person.plan, browser, utm_source…',
              onChange: (v) => {
                property = v;
                void run();
              },
            }),
          )
        : null,
      results,
    );
  paint();
  mount(
    results,
    h(
      'button',
      { type: 'button', onclick: () => void run() },
      icon('search', 14),
      'Find what drives conversion',
    ),
  );
  return root;
}

const formatSeconds = (s: number) =>
  s < 60
    ? `${Math.round(s)}s`
    : s < 3600
      ? `${Math.round(s / 60)}m`
      : s < 86400
        ? `${(s / 3600).toFixed(1)}h`
        : `${(s / 86400).toFixed(1)}d`;

/** Funnel views other than steps: the time-to-convert histogram, or conversion over time. */
export function funnelVizView(r: {
  timeToConvert?: {
    fromStep: number;
    toStep: number;
    converters: number;
    averageSeconds: number | null;
    medianSeconds: number | null;
    histogram: { fromSeconds: number; toSeconds: number; count: number }[];
  };
  trend?: {
    interval: string;
    buckets: number[];
    fromStep: number;
    toStep: number;
    series: { breakdown: string | null; rate: number[] }[];
  };
}): HTMLElement | null {
  if (r.timeToConvert) {
    const t = r.timeToConvert;
    return h(
      'div',
      { class: 'insight-result' },
      h(
        'p',
        { class: 'muted' },
        `${count(t.converters)} converted from step ${t.fromStep} to ${t.toStep}. Median ${t.medianSeconds === null ? '–' : formatSeconds(t.medianSeconds)}, average ${t.averageSeconds === null ? '–' : formatSeconds(t.averageSeconds)}.`,
      ),
      t.histogram.length
        ? lineChart(
            t.histogram.map((_, i) => i),
            [{ label: 'People', values: t.histogram.map((b) => b.count) }],
            'day',
            {
              type: 'bar',
              height: 260,
              labels: t.histogram.map(
                (b) => `${formatSeconds(b.fromSeconds)}–${formatSeconds(b.toSeconds)}`,
              ),
            },
          )
        : empty('No one converted in this range.'),
    );
  }
  if (r.trend) {
    const t = r.trend;
    return h(
      'div',
      { class: 'insight-result' },
      lineChart(
        t.buckets,
        t.series.map((s) => ({
          label: s.breakdown ?? `Step ${t.fromStep} → ${t.toStep}`,
          values: s.rate,
        })),
        t.interval,
        { height: 300, yMax: 1, format: (n) => `${Math.round(n * 100)}%` },
      ),
    );
  }
  return null;
}

/** The people (sessions, groups) behind a number, with CSV export and "save as cohort". */
export function showActors(
  kind: 'trends' | 'funnel' | 'retention',
  spec: Spec,
  selection: Record<string, unknown>,
  title: string,
): void {
  const project = scope().project;
  const body = h('div', {}, loading('Loading people', 'table'));
  const request = {
    project,
    kind,
    spec: { ...spec, kind: undefined, project: undefined },
    selection,
    limit: 100,
  };
  const close = modal({
    title,
    body,
    width: 720,
    actions: [
      h(
        'button',
        {
          type: 'button',
          onclick: async () => {
            const name = prompt('Name the cohort:', title);
            if (!name) return;
            try {
              await api.post('/api/actors', { ...request, saveAsCohort: { name } });
              toast(`Saved "${name}" as a cohort`);
              close();
            } catch (err) {
              toast(err instanceof Error ? err.message : String(err), 'error');
            }
          },
        },
        'Save as cohort',
      ),
      h(
        'button',
        {
          type: 'button',
          onclick: async () => {
            const r = await api.post<{ csv: string }>('/api/actors', {
              ...request,
              format: 'csv',
              limit: 1000,
            });
            const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' }));
            const a = h('a', { href: url, download: 'people.csv' });
            a.click();
            URL.revokeObjectURL(url);
          },
        },
        'Download CSV',
      ),
    ],
  });
  api
    .post<{
      actors: {
        id: string;
        type: string;
        groupType?: string;
        events: number;
        properties: Record<string, unknown>;
      }[];
      summary: string;
      hasMore: boolean;
    }>('/api/actors', request)
    .then((r) =>
      mount(
        body,
        h('p', { class: 'muted' }, r.summary),
        r.actors.length
          ? table(
              ['Who', 'Events', ''],
              r.actors.map((a) => [
                h(
                  'a',
                  {
                    href:
                      a.type === 'person'
                        ? href(`users/${encodeURIComponent(a.id)}`)
                        : a.type === 'group'
                          ? href(
                              `groups/${encodeURIComponent(a.groupType ?? '')}/${encodeURIComponent(a.id)}`,
                            )
                          : href(`replays/${encodeURIComponent(a.id)}`),
                  },
                  a.id,
                ),
                count(a.events),
                h(
                  'span',
                  { class: 'muted small' },
                  String(a.properties.email ?? a.properties.name ?? ''),
                ),
              ]),
              { numeric: [1] },
            )
          : null,
      ),
    )
    .catch((err) => mount(body, errorState(err)));
}
