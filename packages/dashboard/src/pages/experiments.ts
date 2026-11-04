/**
 * Experiments: list, create, and the results readout.
 */

import type { ExperimentResult } from '@glassanalytics/core/insights/experiment';
import { api } from '../api.ts';
import { kpiStat } from '../components/charts.ts';
import { icon } from '../components/icons.ts';
import {
  copyButton,
  empty,
  errorState,
  later,
  pageHeader,
  panel,
  table,
  toast,
} from '../components/ui.ts';
import { type Child, h, mount } from '../dom.ts';
import { count, dateTime, percent } from '../format.ts';
import { go, href, type Route, scope } from '../state.ts';

interface Experiment {
  key: string;
  flag: string;
  status: 'draft' | 'running' | 'stopped' | 'shipped';
  goal: { event: string; value?: string };
  hypothesis: string;
  startedAt: number | null;
  shippedVariant: string | null;
  createdAt: number;
}

function createForm(): HTMLElement {
  const key = h('input', { type: 'text', required: true, placeholder: 'pricing-page-v2' });
  const goal = h('input', { type: 'text', required: true, placeholder: 'signup_completed' });
  const hypothesis = h('input', {
    type: 'text',
    placeholder: 'Showing annual pricing first increases signups',
  });
  const error = h('div', {});
  const form = h(
    'form',
    { class: 'stack' },
    h('label', { class: 'field' }, h('span', {}, 'Key (also the flag key)'), key),
    h('label', { class: 'field' }, h('span', {}, 'Goal event'), goal),
    h('label', { class: 'field' }, h('span', {}, 'Hypothesis'), hypothesis),
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
      await api.post('/api/experiments', {
        project: scope().project,
        key: key.value,
        goal: { event: goal.value },
        hypothesis: hypothesis.value || undefined,
      });
      toast('Experiment created');
      go(`experiments/${encodeURIComponent(key.value)}`);
    } catch (err) {
      mount(error, errorState(err));
    }
  });
  return form;
}

const STATUS_LABEL: Record<Experiment['status'], string> = {
  draft: 'Draft',
  running: 'Running',
  stopped: 'Stopped',
  shipped: 'Shipped',
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
          : 'control',
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

function detail(key: string): Node[] {
  const project = scope().project;
  return [
    later(async () => {
      const r = await api.get<{ experiment: Experiment; results: ExperimentResult }>(
        `/api/experiments/${encodeURIComponent(key)}`,
        { project },
      );
      const e = r.experiment;
      const act = async (action: 'start' | 'stop' | 'ship', variant?: string) => {
        try {
          await api.post(`/api/experiments/${encodeURIComponent(key)}/${action}`, {
            project,
            variant,
          });
          toast(
            action === 'ship'
              ? `Shipped ${variant}`
              : action === 'start'
                ? 'Experiment started'
                : 'Experiment stopped',
          );
          go(`experiments/${encodeURIComponent(key)}`, { t: String(Date.now()) });
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'error');
        }
      };
      const actions = [
        e.status === 'draft' || e.status === 'stopped'
          ? h(
              'button',
              { type: 'button', class: 'primary', onclick: () => act('start') },
              e.status === 'draft' ? 'Start experiment' : 'Restart',
            )
          : null,
        e.status === 'running'
          ? h('button', { type: 'button', class: 'ghost', onclick: () => act('stop') }, 'Stop')
          : null,
        e.status !== 'shipped'
          ? r.results.variants.map((v) =>
              h(
                'button',
                { type: 'button', class: 'ghost', onclick: () => act('ship', v.variant) },
                `Ship ${v.variant}`,
              ),
            )
          : null,
      ];
      return [
        pageHeader(
          e.key,
          e.hypothesis || `Goal: ${e.goal.event}`,
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
          `, goal ${e.goal.event}`,
          e.startedAt ? `, started ${dateTime(e.startedAt)}` : '',
          e.shippedVariant ? `, shipped ${e.shippedVariant}` : '',
          '.',
        ),
        h('div', { class: 'page-actions' }, actions),
        panel('Results', results(r.results), { sql: r.results.sql, icon: 'flask' }),
      ];
    }),
  ];
}

export function experimentsPage(route: Route): Node[] {
  const project = scope().project;
  const target = route.rest[0];
  if (target === 'new')
    return [
      pageHeader(
        'New experiment',
        'Glass creates a 50/50 control/test flag with the same key and measures your goal event.',
      ),
      panel('Experiment', createForm(), { icon: 'flask' }),
    ];
  if (target) return detail(target);
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
    later(
      async () => {
        const { experiments } = await api.get<{ experiments: Experiment[] }>('/api/experiments', {
          project,
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
                const exposed = r.variants.reduce((n, v) => n + v.exposures, 0);
                const best = r.variants
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
                h('div', { class: 'muted small' }, e.hypothesis || `Goal: ${e.goal.event}`),
              ),
              h(
                'div',
                { class: 'experiment-goal' },
                h('span', { class: 'muted small' }, 'Goal'),
                h('span', { class: 'event-pill' }, e.goal.event),
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
  ];
}
