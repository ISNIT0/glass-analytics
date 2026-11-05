/**
 * Feature flags: list, create and edit.
 */

import type { FlagDefinition } from '@dataflare/core/flags';
import { api } from '../api.ts';
import { icon } from '../components/icons.ts';
import { toggle } from '../components/menu.ts';
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
import { h, mount } from '../dom.ts';
import { go, href, type Route, scope } from '../state.ts';

function editor(flag: FlagDefinition | null): HTMLElement {
  const project = scope().project;
  const key = h('input', {
    type: 'text',
    value: flag?.key ?? '',
    required: true,
    pattern: '[A-Za-z0-9][A-Za-z0-9_.-]*',
    disabled: Boolean(flag),
    placeholder: 'new-checkout',
  });
  const description = h('input', {
    type: 'text',
    value: flag?.description ?? '',
    placeholder: 'What this flag controls',
  });
  const enabled = h('input', { type: 'checkbox', checked: flag?.enabled ?? true });
  const rollout = h('input', {
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    value: flag?.rollout ?? 100,
  });
  const rolloutValue = h('output', {}, `${flag?.rollout ?? 100}%`);
  rollout.addEventListener('input', () => {
    rolloutValue.textContent = `${rollout.value}%`;
  });
  const variants = h('input', {
    type: 'text',
    value: (flag?.variants ?? []).map((v) => `${v.key}:${v.weight}`).join(', '),
    placeholder: 'control:50, test:50 (leave empty for on/off)',
  });
  const rules = h(
    'textarea',
    {
      rows: 5,
      spellcheck: false,
      placeholder: '[{"conditions":[{"property":"person.plan","value":"pro"}],"rollout":100}]',
    },
    flag?.rules?.length ? JSON.stringify(flag.rules, null, 2) : '',
  );
  const error = h('div', {});
  const form = h(
    'form',
    { class: 'stack' },
    h('label', { class: 'field' }, h('span', {}, 'Key'), key),
    h('label', { class: 'field' }, h('span', {}, 'Description'), description),
    h(
      'label',
      { class: 'toggle' },
      enabled,
      h(
        'span',
        { class: 'toggle-track', 'aria-hidden': 'true' },
        h('span', { class: 'toggle-thumb' }),
      ),
      h('span', { class: 'toggle-label' }, 'Enabled'),
    ),
    h(
      'label',
      { class: 'field' },
      h('span', {}, 'Rollout'),
      h('div', { class: 'range' }, rollout, rolloutValue),
    ),
    h('label', { class: 'field' }, h('span', {}, 'Variants'), variants),
    h(
      'label',
      { class: 'field' },
      h('span', {}, 'Targeting rules (JSON, first match wins)'),
      rules,
    ),
    error,
    h(
      'div',
      { class: 'form-actions' },
      h('button', { type: 'submit', class: 'primary' }, flag ? 'Save changes' : 'Create flag'),
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const parsedVariants = variants.value.trim()
        ? variants.value.split(',').map((part) => {
            const [k, w] = part.trim().split(':');
            return { key: k!.trim(), weight: Number(w ?? 1) };
          })
        : [];
      const body = {
        project,
        description: description.value || undefined,
        enabled: enabled.checked,
        rollout: Number(rollout.value),
        variants: parsedVariants.length ? parsedVariants : undefined,
        rules: rules.value.trim() ? JSON.parse(rules.value) : [],
      };
      await api.put(`/api/flags/${encodeURIComponent(key.value)}`, body);
      toast(flag ? 'Flag saved' : 'Flag created');
      go('flags');
    } catch (err) {
      mount(error, errorState(err));
    }
  });
  return form;
}

export function flagsPage(route: Route): Node[] {
  const project = scope().project;
  const target = route.rest[0];
  if (target === 'new')
    return [
      pageHeader(
        'New flag',
        'Ship code dark, then roll it out by percentage or to people who match a rule.',
      ),
      panel('Definition', editor(null), { icon: 'flag' }),
    ];
  if (target) {
    return [
      pageHeader(
        target,
        'Read it in code with glass.flag(key): "on", a variant key, or null.',
        copyButton(`glass.flag('${target}')`, 'Copy code'),
      ),
      later(async () => {
        const { flag } = await api.get<{ flag: FlagDefinition }>(
          `/api/flags/${encodeURIComponent(target)}`,
          { project },
        );
        return panel('Definition', editor(flag), { icon: 'flag' });
      }),
    ];
  }
  return [
    pageHeader(
      'Flags',
      'Feature flags, evaluated in your Worker. Assignment is stable per device.',
      h('a', { class: 'button primary', href: href('flags/new') }, icon('plus', 15), 'New flag'),
    ),
    later(
      async () => {
        const { flags } = await api.get<{ flags: FlagDefinition[] }>('/api/flags', { project });
        if (flags.length === 0) {
          return empty(
            'Create one here, or ask your agent to use the save_flag tool.',
            h(
              'a',
              { class: 'button primary', href: href('flags/new') },
              icon('plus', 15),
              'New flag',
            ),
            { icon: 'flag', title: 'No flags yet' },
          );
        }
        const on = flags.filter((f) => f.enabled).length;
        return panel(
          `${flags.length} ${flags.length === 1 ? 'flag' : 'flags'}`,
          table(
            ['Flag', 'Enabled', 'Rollout', 'Variants', 'Targeting'],
            flags.map((f) => [
              h(
                'a',
                { class: 'flag-cell', href: href(`flags/${encodeURIComponent(f.key)}`) },
                h('span', { class: 'flag-key' }, f.key),
                f.description ? h('span', { class: 'muted small' }, f.description) : null,
              ),
              toggle({
                checked: f.enabled,
                label: h('span', { class: 'visually-hidden' }, `${f.key} enabled`),
                title: f.enabled ? 'On: click to turn off' : 'Off: click to turn on',
                onChange: async (checked) => {
                  try {
                    await api.put(`/api/flags/${encodeURIComponent(f.key)}`, {
                      project,
                      description: f.description || undefined,
                      enabled: checked,
                      rollout: f.rollout,
                      variants: f.variants?.length ? f.variants : undefined,
                      rules: f.rules ?? [],
                    });
                    toast(`${f.key} turned ${checked ? 'on' : 'off'}`);
                    go('flags', { t: String(Date.now()) });
                  } catch (err) {
                    toast(err instanceof Error ? err.message : String(err), 'error');
                    go('flags', { t: String(Date.now()) });
                  }
                },
              }),
              h(
                'div',
                { class: 'rollout' },
                h(
                  'div',
                  { class: 'meter' },
                  h('span', { style: `width:${f.enabled ? f.rollout : 0}%` }),
                ),
                h('span', { class: 'num' }, `${f.rollout}%`),
              ),
              h(
                'span',
                { class: 'chip-list' },
                (f.variants?.length ? f.variants.map((v) => v.key) : ['on', 'off']).map((v) =>
                  h('span', { class: 'value-pill' }, v),
                ),
              ),
              f.rules?.length
                ? h(
                    'span',
                    { class: 'badge' },
                    `${f.rules.length} ${f.rules.length === 1 ? 'rule' : 'rules'}`,
                  )
                : h('span', { class: 'muted' }, 'Everyone'),
            ]),
            { class: 'flags-table' },
          ),
          { icon: 'flag', subtitle: `${on} on, ${flags.length - on} off` },
        );
      },
      'Loading flags',
      'table',
    ),
  ];
}
