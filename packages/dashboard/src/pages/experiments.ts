/**
 * Experiments: list, create, and the results readout.
 */

import type { ExperimentResult } from '@glass/core/insights/experiment';
import { api } from '../api.ts';
import { copyButton, empty, errorState, later, pageHeader, panel, table, toast } from '../components/ui.ts';
import { h, mount } from '../dom.ts';
import { count, dateTime, percent } from '../format.ts';
import { type Route, go, href, scope } from '../state.ts';

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
  const hypothesis = h('input', { type: 'text', placeholder: 'Showing annual pricing first increases signups' });
  const error = h('div', {});
  const form = h(
    'form',
    { class: 'stack' },
    h('label', { class: 'field' }, h('span', {}, 'Key (also the flag key)'), key),
    h('label', { class: 'field' }, h('span', {}, 'Goal event'), goal),
    h('label', { class: 'field' }, h('span', {}, 'Hypothesis'), hypothesis),
    error,
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'primary' }, 'Create experiment')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/experiments', { project: scope().project, key: key.value, goal: { event: goal.value }, hypothesis: hypothesis.value || undefined });
      toast('Experiment created');
      go(`experiments/${encodeURIComponent(key.value)}`);
    } catch (err) {
      mount(error, errorState(err));
    }
  });
  return form;
}

function results(r: ExperimentResult): HTMLElement {
  return h(
    'div',
    {},
    h('p', { class: 'summary' }, r.summary),
    r.srm.mismatch
      ? h('p', { class: 'state error' }, `Sample ratio mismatch (p = ${r.srm.pValue.toExponential(1)}). Exposure tracking or assignment is broken.`)
      : null,
    table(
      ['Variant', 'Exposed', 'Converted', 'Rate', '95% interval', 'Chance to beat control', 'Lift (95% interval)'],
      r.variants.map((v) => [
        h('strong', {}, v.variant),
        count(v.exposures),
        count(v.conversions),
        percent(v.conversionRate),
        `${percent(v.rateInterval[0])} to ${percent(v.rateInterval[1])}`,
        v.vsControl
          ? h('span', { class: v.vsControl.probabilityToBeatControl >= 0.95 ? 'good' : '' }, percent(v.vsControl.probabilityToBeatControl, 0))
          : 'control',
        v.vsControl
          ? `${percent(v.vsControl.expectedLift, 0)} (${percent(v.vsControl.liftInterval[0], 0)} to ${percent(v.vsControl.liftInterval[1], 0)})`
          : '',
      ]),
      { numeric: [1, 2, 3] },
    ),
    r.excludedMultipleVariants
      ? h('p', { class: 'muted' }, `${count(r.excludedMultipleVariants)} people saw more than one variant and are excluded.`)
      : null,
  );
}

function detail(key: string): Node[] {
  const project = scope().project;
  return [
    later(async () => {
      const r = await api.get<{ experiment: Experiment; results: ExperimentResult }>(`/api/experiments/${encodeURIComponent(key)}`, { project });
      const e = r.experiment;
      const act = async (action: 'start' | 'stop' | 'ship', variant?: string) => {
        try {
          await api.post(`/api/experiments/${encodeURIComponent(key)}/${action}`, { project, variant });
          toast(action === 'ship' ? `Shipped ${variant}` : action === 'start' ? 'Experiment started' : 'Experiment stopped');
          go(`experiments/${encodeURIComponent(key)}`, { t: String(Date.now()) });
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'error');
        }
      };
      const actions = [
        e.status === 'draft' || e.status === 'stopped'
          ? h('button', { type: 'button', class: 'primary', onclick: () => act('start') }, e.status === 'draft' ? 'Start experiment' : 'Restart')
          : null,
        e.status === 'running' ? h('button', { type: 'button', class: 'ghost', onclick: () => act('stop') }, 'Stop') : null,
        e.status !== 'shipped'
          ? r.results.variants.map((v) => h('button', { type: 'button', class: 'ghost', onclick: () => act('ship', v.variant) }, `Ship ${v.variant}`))
          : null,
      ];
      return [
        pageHeader(
          e.key,
          e.hypothesis || `Goal: ${e.goal.event}`,
          copyButton(`if (glass.flag('${e.flag}') === 'test') {\n  // show the new variant\n}`, 'Copy code'),
        ),
        h(
          'p',
          { class: 'muted' },
          h('span', { class: `badge ${e.status === 'running' ? 'good' : ''}` }, e.status),
          ' Flag ',
          h('a', { href: href(`flags/${encodeURIComponent(e.flag)}`) }, e.flag),
          `, goal ${e.goal.event}`,
          e.startedAt ? `, started ${dateTime(e.startedAt)}` : '',
          e.shippedVariant ? `, shipped ${e.shippedVariant}` : '',
          '.',
        ),
        h('div', { class: 'page-actions' }, actions),
        panel('Results', results(r.results), { sql: r.results.sql }),
      ];
    }),
  ];
}

export function experimentsPage(route: Route): Node[] {
  const project = scope().project;
  const target = route.rest[0];
  if (target === 'new') return [pageHeader('New experiment'), panel('Experiment', createForm())];
  if (target) return detail(target);
  return [
    pageHeader(
      'Experiments',
      'A/B tests on top of flags. Results update as exposures and conversions arrive.',
      h('a', { class: 'button primary', href: href('experiments/new') }, 'New experiment'),
    ),
    later(async () => {
      const { experiments } = await api.get<{ experiments: Experiment[] }>('/api/experiments', { project });
      if (experiments.length === 0) return empty('No experiments yet. Create one here, or ask your agent to use create_experiment.');
      return table(
        ['Experiment', 'Status', 'Goal', 'Started'],
        experiments.map((e) => [
          h('a', { href: href(`experiments/${encodeURIComponent(e.key)}`) }, e.key),
          h('span', { class: `badge ${e.status === 'running' ? 'good' : ''}` }, e.status),
          e.goal.event,
          e.startedAt ? dateTime(e.startedAt) : 'not started',
        ]),
      );
    }),
  ];
}
