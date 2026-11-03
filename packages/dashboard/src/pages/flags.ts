/**
 * Feature flags: list, create and edit.
 */

import type { FlagDefinition } from '@glassanalytics/core/flags';
import { api } from '../api.ts';
import { copyButton, empty, errorState, later, pageHeader, panel, table, toast } from '../components/ui.ts';
import { h, mount } from '../dom.ts';
import { type Route, go, href, scope } from '../state.ts';

function editor(flag: FlagDefinition | null): HTMLElement {
  const project = scope().project;
  const key = h('input', { type: 'text', value: flag?.key ?? '', required: true, pattern: '[A-Za-z0-9][A-Za-z0-9_.-]*', disabled: Boolean(flag), placeholder: 'new-checkout' });
  const description = h('input', { type: 'text', value: flag?.description ?? '', placeholder: 'What this flag controls' });
  const enabled = h('input', { type: 'checkbox', checked: flag?.enabled ?? true });
  const rollout = h('input', { type: 'range', min: 0, max: 100, step: 1, value: flag?.rollout ?? 100 });
  const rolloutValue = h('output', {}, `${flag?.rollout ?? 100}%`);
  rollout.addEventListener('input', () => {
    rolloutValue.textContent = `${rollout.value}%`;
  });
  const variants = h('input', {
    type: 'text',
    value: (flag?.variants ?? []).map((v) => `${v.key}:${v.weight}`).join(', '),
    placeholder: 'control:50, test:50 (leave empty for on/off)',
  });
  const rules = h('textarea', { rows: 5, spellcheck: false, placeholder: '[{"conditions":[{"property":"person.plan","value":"pro"}],"rollout":100}]' }, flag?.rules?.length ? JSON.stringify(flag.rules, null, 2) : '');
  const error = h('div', {});
  const form = h(
    'form',
    { class: 'stack' },
    h('label', { class: 'field' }, h('span', {}, 'Key'), key),
    h('label', { class: 'field' }, h('span', {}, 'Description'), description),
    h('label', { class: 'switch' }, enabled, 'Enabled'),
    h('label', { class: 'field' }, h('span', {}, 'Rollout'), h('div', { class: 'range' }, rollout, rolloutValue)),
    h('label', { class: 'field' }, h('span', {}, 'Variants'), variants),
    h('label', { class: 'field' }, h('span', {}, 'Targeting rules (JSON, first match wins)'), rules),
    error,
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'primary' }, flag ? 'Save changes' : 'Create flag')),
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
  if (target === 'new') return [pageHeader('New flag'), panel('Definition', editor(null))];
  if (target) {
    return [
      pageHeader(target, 'Read it in code with glass.flag(key): "on", a variant key, or null.', copyButton(`glass.flag('${target}')`, 'Copy code')),
      later(async () => {
        const { flag } = await api.get<{ flag: FlagDefinition }>(`/api/flags/${encodeURIComponent(target)}`, { project });
        return panel('Definition', editor(flag));
      }),
    ];
  }
  return [
    pageHeader('Flags', 'Feature flags, evaluated in your Worker. Assignment is stable per device.', h('a', { class: 'button primary', href: href('flags/new') }, 'New flag')),
    later(async () => {
      const { flags } = await api.get<{ flags: FlagDefinition[] }>('/api/flags', { project });
      if (flags.length === 0) return empty('No flags yet. Create one here, or ask your agent to use the save_flag tool.');
      return table(
        ['Flag', 'Status', 'Rollout', 'Variants', 'Rules'],
        flags.map((f) => [
          h('a', { href: href(`flags/${encodeURIComponent(f.key)}`) }, f.key),
          h('span', { class: `badge ${f.enabled ? 'good' : ''}` }, f.enabled ? 'On' : 'Off'),
          `${f.rollout}%`,
          (f.variants ?? []).map((v) => v.key).join(', ') || 'on/off',
          String(f.rules?.length ?? 0),
        ]),
        { numeric: [2, 4] },
      );
    }),
  ];
}
