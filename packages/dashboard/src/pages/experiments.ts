/**
 * Experiments: list, create, and the results readout.
 */

import type { ExperimentResult, MetricResult } from '@dataflare/core/insights/experiment';
import { api } from '../api.ts';
import { kpiStat, lineChart } from '../components/charts.ts';
import { icon } from '../components/icons.ts';
import { toggle } from '../components/menu.ts';
import {
  completeMetrics,
  describeMetric,
  type Metric,
  metricsEditor,
} from '../components/metric-editor.ts';
import {
  copyButton,
  empty,
  errorState,
  later,
  pageHeader,
  panel,
  table,
  tabs,
  toast,
} from '../components/ui.ts';
import { type Child, h, mount } from '../dom.ts';
import { count, dateTime, decimal, percent } from '../format.ts';
import { go, href, type Route, scope } from '../state.ts';

interface Experiment {
  key: string;
  flag: string;
  status: 'draft' | 'running' | 'paused' | 'stopped' | 'shipped' | 'archived';
  goal: { event: string; value?: string } | null;
  metrics: Metric[];
  secondary: Metric[];
  hypothesis: string;
  holdout: string | null;
  engine?: 'bayesian' | 'frequentist';
  confidence?: number;
  minimumDays?: number;
  startedAt: number | null;
  shippedVariant: string | null;
  createdAt: number;
}

interface Holdout {
  key: string;
  name: string;
  description?: string;
  percentage: number;
  createdAt: number;
  experiments: { key: string; status: string }[];
}

/** What the experiment measures first, in a few words. */
const firstGoal = (e: Experiment) =>
  e.goal?.event
    ? `Goal: ${e.goal.event}`
    : e.metrics[0]
      ? describeMetric(e.metrics[0])
      : 'No metric yet';

/** Page changes per variant for a web experiment (no code change). */
interface Change {
  variant: string;
  selector: string;
  type: 'text' | 'html' | 'css' | 'hide';
  value: string;
}

function changesEditor(changes: Change[], variants: () => string[]): HTMLElement {
  const root = h('div', { class: 'rich-list' });
  const paint = () =>
    mount(
      root,
      changes.map((c, i) => {
        const variant = h(
          'select',
          { class: 'short-select' },
          variants()
            .slice(1)
            .map((v) => h('option', { value: v, selected: v === c.variant }, v)),
        );
        variant.addEventListener('change', () => (c.variant = variant.value));
        if (!c.variant) c.variant = variants()[1] ?? 'test';
        const selector = h('input', {
          type: 'text',
          value: c.selector,
          placeholder: 'CSS selector, e.g. #hero h1',
        });
        selector.addEventListener('change', () => (c.selector = selector.value.trim()));
        const type = h(
          'select',
          { class: 'short-select' },
          [
            ['text', 'Set text'],
            ['html', 'Set HTML'],
            ['css', 'Add style'],
            ['hide', 'Hide'],
          ].map(([v, label]) => h('option', { value: v, selected: v === c.type }, label)),
        );
        const value = h('input', {
          type: 'text',
          value: c.value,
          placeholder: 'New text',
          hidden: c.type === 'hide',
        });
        type.addEventListener('change', () => {
          c.type = type.value as Change['type'];
          value.hidden = c.type === 'hide';
          value.placeholder =
            c.type === 'css'
              ? 'e.g. background:#e00'
              : c.type === 'html'
                ? '<strong>New</strong>'
                : 'New text';
        });
        value.addEventListener('change', () => (c.value = value.value));
        return h(
          'div',
          { class: 'query-card rich-card' },
          h(
            'div',
            { class: 'row' },
            h('span', { class: 'muted small' }, 'In'),
            variant,
            type,
            h(
              'button',
              {
                type: 'button',
                class: 'icon-button push-right',
                'aria-label': 'Remove change',
                onclick: () => {
                  changes.splice(i, 1);
                  paint();
                },
              },
              icon('x', 14),
            ),
          ),
          selector,
          value,
        );
      }),
      h(
        'button',
        {
          type: 'button',
          class: 'link-button add-button',
          onclick: () => {
            changes.push({
              variant: variants()[1] ?? 'test',
              selector: '',
              type: 'text',
              value: '',
            });
            paint();
          },
        },
        icon('plus', 14),
        'Add a page change',
      ),
    );
  paint();
  return root;
}

/** Engine, confidence and minimum runtime, shared by the create and edit forms. */
function statsControls(state: {
  engine: string;
  confidence: number;
  minimumDays: number;
}): HTMLElement {
  const days = h('input', {
    type: 'number',
    min: 0,
    max: 90,
    value: state.minimumDays,
    class: 'short',
  });
  days.addEventListener('change', () => (state.minimumDays = Number(days.value)));
  const confidence = h(
    'select',
    { class: 'short-select' },
    [0.9, 0.95, 0.99].map((c) =>
      h('option', { value: String(c), selected: c === state.confidence }, `${c * 100}%`),
    ),
  );
  confidence.addEventListener('change', () => (state.confidence = Number(confidence.value)));
  const engine = tabs(
    [
      { value: 'bayesian', label: 'Bayesian' },
      { value: 'frequentist', label: 'Frequentist' },
    ],
    state.engine,
    (v) => {
      state.engine = v;
      mount(engineHolder, statsControls(state));
    },
    'tabs-small',
  );
  const engineHolder = h('div', { class: 'stack tight' });
  mount(
    engineHolder,
    h(
      'div',
      { class: 'row' },
      engine,
      h(
        'span',
        { class: 'muted small' },
        state.engine === 'bayesian'
          ? 'Reports the chance each variant is best'
          : 'Reports p-values',
      ),
    ),
    h(
      'div',
      { class: 'row' },
      h('span', { class: 'muted small' }, 'Confidence'),
      confidence,
      h('span', { class: 'muted small' }, '· No winner before'),
      days,
      h('span', { class: 'muted small' }, 'days'),
    ),
  );
  return engineHolder;
}

function holdoutSelect(holdouts: Holdout[], value: string | null): HTMLSelectElement {
  return h(
    'select',
    {},
    h('option', { value: '' }, 'No holdout'),
    holdouts.map((ho) =>
      h(
        'option',
        { value: ho.key, selected: ho.key === value },
        `${ho.name} (${ho.percentage}% held out)`,
      ),
    ),
  );
}

function planPanel(
  metrics: Metric[],
  variants: () => string[],
  state: { confidence: number },
): HTMLElement {
  const out = h('div', {});
  const mde = h('input', { type: 'number', min: 1, max: 100, value: 10, class: 'short' });
  const run = async () => {
    const metric = completeMetrics(metrics)[0];
    if (!metric) {
      mount(out, h('p', { class: 'muted' }, 'Add a primary metric first.'));
      return;
    }
    try {
      const plan = await api.post<{
        days: number | null;
        perVariant: number | null;
        peoplePerDay: number;
        baseline: number;
        summary: string;
      }>('/api/experiments/plan', {
        project: scope().project,
        metric,
        variants: Math.max(2, variants().length),
        mde: Number(mde.value) / 100,
        confidence: state.confidence,
      });
      mount(
        out,
        h(
          'div',
          { class: 'stats' },
          kpiStat('Running time', plan.days === null ? '—' : `${Math.ceil(plan.days)} days`),
          kpiStat('People per variant', plan.perVariant === null ? '—' : count(plan.perVariant)),
          kpiStat('New people a day', count(plan.peoplePerDay)),
          kpiStat(
            'Baseline',
            metric.kind === 'conversion' ? percent(plan.baseline) : decimal(plan.baseline),
          ),
        ),
        h('p', { class: 'muted small' }, plan.summary),
      );
    } catch (err) {
      mount(out, errorState(err));
    }
  };
  return panel(
    'How long will it take?',
    [
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'muted small' }, 'To detect a change of'),
        mde,
        h('span', { class: 'muted small' }, '% in the first metric'),
        h('button', { type: 'button', onclick: run }, 'Estimate'),
      ),
      out,
    ],
    { icon: 'clock', subtitle: 'From the last 14 days of traffic and the metric’s current value.' },
  );
}

function createForm(holdouts: Holdout[]): HTMLElement {
  const project = scope().project;
  const key = h('input', { type: 'text', required: true, placeholder: 'pricing-page-v2' });
  const hypothesis = h('input', {
    type: 'text',
    placeholder: 'Showing annual pricing first increases signups',
  });
  const variants = h('input', { type: 'text', value: 'control:50, test:50' });
  const variantKeys = () =>
    variants.value
      .split(',')
      .map((p) => p.trim().split(':')[0]!.trim())
      .filter(Boolean);
  const primary: Metric[] = [{ kind: 'conversion', event: '' }];
  const secondary: Metric[] = [];
  const state = { engine: 'bayesian', confidence: 0.95, minimumDays: 7 };
  const holdout = holdoutSelect(holdouts, null);
  let web = false;
  const changes: Change[] = [];
  const changesBox = h('div', { hidden: true }, changesEditor(changes, variantKeys));
  const error = h('div', {});
  const form = h(
    'form',
    { class: 'stack wide-stack' },
    h('label', { class: 'field' }, h('span', {}, 'Key (also the flag key)'), key),
    h('label', { class: 'field' }, h('span', {}, 'Hypothesis'), hypothesis),
    h(
      'div',
      { class: 'field' },
      h('span', {}, 'Primary metrics (the first decides)'),
      metricsEditor(primary, project, { min: 1, addLabel: 'Add a primary metric' }),
    ),
    h(
      'div',
      { class: 'field' },
      h('span', {}, 'Secondary metrics (guardrails)'),
      metricsEditor(secondary, project, { addLabel: 'Add a guardrail, e.g. errors or refunds' }),
    ),
    h('label', { class: 'field' }, h('span', {}, 'Variants (first is control)'), variants),
    h('div', { class: 'field' }, h('span', {}, 'Statistics'), statsControls(state)),
    h('label', { class: 'field' }, h('span', {}, 'Holdout'), holdout),
    toggle({
      checked: false,
      label: 'Web experiment: change the page per variant (no code change)',
      onChange: (c) => {
        web = c;
        changesBox.hidden = !c;
      },
    }),
    changesBox,
    error,
    h(
      'div',
      { class: 'form-actions' },
      h('button', { type: 'submit', class: 'primary' }, 'Create experiment'),
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const metrics = completeMetrics(primary);
      if (!metrics.length) throw new Error('Pick an event for the primary metric.');
      const transforms: Record<string, unknown[]> = {};
      if (web) {
        for (const c of changes.filter((x) => x.selector)) {
          const t =
            c.type === 'hide'
              ? { selector: c.selector, hide: true }
              : { selector: c.selector, [c.type]: c.value };
          const list = transforms[c.variant] ?? [];
          list.push(t);
          transforms[c.variant] = list;
        }
      }
      const parsedVariants = variants.value
        .split(',')
        .map((part) => {
          const [k, w] = part.trim().split(':');
          return { key: k!.trim(), weight: Number(w ?? 1) };
        })
        .filter((v) => v.key);
      await api.post('/api/experiments', {
        project,
        key: key.value,
        hypothesis: hypothesis.value || undefined,
        metrics,
        ...(completeMetrics(secondary).length ? { secondary: completeMetrics(secondary) } : {}),
        variants: parsedVariants.length >= 2 ? parsedVariants : undefined,
        engine: state.engine,
        confidence: state.confidence,
        minimumDays: state.minimumDays,
        ...(holdout.value ? { holdout: holdout.value } : {}),
        ...(Object.keys(transforms).length ? { transforms } : {}),
      });
      toast('Experiment created');
      go(`experiments/${encodeURIComponent(key.value)}`);
    } catch (err) {
      mount(error, errorState(err));
    }
  });
  return h(
    'div',
    {},
    panel('Experiment', form, { icon: 'flask' }),
    planPanel(primary, variantKeys, state),
  );
}

const STATUS_LABEL: Record<Experiment['status'], string> = {
  draft: 'Draft',
  running: 'Running',
  paused: 'Paused',
  stopped: 'Stopped',
  shipped: 'Shipped',
  archived: 'Archived',
};

function statusBadge(status: Experiment['status']): HTMLElement {
  return h(
    'span',
    { class: `status status-${status}` },
    h('span', { class: 'status-dot' }),
    STATUS_LABEL[status],
  );
}

/** Where the lift interval sits on a symmetric axis around 0. */
function liftBar(low: number, high: number, expected: number, span: number): HTMLElement {
  const pos = (v: number) => `${50 + (Math.max(-span, Math.min(span, v)) / span) * 50}%`;
  const cls = low > 0 ? 'good' : high < 0 ? 'bad' : '';
  return h(
    'div',
    {
      class: `lift-bar ${cls}`,
      title: `Lift ${percent(expected, 1)} (95% interval ${percent(low, 1)} to ${percent(high, 1)})`,
    },
    h('span', { class: 'lift-zero' }),
    h('span', { class: 'lift-range', style: `left:${pos(low)};right:calc(100% - ${pos(high)})` }),
    h('span', { class: 'lift-point', style: `left:${pos(expected)}` }),
  );
}

function results(r: ExperimentResult): HTMLElement {
  const exposures = r.variants.reduce((n, v) => n + v.exposures, 0);
  const conversions = r.variants.reduce((n, v) => n + v.conversions, 0);
  const span = Math.max(
    0.1,
    ...r.variants.flatMap((v) =>
      v.vsControl
        ? [Math.abs(v.vsControl.liftInterval[0]), Math.abs(v.vsControl.liftInterval[1])]
        : [],
    ),
  );
  const best = r.variants
    .filter((v) => v.vsControl)
    .sort(
      (a, b) => b.vsControl!.probabilityToBeatControl - a.vsControl!.probabilityToBeatControl,
    )[0];
  return h(
    'div',
    { class: 'experiment-results' },
    h(
      'div',
      { class: 'stats' },
      kpiStat('Exposed', count(exposures), `${r.variants.length} variants`),
      kpiStat(
        'Converted',
        count(conversions),
        exposures ? `${percent(conversions / exposures, 1)} overall` : undefined,
      ),
      best?.vsControl
        ? kpiStat(
            `Chance ${best.variant} beats control`,
            percent(best.vsControl.probabilityToBeatControl, 0),
            r.winner ? h('span', { class: 'good' }, `Winner: ${r.winner}`) : 'Needs 95% to call it',
          )
        : null,
      r.estimatedDaysToSignificance !== null && !r.winner
        ? kpiStat(
            'Time to a result',
            `~${Math.ceil(r.estimatedDaysToSignificance)} days`,
            'to detect a 10% lift',
          )
        : null,
    ),
    r.srm.mismatch
      ? h(
          'div',
          { class: 'state error' },
          icon('alert', 18),
          h(
            'p',
            {},
            `Sample ratio mismatch (p = ${r.srm.pValue.toExponential(1)}). Exposure tracking or assignment is broken; don't trust these numbers yet.`,
          ),
        )
      : null,
    h(
      'div',
      { class: 'variant-cards' },
      r.variants.map((v, i) =>
        h(
          'div',
          { class: `variant-card ${r.winner === v.variant ? 'winner' : ''}` },
          h(
            'div',
            { class: 'variant-head' },
            h(
              'span',
              {
                class: 'series-tag',
                style: `--tag:var(--${['smoke', 'glass-cobalt', 'glass-amber', 'glass-ruby'][i % 4]})`,
              },
              String.fromCharCode(65 + i),
            ),
            h('strong', {}, v.variant),
            i === 0 ? h('span', { class: 'badge' }, 'Control') : null,
            r.winner === v.variant ? h('span', { class: 'badge good' }, 'Winner') : null,
          ),
          h(
            'div',
            { class: 'variant-rate' },
            percent(v.conversionRate, 1),
            h('span', { class: 'muted small' }, ' conversion'),
          ),
          h(
            'div',
            { class: 'meter' },
            h('span', { style: `width:${Math.min(100, v.conversionRate * 100)}%` }),
          ),
          h(
            'div',
            { class: 'muted small' },
            `${count(v.conversions)} of ${count(v.exposures)} · 95% interval ${percent(v.rateInterval[0])}–${percent(v.rateInterval[1])}`,
          ),
          v.vsControl
            ? h(
                'div',
                { class: 'variant-lift' },
                h(
                  'div',
                  { class: 'variant-lift-head' },
                  h('span', {}, 'Lift vs control'),
                  h(
                    'strong',
                    { class: v.vsControl.expectedLift >= 0 ? 'good' : 'bad' },
                    `${v.vsControl.expectedLift >= 0 ? '+' : ''}${percent(v.vsControl.expectedLift, 1)}`,
                  ),
                ),
                liftBar(
                  v.vsControl.liftInterval[0],
                  v.vsControl.liftInterval[1],
                  v.vsControl.expectedLift,
                  span,
                ),
                h(
                  'div',
                  { class: 'muted small' },
                  `${percent(v.vsControl.probabilityToBeatControl, 0)} chance to beat control`,
                ),
              )
            : h(
                'div',
                { class: 'variant-lift muted small' },
                i === 0
                  ? 'Every other variant is compared with this one.'
                  : 'Not enough data to compare yet.',
              ),
        ),
      ),
    ),
    h('p', { class: 'summary' }, icon('bot', 15), h('span', {}, r.summary)),
    table(
      [
        'Variant',
        'Exposed',
        'Converted',
        'Rate',
        '95% interval',
        'Chance to beat control',
        'Lift (95% interval)',
      ],
      r.variants.map((v) => [
        h('strong', {}, v.variant),
        count(v.exposures),
        count(v.conversions),
        percent(v.conversionRate),
        `${percent(v.rateInterval[0])} to ${percent(v.rateInterval[1])}`,
        v.vsControl
          ? h(
              'span',
              { class: v.vsControl.probabilityToBeatControl >= 0.95 ? 'good' : '' },
              percent(v.vsControl.probabilityToBeatControl, 0),
            )
          : v === r.variants[0]
            ? 'control'
            : '—',
        v.vsControl
          ? `${percent(v.vsControl.expectedLift, 0)} (${percent(v.vsControl.liftInterval[0], 0)} to ${percent(v.vsControl.liftInterval[1], 0)})`
          : '',
      ]),
      { numeric: [1, 2, 3] },
    ),
    r.excludedMultipleVariants
      ? h(
          'p',
          { class: 'muted' },
          `${count(r.excludedMultipleVariants)} people saw more than one variant and are excluded.`,
        )
      : null,
  );
}

/** Every metric (primary and secondary): each variant's value and how it compares with control. */
function metricsTable(r: ExperimentResult): HTMLElement | null {
  const all: { m: MetricResult; secondary: boolean }[] = [
    ...r.metrics.map((m) => ({ m, secondary: false })),
    ...r.secondary.map((m) => ({ m, secondary: true })),
  ];
  if (!all.length) return null;
  const fmt = (m: MetricResult, v: number) =>
    m.kind === 'conversion' || m.kind === 'funnel' || m.kind === 'retention'
      ? percent(v, 1)
      : decimal(v);
  // Each metric's bars share a scale (its widest interval, at most ±200%).
  const spanOf = (m: MetricResult) =>
    Math.min(
      2,
      Math.max(
        0.1,
        ...m.variants.flatMap((v) => (v.vsControl ? v.vsControl.liftInterval.map(Math.abs) : [])),
      ),
    );
  const frequentist = r.engine === 'frequentist';
  return table(
    [
      'Metric',
      'Variant',
      'Value',
      `${Math.round(r.confidence * 100)}% interval`,
      'Lift vs control',
      frequentist ? 'p-value' : 'Chance to beat control',
      'Chance to be best',
    ],
    all.flatMap(({ m, secondary }) =>
      m.variants.map((v, i) => {
        const better = v.vsControl
          ? m.goal === 'decrease'
            ? -v.vsControl.expectedLift
            : v.vsControl.expectedLift
          : 0;
        return [
          i === 0
            ? h(
                'div',
                { class: 'metric-cell' },
                h('strong', {}, m.name),
                h(
                  'span',
                  { class: 'muted small' },
                  `${secondary ? 'Guardrail' : 'Primary'} · ${m.goal === 'decrease' ? 'lower is better' : 'higher is better'}`,
                ),
                m.significantVariant
                  ? h('span', { class: 'badge good' }, `${m.significantVariant} wins`)
                  : null,
              )
            : '',
          h(
            'span',
            { class: 'nowrap' },
            v.variant,
            i === 0 ? h('span', { class: 'muted small' }, ' (control)') : null,
          ),
          fmt(m, v.value),
          h(
            'span',
            { class: 'nowrap muted' },
            `${fmt(m, v.interval[0])} – ${fmt(m, v.interval[1])}`,
          ),
          v.vsControl
            ? h(
                'div',
                { class: 'lift-cell' },
                h(
                  'strong',
                  { class: better > 0.005 ? 'good' : better < -0.005 ? 'bad' : '' },
                  `${v.vsControl.expectedLift >= 0 ? '+' : ''}${percent(v.vsControl.expectedLift, 1)}`,
                ),
                liftBar(
                  v.vsControl.liftInterval[0],
                  v.vsControl.liftInterval[1],
                  v.vsControl.expectedLift,
                  spanOf(m),
                ),
              )
            : h('span', { class: 'muted' }, '—'),
          v.vsControl
            ? frequentist
              ? v.vsControl.pValue < 0.001
                ? '< 0.001'
                : decimal(v.vsControl.pValue, 3)
              : percent(v.vsControl.probabilityToBeatControl, 0)
            : '',
          v.exposures ? percent(v.probabilityToBeBest, 0) : '—',
        ];
      }),
    ),
    { numeric: [2, 5, 6], class: 'metrics-table' },
  );
}

const STATUS_NOTE: Record<ExperimentResult['status'], string> = {
  winner: '',
  no_winner_yet: 'No variant is ahead with enough confidence yet.',
  too_early: 'Too early to call: wait for the minimum runtime and exposures.',
  srm: 'Variants got unexpectedly different traffic: check assignment and exposure tracking before trusting results.',
  no_data: 'No exposures yet: start the experiment and read the flag in your code.',
};

function timelinePanel(r: ExperimentResult): HTMLElement | null {
  const m = r.metrics[0];
  if (!m?.timeline || m.timeline.days.length < 2) return null;
  const fmt = (v: number) =>
    m.kind === 'conversion' || m.kind === 'funnel' || m.kind === 'retention'
      ? percent(v, 1)
      : decimal(v);
  return panel(
    'Over time',
    lineChart(
      m.timeline.days,
      Object.entries(m.timeline.variants).map(([variant, values]) => ({ label: variant, values })),
      'day',
      { height: 220, format: fmt },
    ),
    { icon: 'insights', subtitle: `${m.name}, cumulative by day` },
  );
}

function settingsForm(e: Experiment, holdouts: Holdout[]): HTMLElement {
  const project = scope().project;
  const primary: Metric[] = structuredClone(
    e.metrics.length
      ? e.metrics
      : e.goal
        ? [{ kind: 'conversion', event: e.goal.event }]
        : [{ kind: 'conversion', event: '' }],
  );
  const secondary: Metric[] = structuredClone(e.secondary ?? []);
  const state = {
    engine: e.engine ?? 'bayesian',
    confidence: e.confidence ?? 0.95,
    minimumDays: e.minimumDays ?? 7,
  };
  const hypothesis = h('input', { type: 'text', value: e.hypothesis });
  const holdout = holdoutSelect(holdouts, e.holdout);
  const error = h('div', {});
  const form = h(
    'form',
    { class: 'stack wide-stack' },
    h('label', { class: 'field' }, h('span', {}, 'Hypothesis'), hypothesis),
    h(
      'div',
      { class: 'field' },
      h('span', {}, 'Primary metrics'),
      metricsEditor(primary, project, { min: 1, addLabel: 'Add a primary metric' }),
    ),
    h(
      'div',
      { class: 'field' },
      h('span', {}, 'Secondary metrics'),
      metricsEditor(secondary, project, { addLabel: 'Add a guardrail' }),
    ),
    h('div', { class: 'field' }, h('span', {}, 'Statistics'), statsControls(state)),
    h('label', { class: 'field' }, h('span', {}, 'Holdout'), holdout),
    error,
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'primary' }, 'Save')),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api.patch(`/api/experiments/${encodeURIComponent(e.key)}`, {
        project,
        hypothesis: hypothesis.value,
        metrics: completeMetrics(primary),
        secondary: completeMetrics(secondary),
        engine: state.engine,
        confidence: state.confidence,
        minimumDays: state.minimumDays,
        holdout: holdout.value || null,
      });
      toast('Experiment updated');
      go(`experiments/${encodeURIComponent(e.key)}`, { t: String(Date.now()) });
    } catch (err) {
      mount(error, errorState(err));
    }
  });
  return form;
}

function detail(key: string): Node[] {
  const project = scope().project;
  return [
    later(async () => {
      const [r, { holdouts }] = await Promise.all([
        api.get<{ experiment: Experiment; results: ExperimentResult }>(
          `/api/experiments/${encodeURIComponent(key)}`,
          { project },
        ),
        api.get<{ holdouts: Holdout[] }>('/api/holdouts', { project }),
      ]);
      const e = r.experiment;
      const act = async (action: string, variant?: string) => {
        try {
          await api.post(`/api/experiments/${encodeURIComponent(key)}/${action}`, {
            project,
            variant,
          });
          const done: Record<string, string> = {
            start: 'Experiment started',
            pause: 'Paused: everyone gets the default experience',
            resume: 'Resumed',
            stop: 'Stopped: results are frozen',
            ship: `Shipped ${variant}`,
            reset: 'Reset to draft: it counts afresh from the next start',
            archive: 'Archived',
            unarchive: 'Unarchived',
          };
          toast(done[action] ?? 'Done');
          go(`experiments/${encodeURIComponent(key)}`, { t: String(Date.now()) });
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'error');
        }
      };
      const button = (label: string, action: string, cls = '') =>
        h('button', { type: 'button', class: cls, onclick: () => act(action) }, label);
      const duplicate = h(
        'button',
        {
          type: 'button',
          onclick: async () => {
            const newKey = prompt('Key of the copy (also its new flag):', `${key}-2`);
            if (!newKey) return;
            try {
              await api.post(`/api/experiments/${encodeURIComponent(key)}/duplicate`, {
                project,
                newKey,
              });
              toast('Duplicated');
              go(`experiments/${encodeURIComponent(newKey)}`);
            } catch (err) {
              toast(err instanceof Error ? err.message : String(err), 'error');
            }
          },
        },
        'Duplicate',
      );
      const ship = ['running', 'paused', 'stopped'].includes(e.status)
        ? r.results.variants.map((v) =>
            h(
              'button',
              { type: 'button', onclick: () => act('ship', v.variant) },
              `Ship ${v.variant}`,
            ),
          )
        : [];
      const actions = [
        e.status === 'draft' ? button('Start experiment', 'start', 'primary') : null,
        e.status === 'running' ? button('Pause', 'pause') : null,
        e.status === 'paused' ? button('Resume', 'resume', 'primary') : null,
        e.status === 'running' || e.status === 'paused' ? button('Stop', 'stop') : null,
        e.status === 'stopped' ? button('Restart', 'start') : null,
        ship,
        ['stopped', 'shipped', 'paused'].includes(e.status) ? button('Reset', 'reset') : null,
        e.status === 'shipped' || e.status === 'stopped' ? button('Archive', 'archive') : null,
        e.status === 'archived' ? button('Unarchive', 'unarchive') : null,
        duplicate,
      ];
      const note = STATUS_NOTE[r.results.status];
      return [
        pageHeader(
          e.key,
          e.hypothesis || firstGoal(e),
          copyButton(
            `if (glass.flag('${e.flag}') === 'test') {\n  // show the new variant\n}`,
            'Copy code',
          ),
        ),
        h(
          'p',
          { class: 'muted experiment-meta' },
          statusBadge(e.status),
          ' Flag ',
          h('a', { href: href(`flags/${encodeURIComponent(e.flag)}`) }, e.flag),
          ` · ${r.results.engine === 'frequentist' ? 'Frequentist' : 'Bayesian'}, ${Math.round(r.results.confidence * 100)}% confidence`,
          e.holdout ? ` · holdout ${e.holdout}` : '',
          e.startedAt ? ` · started ${dateTime(e.startedAt)}` : '',
          e.shippedVariant ? ` · shipped ${e.shippedVariant}` : '',
        ),
        h('div', { class: 'page-actions experiment-actions' }, actions),
        note
          ? h(
              'div',
              { class: `notice ${r.results.status === 'srm' ? 'bad' : ''}` },
              icon(r.results.status === 'srm' ? 'alert' : 'clock', 16),
              h('span', {}, note),
            )
          : null,
        panel('Results', results(r.results), { sql: r.results.sql, icon: 'flask' }),
        (() => {
          const t = metricsTable(r.results);
          return t
            ? panel('All metrics', t, {
                icon: 'gauge',
                subtitle: 'Guardrails are reported but never decide the winner',
              })
            : null;
        })(),
        timelinePanel(r.results),
        panel('Settings', settingsForm(e, holdouts), { icon: 'settings' }),
      ];
    }),
  ];
}

function holdoutsPanel(): HTMLElement {
  const project = scope().project;
  return later(async () => {
    const { holdouts } = await api.get<{ holdouts: Holdout[] }>('/api/holdouts', { project });
    const key = h('input', { type: 'text', placeholder: 'q1-holdout', required: true });
    const pct = h('input', { type: 'number', min: 1, max: 50, value: 10, class: 'short' });
    const error = h('div', {});
    const form = h(
      'form',
      { class: 'row' },
      key,
      pct,
      h('span', { class: 'muted small' }, '% kept out'),
      h('button', { type: 'submit' }, 'Create holdout'),
    );
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        await api.put(`/api/holdouts/${encodeURIComponent(key.value)}`, {
          project,
          percentage: Number(pct.value),
        });
        toast('Holdout created: choose it when creating experiments');
        go('experiments', { t: String(Date.now()) });
      } catch (err) {
        mount(error, errorState(err));
      }
    });
    return panel(
      'Holdouts',
      [
        holdouts.length
          ? table(
              ['Holdout', 'Kept out', 'Experiments', ''],
              holdouts.map((ho) => [
                h('strong', {}, ho.name),
                `${ho.percentage}%`,
                ho.experiments.length
                  ? ho.experiments.map((x) => x.key).join(', ')
                  : h('span', { class: 'muted' }, 'none yet'),
                h(
                  'a',
                  { href: href(`experiments/holdouts/${encodeURIComponent(ho.key)}`) },
                  'Results',
                ),
              ]),
            )
          : h(
              'p',
              { class: 'muted' },
              'A holdout keeps a share of people out of every experiment that uses it, to measure the combined effect of everything you ship.',
            ),
        form,
        error,
      ],
      { icon: 'layers' },
    );
  });
}

function holdoutDetail(key: string): Node[] {
  return [
    later(async () => {
      const r = await api.get<{ holdout: Holdout; results: ExperimentResult; summary: string }>(
        `/api/holdouts/${encodeURIComponent(key)}/results`,
        { project: scope().project },
      );
      return [
        pageHeader(
          r.holdout.name,
          `${r.holdout.percentage}% of people kept out of every experiment using it, compared with everyone else.`,
        ),
        panel('Holdout vs experiments', results(r.results), {
          icon: 'layers',
          subtitle: r.summary,
          sql: r.results.sql,
        }),
        (() => {
          const t = metricsTable(r.results);
          return t ? panel('All metrics', t, { icon: 'gauge' }) : null;
        })(),
      ];
    }),
  ];
}

export function experimentsPage(route: Route): Node[] {
  const project = scope().project;
  const target = route.rest[0];
  if (target === 'holdouts' && route.rest[1]) return holdoutDetail(route.rest[1]);
  if (target === 'new')
    return [
      pageHeader(
        'New experiment',
        'Pick what it measures, how sure it must be, and (optionally) the page changes to test without code.',
      ),
      later(async () => {
        const { holdouts } = await api.get<{ holdouts: Holdout[] }>('/api/holdouts', { project });
        return createForm(holdouts);
      }),
    ];
  if (target) return detail(target);
  const archived = route.params.get('archived') === '1';
  return [
    pageHeader(
      'Experiments',
      'A/B tests on top of flags. Results update as exposures and conversions arrive.',
      h(
        'a',
        { class: 'button primary', href: href('experiments/new') },
        icon('plus', 15),
        'New experiment',
      ),
    ),
    h(
      'div',
      { class: 'toolbar' },
      toggle({
        checked: archived,
        label: 'Show archived',
        onChange: (c) => go('experiments', { archived: c ? '1' : null }),
      }),
    ),
    later(
      async () => {
        const { experiments } = await api.get<{ experiments: Experiment[] }>('/api/experiments', {
          project,
          include_archived: archived ? 'true' : undefined,
        });
        if (experiments.length === 0) {
          return empty(
            'Create one here, or ask your agent to use create_experiment.',
            h(
              'a',
              { class: 'button primary', href: href('experiments/new') },
              icon('plus', 15),
              'New experiment',
            ),
            { icon: 'flask', title: 'No experiments yet' },
          );
        }
        return h(
          'div',
          { class: 'experiment-list' },
          experiments.map((e) => {
            const preview = h(
              'div',
              { class: 'experiment-preview' },
              h('span', { class: 'sk', style: 'width:60%;height:12px' }),
            );
            void api
              .get<{ results: ExperimentResult }>(`/api/experiments/${encodeURIComponent(e.key)}`, {
                project,
              })
              .then(({ results: r }) => {
                const m = r.metrics[0];
                const exposed = m ? m.variants.reduce((n, v) => n + v.exposures, 0) : 0;
                const best = m?.variants
                  .filter((v) => v.vsControl)
                  .sort(
                    (a, b) =>
                      b.vsControl!.probabilityToBeatControl - a.vsControl!.probabilityToBeatControl,
                  )[0];
                const bits: Child[] = [h('span', {}, h('strong', {}, count(exposed)), ' exposed')];
                if (best?.vsControl) {
                  bits.push(
                    h(
                      'span',
                      {},
                      h(
                        'strong',
                        { class: best.vsControl.expectedLift >= 0 ? 'good' : 'bad' },
                        `${best.vsControl.expectedLift >= 0 ? '+' : ''}${percent(best.vsControl.expectedLift, 1)}`,
                      ),
                      ` lift for ${best.variant}`,
                    ),
                    h(
                      'span',
                      { class: 'experiment-chance' },
                      h(
                        'span',
                        { class: 'meter' },
                        h('span', {
                          style: `width:${best.vsControl.probabilityToBeatControl * 100}%`,
                        }),
                      ),
                      `${percent(best.vsControl.probabilityToBeatControl, 0)} to beat control`,
                    ),
                  );
                }
                if (r.winner) bits.push(h('span', { class: 'badge good' }, `Winner: ${r.winner}`));
                mount(preview, bits);
              })
              .catch(() =>
                mount(preview, h('span', { class: 'muted small' }, 'Results unavailable')),
              );
            return h(
              'a',
              { class: 'experiment-row', href: href(`experiments/${encodeURIComponent(e.key)}`) },
              h(
                'div',
                { class: 'experiment-main' },
                h(
                  'div',
                  { class: 'experiment-title' },
                  h('strong', {}, e.key),
                  statusBadge(e.status),
                ),
                h('div', { class: 'muted small' }, e.hypothesis || firstGoal(e)),
              ),
              h(
                'div',
                { class: 'experiment-goal' },
                h('span', { class: 'muted small' }, 'Measures'),
                h(
                  'span',
                  { class: 'event-pill' },
                  e.metrics[0] ? describeMetric(e.metrics[0]) : (e.goal?.event ?? '—'),
                ),
              ),
              preview,
              h(
                'div',
                { class: 'experiment-started muted small' },
                e.startedAt ? `Started ${dateTime(e.startedAt)}` : 'Not started',
              ),
            );
          }),
        );
      },
      'Loading experiments',
      'table',
    ),
    h('div', { class: 'section-gap' }, holdoutsPanel()),
  ];
}
