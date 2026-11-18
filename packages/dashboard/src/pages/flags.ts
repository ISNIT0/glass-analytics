/**
 * Feature flags: list, create and edit.
 */

import type { FlagDefinition } from '@dataflare/core/flags';
import { api } from '../api.ts';
import { lineChart } from '../components/charts.ts';
import { icon } from '../components/icons.ts';
import { knownGroupTypes } from '../components/insight-options.ts';
import { toggle } from '../components/menu.ts';
import { cleanFlagRules, type FlagRuleRow, flagRulesEditor } from '../components/rich-editors.ts';
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
import { ago, dateTime } from '../format.ts';
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
  const ruleRows = structuredClone((flag?.rules ?? []) as FlagRuleRow[]);
  const variantKeys = () =>
    variants.value
      .split(',')
      .map((part) => part.trim().split(':')[0]!.trim())
      .filter(Boolean);
  const rules = flagRulesEditor(ruleRows, variantKeys, project);
  const payloads = h(
    'textarea',
    {
      rows: 3,
      spellcheck: false,
      placeholder: '{"control":{"price":10},"test":{"price":12}}  or  {"on":{"banner":"Hello"}}',
    },
    flag?.payloads ? JSON.stringify(flag.payloads, null, 2) : '',
  );
  const groupTypes = knownGroupTypes(project, () => {
    for (const t of knownGroupTypes(project, () => {}))
      if (![...bucketBy.options].some((o) => o.value === t))
        bucketBy.append(h('option', { value: t }, `${t} (group)`));
  });
  const bucketBy = h(
    'select',
    {},
    [
      ['device', 'Device (default)'],
      ['person', 'Person (same value on every device)'],
      ...groupTypes.map((t) => [t, `${t} (group)`]),
    ].map(([v, label]) =>
      h('option', { value: v, selected: (flag?.bucketBy ?? 'device') === v }, label),
    ),
  );
  if (flag?.bucketBy && ![...bucketBy.options].some((o) => o.value === flag.bucketBy))
    bucketBy.append(h('option', { value: flag.bucketBy, selected: true }, flag.bucketBy));
  let earlyAccess = Boolean(flag?.earlyAccess);
  const eaName = h('input', {
    type: 'text',
    value: flag?.earlyAccess?.name ?? '',
    placeholder: 'New editor',
  });
  const eaDescription = h('input', {
    type: 'text',
    value: flag?.earlyAccess?.description ?? '',
    placeholder: 'What people get by opting in',
  });
  const eaDocs = h('input', {
    type: 'url',
    value: flag?.earlyAccess?.docsUrl ?? '',
    placeholder: 'https://… (optional)',
  });
  const eaStage = h(
    'select',
    {},
    ['concept', 'alpha', 'beta'].map((v) =>
      h('option', { value: v, selected: (flag?.earlyAccess?.stage ?? 'beta') === v }, v),
    ),
  );
  const eaFields = h(
    'div',
    { class: 'stack tight', hidden: !earlyAccess },
    h('label', { class: 'field' }, h('span', {}, 'Name shown to people'), eaName),
    h('label', { class: 'field' }, h('span', {}, 'Description'), eaDescription),
    h(
      'div',
      { class: 'grid-2' },
      h('label', { class: 'field' }, h('span', {}, 'Stage'), eaStage),
      h('label', { class: 'field' }, h('span', {}, 'Docs'), eaDocs),
    ),
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
      'div',
      { class: 'field' },
      h('span', {}, 'Targeting rules (first match wins; everyone else gets the rollout above)'),
      rules,
      h(
        'small',
        { class: 'muted' },
        'Conditions can use person and event properties, group.<type>.<property>, cohort, and flag.<key> (another flag’s value).',
      ),
    ),
    h(
      'label',
      { class: 'field' },
      h('span', {}, 'Payloads (JSON, optional)'),
      payloads,
      h(
        'small',
        { class: 'muted' },
        'Data per value, read with glass.flagPayload(key): copy, prices, config.',
      ),
    ),
    h('label', { class: 'field' }, h('span', {}, 'Same value for the same'), bucketBy),
    toggle({
      checked: earlyAccess,
      label: 'Early access: people can opt in themselves (glass.earlyAccessFeatures())',
      onChange: (c) => {
        earlyAccess = c;
        eaFields.hidden = !c;
      },
    }),
    eaFields,
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
        rules: cleanFlagRules(ruleRows),
        payloads: payloads.value.trim() ? JSON.parse(payloads.value) : null,
        bucketBy: bucketBy.value === 'device' ? null : bucketBy.value,
        earlyAccess:
          earlyAccess && eaName.value.trim()
            ? {
                name: eaName.value.trim(),
                stage: eaStage.value,
                ...(eaDescription.value.trim() ? { description: eaDescription.value.trim() } : {}),
                ...(eaDocs.value.trim() ? { docsUrl: eaDocs.value.trim() } : {}),
              }
            : null,
      };
      if (earlyAccess && !eaName.value.trim())
        throw new Error('Give the early access feature a name people will see.');
      await api.put(`/api/flags/${encodeURIComponent(key.value)}`, body);
      toast(flag ? 'Flag saved' : 'Flag created');
      go('flags');
    } catch (err) {
      mount(error, errorState(err));
    }
  });
  return form;
}

/** Who has seen the flag, by value (from $exposure events). */
function usagePanel(key: string): HTMLElement {
  return later(async () => {
    const r = await api.get<{
      buckets: number[];
      interval: string;
      series: {
        label: string;
        breakdown: string | null;
        values: number[];
        total: number;
        seriesIndex: number;
      }[];
      summary: string;
    }>(`/api/flags/${encodeURIComponent(key)}/usage`, { project: scope().project, from: '-30d' });
    const people = r.series.filter((x) => x.seriesIndex === 1 && x.total > 0);
    return panel(
      'Exposures',
      people.length
        ? lineChart(
            r.buckets,
            people.map((x) => ({ label: x.breakdown ?? x.label, values: x.values })),
            r.interval,
            { height: 160 },
          )
        : h(
            'p',
            { class: 'muted' },
            `No one has seen it yet. It counts once your code reads glass.flag('${key}').`,
          ),
      {
        icon: 'users',
        subtitle: people.length ? 'People who saw each value, last 30 days' : undefined,
      },
    );
  });
}

function schedulesPanel(key: string): HTMLElement {
  const project = scope().project;
  return later(async () => {
    const r = await api.get<{
      schedules: {
        id: string;
        runAt: string;
        change: Record<string, unknown>;
        status: string;
        error?: string;
      }[];
    }>('/api/flags/schedules', { project, key });
    const when = h('input', { type: 'datetime-local', required: true });
    const what = h(
      'select',
      {},
      [
        ['enable', 'Turn on'],
        ['disable', 'Turn off'],
        ['rollout', 'Set rollout to…'],
      ].map(([v, label]) => h('option', { value: v }, label)),
    );
    const percent = h('input', {
      type: 'number',
      min: 0,
      max: 100,
      value: 50,
      class: 'short',
      hidden: true,
    });
    what.addEventListener('change', () => {
      percent.hidden = what.value !== 'rollout';
    });
    const error = h('div', {});
    const form = h(
      'form',
      { class: 'row' },
      when,
      what,
      percent,
      h('button', { type: 'submit' }, 'Schedule'),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const change =
          what.value === 'rollout'
            ? { rollout: Number(percent.value) }
            : { enabled: what.value === 'enable' };
        await api.post(`/api/flags/${encodeURIComponent(key)}/schedule`, {
          project,
          at: new Date(when.value).toISOString(),
          change,
        });
        toast('Change scheduled');
        go(`flags/${encodeURIComponent(key)}`, { t: String(Date.now()) });
      } catch (err) {
        mount(error, errorState(err));
      }
    });
    const describe = (c: Record<string, unknown>) =>
      c.enabled === true
        ? 'Turn on'
        : c.enabled === false
          ? 'Turn off'
          : c.rollout !== undefined
            ? `Rollout ${c.rollout}%`
            : JSON.stringify(c);
    return panel(
      'Scheduled changes',
      [
        r.schedules.length
          ? table(
              ['When', 'Change', 'Status', ''],
              r.schedules.map((x) => [
                h('span', { class: 'nowrap' }, dateTime(x.runAt)),
                describe(x.change),
                x.error ? `${x.status}: ${x.error}` : x.status,
                x.status === 'pending'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        class: 'link-button',
                        onclick: async () => {
                          await api.delete(`/api/flags/schedules/${x.id}`, { project });
                          go(`flags/${encodeURIComponent(key)}`, { t: String(Date.now()) });
                        },
                      },
                      'Cancel',
                    )
                  : '',
              ]),
            )
          : null,
        form,
        error,
      ],
      { icon: 'clock' },
    );
  });
}

function historyPanel(key: string): HTMLElement {
  return later(async () => {
    const r = await api.get<{
      history: { at: string; action: string; actor: string; changed: string[] }[];
    }>(`/api/flags/${encodeURIComponent(key)}/history`, { project: scope().project });
    return panel(
      'History',
      r.history.length
        ? table(
            ['When', 'Change', 'By'],
            r.history
              .slice(0, 20)
              .map((x) => [
                h('span', { class: 'nowrap', title: dateTime(x.at) }, ago(x.at)),
                x.action === 'update' && x.changed.length
                  ? `Changed ${x.changed.join(', ')}`
                  : x.action,
                x.actor || '—',
              ]),
          )
        : h('p', { class: 'muted' }, 'No changes recorded yet.'),
      { icon: 'clock' },
    );
  });
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
        return h(
          'div',
          { class: 'flag-detail' },
          panel('Definition', editor(flag), { icon: 'flag' }),
          h(
            'div',
            { class: 'flag-side' },
            usagePanel(target),
            schedulesPanel(target),
            historyPanel(target),
          ),
        );
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
