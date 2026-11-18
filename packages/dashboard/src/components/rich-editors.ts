/**
 * Structured editors for configuration that used to be typed as JSON: revenue
 * events, lists of events, transformation rules and flag targeting rules. They
 * use the same event, property and filter pickers as Insights, and edit the
 * objects they're given in place; callers read them back on save.
 */

import { h, mount } from '../dom.ts';
import { type FilterRow, filterEditor } from './filter-editor.ts';
import { icon } from './icons.ts';
import { toggle } from './menu.ts';
import { eventPicker, propertyPicker } from './picker.ts';

/** A <label> wraps one input (clicking the text focuses it); composite editors get a <div>. */
const labelable = (control: unknown) =>
  control instanceof HTMLInputElement ||
  control instanceof HTMLSelectElement ||
  control instanceof HTMLTextAreaElement;

const field = (label: string, control: HTMLElement | HTMLElement[], hint?: string) =>
  h(
    labelable(control) ? 'label' : 'div',
    { class: 'field' },
    h('span', {}, label),
    control,
    hint ? h('small', { class: 'muted' }, hint) : null,
  );

function removeButton(label: string, onClick: () => void): HTMLElement {
  return h(
    'button',
    {
      type: 'button',
      class: 'icon-button push-right',
      'aria-label': label,
      title: label,
      onclick: onClick,
    },
    icon('x', 14),
  );
}

function addButton(label: string, onClick: () => void): HTMLElement {
  return h(
    'button',
    { type: 'button', class: 'link-button add-button', onclick: onClick },
    icon('plus', 14),
    label,
  );
}

// ── Revenue events ─────────────────────────────────────────────────────────

export interface RevenueRule {
  event: string;
  amountProperty: string;
  currencyProperty?: string;
  currency?: string;
  productProperty?: string;
  subscriptionProperty?: string;
  interval?: 'month' | 'year';
  kind?: 'sale' | 'refund';
}

/** Strip "props." for storage: revenue rules name event properties directly. */
const bare = (p: string) => p.replace(/^props\./, '');

export function revenueEventsEditor(rules: RevenueRule[], project?: string): HTMLElement {
  const root = h('div', { class: 'rich-list' });
  const paint = () => {
    mount(
      root,
      rules.map((r, i) => {
        const card = h('div', { class: 'query-card rich-card' });
        const props = (value: string | undefined, placeholder: string, set: (v: string) => void) =>
          propertyPicker({
            value: value ?? '',
            event: r.event,
            project,
            columns: false,
            person: false,
            placeholder,
            onChange: (v) => {
              set(bare(v));
              paint();
            },
          });
        const currencyMode = r.currencyProperty ? 'property' : 'fixed';
        const fixed = h('input', {
          type: 'text',
          value: r.currency ?? '',
          maxlength: 3,
          placeholder: 'e.g. GBP',
          class: 'short',
        });
        fixed.addEventListener('change', () => {
          r.currency = fixed.value.trim().toUpperCase() || undefined;
        });
        const mode = h(
          'select',
          { class: 'short-select' },
          h('option', { value: 'fixed', selected: currencyMode === 'fixed' }, 'Always'),
          h(
            'option',
            { value: 'property', selected: currencyMode === 'property' },
            'From property',
          ),
        );
        mode.addEventListener('change', () => {
          if (mode.value === 'fixed') delete r.currencyProperty;
          else r.currencyProperty = r.currencyProperty ?? 'currency';
          paint();
        });
        const kind = h(
          'select',
          { class: 'short-select' },
          h('option', { value: 'sale', selected: r.kind !== 'refund' }, 'Payment'),
          h('option', { value: 'refund', selected: r.kind === 'refund' }, 'Refund'),
        );
        kind.addEventListener('change', () => {
          if (kind.value === 'refund') r.kind = 'refund';
          else delete r.kind;
        });
        const interval = h(
          'select',
          { class: 'short-select' },
          h('option', { value: 'month', selected: r.interval !== 'year' }, 'billed monthly'),
          h('option', { value: 'year', selected: r.interval === 'year' }, 'billed yearly'),
        );
        interval.addEventListener('change', () => {
          if (interval.value === 'year') r.interval = 'year';
          else delete r.interval;
        });
        mount(
          card,
          h(
            'div',
            { class: 'query-card-head' },
            eventPicker({
              value: r.event,
              project,
              label: 'Event',
              placeholder: 'Event that carries money',
              onChange: (v) => {
                r.event = v;
                paint();
              },
            }),
            kind,
            removeButton('Remove revenue event', () => {
              rules.splice(i, 1);
              paint();
            }),
          ),
          h(
            'div',
            { class: 'rich-grid' },
            field(
              'Amount',
              props(r.amountProperty, 'Property with the amount', (v) => (r.amountProperty = v)),
            ),
            field(
              'Currency',
              h(
                'div',
                { class: 'row' },
                mode,
                currencyMode === 'property'
                  ? props(
                      r.currencyProperty,
                      'Property with the ISO code',
                      (v) => (r.currencyProperty = v),
                    )
                  : fixed,
              ),
            ),
            field(
              'Product (optional)',
              props(
                r.productProperty,
                'Property naming the product or plan',
                (v) => (r.productProperty = v || undefined),
              ),
            ),
            field(
              'Subscription (optional, for MRR)',
              h(
                'div',
                { class: 'row' },
                props(
                  r.subscriptionProperty,
                  'Property with the subscription id',
                  (v) => (r.subscriptionProperty = v || undefined),
                ),
                r.subscriptionProperty ? interval : null,
              ),
            ),
          ),
        );
        return card;
      }),
      addButton('Add revenue event', () => {
        rules.push({ event: '', amountProperty: '' });
        paint();
      }),
    );
  };
  paint();
  return root;
}

/** Rules with an event and amount, ready to save. */
export function completeRevenueRules(rules: RevenueRule[]): RevenueRule[] {
  return rules
    .filter((r) => r.event && r.amountProperty)
    .map(
      (r) =>
        Object.fromEntries(
          Object.entries(r).filter(([, v]) => v !== undefined && v !== ''),
        ) as unknown as RevenueRule,
    );
}

// ── Event lists ────────────────────────────────────────────────────────────

/** Pick events one by one, or "all events" (stored as ["*"]). */
export function eventListEditor(
  events: string[],
  project?: string,
  options: { allLabel?: string; allToggle?: boolean } = {},
): HTMLElement {
  const root = h('div', { class: 'rich-list' });
  const paint = () => {
    const all = events.includes('*');
    mount(
      root,
      options.allToggle === false
        ? null
        : toggle({
            checked: all,
            label: options.allLabel ?? 'All events',
            onChange: (c) => {
              events.splice(0, events.length, ...(c ? ['*'] : []));
              paint();
            },
          }),
      all
        ? null
        : [
            events.map((e, i) =>
              h(
                'div',
                { class: 'row' },
                eventPicker({
                  value: e,
                  project,
                  label: `Event ${i + 1}`,
                  onChange: (v) => {
                    events[i] = v;
                    paint();
                  },
                }),
                removeButton('Remove event', () => {
                  events.splice(i, 1);
                  paint();
                }),
              ),
            ),
            addButton('Add event', () => {
              events.push('');
              paint();
            }),
          ],
    );
  };
  paint();
  return root;
}

// ── Transformation rules ───────────────────────────────────────────────────

type Rule = Record<string, unknown> & { kind: string };

const KINDS: [string, string, string][] = [
  [
    'redact',
    'Redact personal data',
    'Replace emails, phone numbers, card numbers or IPs in properties, URLs and titles.',
  ],
  [
    'hash_properties',
    'Hash properties',
    'Replace values with a salted SHA-256: still joinable, not readable.',
  ],
  ['drop_properties', 'Drop properties', 'Remove properties before anything is stored.'],
  ['rename_property', 'Rename a property', 'Fix a property name without a deploy.'],
  ['set_property', 'Set a property', 'Add or overwrite a property with a fixed value.'],
  ['drop_event', 'Drop events', 'Discard matching events entirely.'],
];

function propertyList(
  list: string[],
  project: string | undefined,
  onChange: () => void,
  person: boolean,
): HTMLElement {
  const root = h('div', { class: 'rich-list' });
  const paint = () =>
    mount(
      root,
      list.map((p, i) =>
        h(
          'div',
          { class: 'row' },
          propertyPicker({
            value: p,
            project,
            columns: false,
            person,
            placeholder: 'Property, or /regex/ of names',
            onChange: (v) => {
              list[i] = v;
              onChange();
              paint();
            },
          }),
          removeButton('Remove property', () => {
            list.splice(i, 1);
            onChange();
            paint();
          }),
        ),
      ),
      addButton('Add property', () => {
        list.push('');
        paint();
      }),
    );
  paint();
  return root;
}

/** Edit one transformation rule; `rule` is replaced in place when the kind changes. */
export function transformationRuleEditor(rule: Rule, project?: string): HTMLElement {
  const root = h('div', { class: 'stack' });
  const paint = () => {
    const kind = h(
      'select',
      {},
      KINDS.map(([k, label]) => h('option', { value: k, selected: k === rule.kind }, label)),
    );
    kind.addEventListener('change', () => {
      for (const k of Object.keys(rule))
        if (!['events', 'filters', 'name'].includes(k)) delete rule[k];
      rule.kind = kind.value;
      if (kind.value === 'redact') rule.patterns = ['email', 'phone'];
      paint();
    });
    const events = (rule.events as string[] | undefined) ?? [];
    rule.events = events;
    if (!Array.isArray(rule.filters)) rule.filters = [];
    const filters = rule.filters as FilterRow[];
    const specific: HTMLElement[] = [];
    if (rule.kind === 'drop_properties' || rule.kind === 'hash_properties') {
      if (!Array.isArray(rule.properties)) rule.properties = [''];
      const list = rule.properties as string[];
      specific.push(
        field(
          'Properties',
          propertyList(list, project, () => {}, true),
          'Event properties, person.* properties, or /regex/ patterns of names.',
        ),
      );
    }
    if (rule.kind === 'rename_property') {
      specific.push(
        h(
          'div',
          { class: 'grid-2' },
          field(
            'From',
            propertyPicker({
              value: String(rule.from ?? ''),
              project,
              columns: false,
              onChange: (v) => (rule.from = v),
              placeholder: 'Old name',
            }),
          ),
          field(
            'To',
            (() => {
              const to = h('input', {
                type: 'text',
                value: String(rule.to ?? ''),
                placeholder: 'New name',
              });
              to.addEventListener('change', () => (rule.to = to.value.trim()));
              return to;
            })(),
          ),
        ),
      );
    }
    if (rule.kind === 'set_property') {
      const value = h('input', {
        type: 'text',
        value: rule.value === undefined ? '' : String(rule.value),
        placeholder: 'Value',
      });
      value.addEventListener('change', () => {
        const v = value.value;
        rule.value =
          v === 'true'
            ? true
            : v === 'false'
              ? false
              : v !== '' && Number.isFinite(Number(v))
                ? Number(v)
                : v;
      });
      specific.push(
        h(
          'div',
          { class: 'grid-2' },
          field(
            'Property',
            propertyPicker({
              value: String(rule.property ?? ''),
              project,
              columns: false,
              onChange: (v) => (rule.property = v),
              placeholder: 'Property',
            }),
          ),
          field('Value', value),
        ),
      );
    }
    if (rule.kind === 'redact') {
      if (!Array.isArray(rule.patterns)) rule.patterns = ['email', 'phone'];
      const patterns = rule.patterns as string[];
      specific.push(
        field(
          'Find and replace with [redacted]',
          h(
            'div',
            { class: 'row gap-lg' },
            [
              ['email', 'Emails'],
              ['phone', 'Phone numbers'],
              ['credit_card', 'Card numbers'],
              ['ip', 'IP addresses'],
            ].map(([p, label]) =>
              toggle({
                checked: patterns.includes(p!),
                label: label!,
                onChange: (c) => {
                  const i = patterns.indexOf(p!);
                  if (c && i < 0) patterns.push(p!);
                  if (!c && i >= 0) patterns.splice(i, 1);
                },
              }),
            ),
          ),
        ),
      );
    }
    mount(
      root,
      field('Rule', kind, KINDS.find(([k]) => k === rule.kind)?.[2]),
      specific,
      field(
        'Only these events (optional)',
        eventListEditor(events, project, { allToggle: false }),
        'Leave empty to apply it to every event.',
      ),
      field(
        'Only events matching (optional)',
        filterEditor(filters, () => {}, { project }),
      ),
    );
  };
  paint();
  return root;
}

/** The rule as the API expects it: empty parts left out. */
export function cleanTransformationRule(rule: Rule): Rule {
  const out: Rule = { kind: rule.kind };
  for (const [k, v] of Object.entries(rule)) {
    if (k === 'kind' || v === undefined || v === '') continue;
    if (Array.isArray(v)) {
      const list = v.filter(
        (x) => x !== '' && !(typeof x === 'object' && x && !(x as FilterRow).property),
      );
      if (k === 'events' && list.includes('*')) continue;
      if (list.length) out[k] = list;
      continue;
    }
    out[k] = v;
  }
  return out;
}

// ── Flag targeting rules ───────────────────────────────────────────────────

export interface FlagRuleRow {
  conditions: FilterRow[];
  rollout?: number;
  variant?: string;
}

export function flagRulesEditor(
  rules: FlagRuleRow[],
  variants: () => string[],
  project?: string,
): HTMLElement {
  const root = h('div', { class: 'rich-list' });
  const paint = () => {
    mount(
      root,
      rules.map((r, i) => {
        const rollout = h('input', {
          type: 'number',
          min: 0,
          max: 100,
          value: r.rollout ?? 100,
          class: 'short',
        });
        rollout.addEventListener('change', () => {
          r.rollout = Math.max(0, Math.min(100, Number(rollout.value)));
        });
        const names = variants();
        const variant = h(
          'select',
          { class: 'short-select' },
          h('option', { value: '' }, names.length ? 'Usual split' : 'On'),
          names.map((v) => h('option', { value: v, selected: v === r.variant }, `Always ${v}`)),
        );
        variant.addEventListener('change', () => {
          if (variant.value) r.variant = variant.value;
          else delete r.variant;
        });
        return h(
          'div',
          { class: 'query-card rich-card' },
          h(
            'div',
            { class: 'query-card-head' },
            h('span', { class: 'funnel-step-index' }, String(i + 1)),
            h(
              'span',
              { class: 'muted small' },
              i === 0 ? 'If someone matches' : 'Else, if they match',
            ),
            removeButton('Remove rule', () => {
              rules.splice(i, 1);
              paint();
            }),
          ),
          filterEditor(r.conditions, () => {}, { project, cohorts: true }),
          h(
            'div',
            { class: 'row' },
            h('span', { class: 'muted small' }, 'give it to'),
            rollout,
            h('span', { class: 'muted small' }, '% of them:'),
            variant,
          ),
        );
      }),
      addButton('Add rule', () => {
        rules.push({ conditions: [], rollout: 100 });
        paint();
      }),
    );
  };
  paint();
  return root;
}

/** Rules ready to save: conditions with a property, in order. */
export function cleanFlagRules(rules: FlagRuleRow[]) {
  return rules
    .map((r) => ({
      conditions: r.conditions.filter(
        (c) => c.property && (c.value !== undefined || c.op === 'is_set' || c.op === 'is_not_set'),
      ),
      ...(r.rollout !== undefined && r.rollout !== 100 ? { rollout: r.rollout } : {}),
      ...(r.variant ? { variant: r.variant } : {}),
    }))
    .filter((r) => r.conditions.length > 0);
}
