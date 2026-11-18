/**
 * Experiment metrics: what decides an experiment (primary) and what it must not
 * hurt (secondary). Each kind gets its own fields, built from the event and
 * property pickers; metrics are edited in place.
 */

import { h, mount } from '../dom.ts';
import { icon } from './icons.ts';
import { eventPicker, propertyPicker } from './picker.ts';

export type Metric = Record<string, unknown> & { kind: string };

const KINDS: [string, string][] = [
  ['conversion', 'Conversion'],
  ['mean', 'Per person (count or sum)'],
  ['ratio', 'Ratio'],
  ['funnel', 'Funnel'],
  ['retention', 'Retention'],
];

/** Set a field to a value, or remove it when the value is empty. */
function setOrDelete(target: Record<string, unknown>, key: string, value: string): void {
  if (value) target[key] = value;
  else delete target[key];
}

const labelable = (control: unknown) =>
  control instanceof HTMLInputElement ||
  control instanceof HTMLSelectElement ||
  control instanceof HTMLTextAreaElement;
const field = (label: string, control: HTMLElement) =>
  h(labelable(control) ? 'label' : 'div', { class: 'field' }, h('span', {}, label), control);

function select(
  value: string,
  options: [string, string][],
  onChange: (v: string) => void,
): HTMLSelectElement {
  const el = h(
    'select',
    { class: 'short-select' },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)),
  );
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function text(
  value: unknown,
  placeholder: string,
  onChange: (v: string) => void,
): HTMLInputElement {
  const el = h('input', {
    type: 'text',
    value: value === undefined ? '' : String(value),
    placeholder,
    class: 'short',
  });
  el.addEventListener('change', () => onChange(el.value.trim()));
  return el;
}

/** One side of a count or sum: an event, and optionally the property summed. */
function amount(
  target: Record<string, unknown>,
  project: string | undefined,
  repaint: () => void,
  label: string,
): HTMLElement {
  return field(
    label,
    h(
      'div',
      { class: 'row' },
      eventPicker({
        value: String(target.event ?? ''),
        project,
        label,
        onChange: (v) => {
          target.event = v;
          repaint();
        },
      }),
      select(
        String(target.math ?? 'count'),
        [
          ['count', 'count'],
          ['sum', 'sum of'],
        ],
        (v) => {
          target.math = v;
          if (v === 'count') delete target.property;
          repaint();
        },
      ),
      target.math === 'sum'
        ? propertyPicker({
            value: String(target.property ?? ''),
            event: String(target.event ?? ''),
            project,
            columns: false,
            person: false,
            placeholder: 'Numeric property',
            onChange: (v) => {
              target.property = v.replace(/^props\./, '');
            },
          })
        : null,
    ),
  );
}

function metricCard(
  m: Metric,
  project: string | undefined,
  onRemove: (() => void) | null,
  repaintAll: () => void,
): HTMLElement {
  const card = h('div', { class: 'query-card rich-card' });
  const paint = () => {
    const fields: HTMLElement[] = [];
    if (m.kind === 'conversion' || m.kind === 'mean' || m.kind === 'retention') {
      fields.push(
        field(
          m.kind === 'retention' ? 'Comes back and does' : 'Event',
          eventPicker({
            value: String(m.event ?? ''),
            project,
            label: 'Metric event',
            onChange: (v) => {
              m.event = v;
              paint();
            },
          }),
        ),
      );
    }
    if (m.kind === 'conversion') {
      fields.push(
        field(
          'Within (optional)',
          text(m.within, 'e.g. 7d', (v) => setOrDelete(m, 'within', v)),
        ),
      );
    }
    if (m.kind === 'mean') {
      fields.push(
        field(
          'Per person',
          h(
            'div',
            { class: 'row' },
            select(
              String(m.math ?? 'count'),
              [
                ['count', 'Times they did it'],
                ['sum', 'Sum of a property'],
              ],
              (v) => {
                m.math = v;
                if (v === 'count') delete m.property;
                paint();
              },
            ),
            m.math === 'sum'
              ? propertyPicker({
                  value: String(m.property ?? ''),
                  event: String(m.event ?? ''),
                  project,
                  columns: false,
                  person: false,
                  placeholder: 'Numeric property',
                  onChange: (v) => {
                    m.property = v.replace(/^props\./, '');
                  },
                })
              : null,
          ),
        ),
        field(
          'Outliers',
          select(
            String((m.winsorize as { upper?: number } | undefined)?.upper ?? ''),
            [
              ['', 'Keep every value'],
              ['99', 'Cap at the 99th percentile'],
              ['95', 'Cap at the 95th percentile'],
            ],
            (v) => {
              if (v) m.winsorize = { upper: Number(v) };
              else delete m.winsorize;
            },
          ),
        ),
      );
    }
    if (m.kind === 'ratio') {
      m.numerator ??= { event: '', math: 'count' };
      m.denominator ??= { event: '', math: 'count' };
      fields.push(
        amount(m.numerator as Record<string, unknown>, project, paint, 'Numerator'),
        amount(m.denominator as Record<string, unknown>, project, paint, 'Denominator'),
      );
    }
    if (m.kind === 'funnel') {
      const steps = (m.steps as { event: string }[] | undefined) ?? [{ event: '' }];
      m.steps = steps;
      fields.push(
        field(
          'Steps after exposure',
          h(
            'div',
            { class: 'rich-list' },
            steps.map((s, i) =>
              h(
                'div',
                { class: 'row' },
                h('span', { class: 'funnel-step-index' }, String(i + 1)),
                eventPicker({
                  value: s.event,
                  project,
                  label: `Step ${i + 1}`,
                  onChange: (v) => {
                    s.event = v;
                    paint();
                  },
                }),
                steps.length > 1
                  ? h(
                      'button',
                      {
                        type: 'button',
                        class: 'icon-button push-right',
                        'aria-label': 'Remove step',
                        onclick: () => {
                          steps.splice(i, 1);
                          paint();
                        },
                      },
                      icon('x', 14),
                    )
                  : null,
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'link-button add-button',
                onclick: () => {
                  steps.push({ event: '' });
                  paint();
                },
              },
              icon('plus', 14),
              'Add step',
            ),
          ),
        ),
        field(
          'Within',
          text(m.window, '7d', (v) => setOrDelete(m, 'window', v)),
        ),
      );
    }
    if (m.kind === 'retention') {
      fields.push(
        field(
          'Between',
          h(
            'div',
            { class: 'row' },
            text(m.from, '1d', (v) => setOrDelete(m, 'from', v)),
            h('span', { class: 'muted small' }, 'and'),
            text(m.to, '8d', (v) => setOrDelete(m, 'to', v)),
            h('span', { class: 'muted small' }, 'after exposure'),
          ),
        ),
      );
    }
    mount(
      card,
      h(
        'div',
        { class: 'query-card-head' },
        select(m.kind, KINDS, (v) => {
          for (const k of Object.keys(m)) if (!['name', 'goal'].includes(k)) delete m[k];
          m.kind = v;
          if (v !== 'ratio' && v !== 'funnel') m.event = '';
          paint();
          repaintAll();
        }),
        select(
          String(m.goal ?? 'increase'),
          [
            ['increase', 'higher is better'],
            ['decrease', 'lower is better'],
          ],
          (v) => {
            if (v === 'decrease') m.goal = 'decrease';
            else delete m.goal;
          },
        ),
        onRemove
          ? h(
              'button',
              {
                type: 'button',
                class: 'icon-button push-right',
                'aria-label': 'Remove metric',
                onclick: onRemove,
              },
              icon('x', 14),
            )
          : null,
      ),
      h('div', { class: 'rich-grid' }, fields),
      field(
        'Name (optional)',
        (() => {
          const input = text(m.name, 'e.g. Checkout conversion', (v) => setOrDelete(m, 'name', v));
          input.classList.remove('short');
          return input;
        })(),
      ),
    );
  };
  paint();
  return card;
}

/** A list of metrics; `min` of them can't be removed. */
export function metricsEditor(
  metrics: Metric[],
  project: string | undefined,
  options: { min?: number; addLabel: string },
): HTMLElement {
  const root = h('div', { class: 'rich-list' });
  const paint = () =>
    mount(
      root,
      metrics.map((m, i) =>
        metricCard(
          m,
          project,
          metrics.length > (options.min ?? 0)
            ? () => {
                metrics.splice(i, 1);
                paint();
              }
            : null,
          () => {},
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'link-button add-button',
          onclick: () => {
            metrics.push({ kind: 'conversion', event: '' });
            paint();
          },
        },
        icon('plus', 14),
        options.addLabel,
      ),
    );
  paint();
  return root;
}

/** Metrics ready to send: the ones with what they need filled in. */
export function completeMetrics(metrics: Metric[]): Metric[] {
  return metrics
    .filter((m) => {
      if (m.kind === 'ratio')
        return Boolean(
          (m.numerator as { event?: string })?.event &&
            (m.denominator as { event?: string })?.event,
        );
      if (m.kind === 'funnel') return ((m.steps as { event: string }[]) ?? []).some((s) => s.event);
      return Boolean(m.event);
    })
    .map((m) =>
      m.kind === 'funnel'
        ? { ...m, steps: (m.steps as { event: string }[]).filter((s) => s.event) }
        : m,
    );
}

/** A metric in a few words, for lists and tables. */
export function describeMetric(m: Metric): string {
  if (m.name) return String(m.name);
  switch (m.kind) {
    case 'conversion':
      return `Did ${m.event}`;
    case 'mean':
      return m.math === 'sum' ? `${m.property} per person` : `${m.event} per person`;
    case 'ratio':
      return `${(m.numerator as { event: string }).event} / ${(m.denominator as { event: string }).event}`;
    case 'funnel':
      return `Funnel: ${((m.steps as { event: string }[]) ?? []).map((s) => s.event).join(' → ')}`;
    case 'retention':
      return `Came back for ${m.event}`;
    default:
      return m.kind;
  }
}
