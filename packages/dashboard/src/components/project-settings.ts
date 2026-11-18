/**
 * Project settings on the Settings page: time zone, internal traffic, currency
 * and revenue events, error tracking and alerts, flag overrides; and the Stripe
 * connection. Everything here is also an agent tool (update_settings,
 * connect_stripe).
 */

import { api } from '../api.ts';
import { type Child, h, mount } from '../dom.ts';
import { scope } from '../state.ts';
import { cleanFilters, type FilterRow, filterEditor } from './filter-editor.ts';
import { toggle } from './menu.ts';
import { completeRevenueRules, type RevenueRule, revenueEventsEditor } from './rich-editors.ts';
import { errorState, later, panel, toast } from './ui.ts';

interface Settings {
  timezone?: string;
  internalFilters?: unknown[];
  baseCurrency?: string;
  revenueEvents?: unknown[];
  inAppIncludes?: string[];
  allowFlagOverrides?: boolean;
  errorRateLimitPerMinute?: number;
  errorAlerts?: {
    destination: string;
    onNew?: boolean;
    onRegression?: boolean;
    spike?: { count: number; minutes: number };
  };
}

/** A <label> wraps one input (clicking the text focuses it); composite editors get a <div>. */
const labelable = (control: unknown) =>
  control instanceof HTMLInputElement ||
  control instanceof HTMLSelectElement ||
  control instanceof HTMLTextAreaElement;

const field = (label: string, control: HTMLElement, hint?: Child) =>
  h(
    labelable(control) ? 'label' : 'div',
    { class: 'field' },
    h('span', {}, label),
    control,
    hint ? h('small', { class: 'muted' }, hint) : null,
  );

function settingsForm(
  settings: Settings,
  destinations: { id: string; name: string }[],
): HTMLElement {
  const project = scope().project;
  const zones =
    (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
      'timeZone',
    ) ?? [];
  const timezone = h('input', {
    type: 'text',
    value: settings.timezone ?? '',
    placeholder: 'UTC',
    list: 'tz-list',
  });
  const tzList = h(
    'datalist',
    { id: 'tz-list' },
    zones.map((z) => h('option', { value: z })),
  );
  const currency = h('input', {
    type: 'text',
    value: settings.baseCurrency ?? '',
    placeholder: 'USD',
    maxlength: 3,
    class: 'short',
  });
  const internalRows = structuredClone((settings.internalFilters ?? []) as FilterRow[]);
  const internal = filterEditor(internalRows, () => {}, { project });
  const revenueRules = structuredClone((settings.revenueEvents ?? []) as RevenueRule[]);
  const revenue = revenueEventsEditor(revenueRules, project);
  const inApp = h('input', {
    type: 'text',
    value: (settings.inAppIncludes ?? []).join(', '),
    placeholder: '/assets/app-, /static/js/main',
  });
  const rate = h('input', {
    type: 'number',
    min: 1,
    value: settings.errorRateLimitPerMinute ?? '',
    placeholder: '100',
    class: 'short',
  });
  let overrides = Boolean(settings.allowFlagOverrides);
  const alerts = settings.errorAlerts;
  const alertDest = h(
    'select',
    {},
    h('option', { value: '' }, 'No alerts'),
    destinations.map((d) =>
      h('option', { value: d.id, selected: d.id === alerts?.destination }, d.name),
    ),
  );
  let onNew = alerts?.onNew !== false;
  let onRegression = alerts?.onRegression !== false;
  const spikeCount = h('input', {
    type: 'number',
    min: 2,
    value: alerts?.spike?.count ?? '',
    placeholder: '50',
    class: 'short',
  });
  const spikeMinutes = h('input', {
    type: 'number',
    min: 1,
    value: alerts?.spike?.minutes ?? '',
    placeholder: '10',
    class: 'short',
  });
  const error = h('div', {});
  const form = h(
    'form',
    { class: 'stack' },
    h('h3', {}, 'Reports'),
    field(
      'Time zone',
      h('div', {}, timezone, tzList),
      'Day, week and month boundaries in every report (follows daylight saving).',
    ),
    field(
      'Internal traffic',
      internal,
      'Events matching any of these are your own or test traffic; "Filter out internal traffic" leaves them out.',
    ),
    h('h3', { id: 'revenue' }, 'Revenue'),
    field(
      'Base currency',
      currency,
      'Revenue is converted to it with the ECB rates of each payment’s day.',
    ),
    field(
      'Revenue events',
      revenue,
      'Events that carry money. Amounts are converted to the base currency; a subscription property tracks MRR.',
    ),
    h('h3', {}, 'Error tracking'),
    field(
      'Your code',
      inApp,
      'Path fragments of your own scripts, so their frames count as in-app (default: files on your site’s host).',
    ),
    field('Exceptions kept per issue per minute', rate),
    field(
      'Alerts',
      h(
        'div',
        { class: 'stack tight' },
        alertDest,
        h(
          'div',
          { class: 'row gap-lg' },
          toggle({ checked: onNew, label: 'New issues', onChange: (c) => (onNew = c) }),
          toggle({
            checked: onRegression,
            label: 'Regressions',
            onChange: (c) => (onRegression = c),
          }),
        ),
      ),
      destinations.length
        ? 'Sent through a destination (Slack, Discord, Teams or a webhook).'
        : 'Add a Slack, Discord, Teams or webhook destination under Pipelines first.',
    ),
    field(
      'Spike alert',
      h(
        'div',
        { class: 'row' },
        spikeCount,
        h('span', {}, 'exceptions within'),
        spikeMinutes,
        h('span', {}, 'minutes'),
      ),
      'Optional; at most one alert per window.',
    ),
    h('h3', {}, 'Flags'),
    toggle({
      checked: overrides,
      label: 'Allow ?__glass_flags=key:variant in page URLs to override flags (for QA)',
      onChange: (c) => (overrides = c),
    }),
    error,
    h(
      'div',
      { class: 'form-actions' },
      h('button', { type: 'submit', class: 'primary' }, 'Save settings'),
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const spike =
        spikeCount.value && spikeMinutes.value
          ? { count: Number(spikeCount.value), minutes: Number(spikeMinutes.value) }
          : undefined;
      await api.patch('/api/settings', {
        project,
        settings: {
          timezone: timezone.value.trim() || null,
          baseCurrency: currency.value.trim().toUpperCase() || null,
          internalFilters: cleanFilters(internalRows) ?? null,
          revenueEvents: completeRevenueRules(revenueRules).length
            ? completeRevenueRules(revenueRules)
            : null,
          inAppIncludes: inApp.value.trim()
            ? inApp.value
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean)
            : null,
          errorRateLimitPerMinute: rate.value ? Number(rate.value) : null,
          allowFlagOverrides: overrides,
          errorAlerts: alertDest.value
            ? { destination: alertDest.value, onNew, onRegression, ...(spike ? { spike } : {}) }
            : null,
        },
      });
      toast('Settings saved');
      mount(error);
    } catch (err) {
      mount(error, errorState(err));
    }
  });
  return form;
}

function stripePanel(status: {
  connected: boolean;
  webhookUrl: string;
  events: string[];
  config?: { personKey?: string; groupType?: string; groupKey?: string; linkByEmail?: boolean };
  received?: number;
  lastEventAt?: string | null;
  customers?: { known: number; linked: number };
  summary: string;
}): HTMLElement {
  const project = scope().project;
  const secret = h('input', {
    type: 'password',
    placeholder: status.connected ? '•••••• (set; leave empty to keep)' : 'whsec_…',
    autocomplete: 'off',
    required: !status.connected,
  });
  const apiKey = h('input', {
    type: 'password',
    placeholder: 'rk_live_… (optional: read access to Customers)',
    autocomplete: 'off',
  });
  const personKey = h('input', {
    type: 'text',
    value: status.config?.personKey ?? '',
    placeholder: 'dataflare_id',
  });
  const groupType = h('input', {
    type: 'text',
    value: status.config?.groupType ?? '',
    placeholder: 'company (optional)',
  });
  const groupKey = h('input', {
    type: 'text',
    value: status.config?.groupKey ?? '',
    placeholder: 'metadata key, default the customer id',
  });
  let byEmail = Boolean(status.config?.linkByEmail);
  const error = h('div', {});
  const form = h(
    'form',
    { class: 'stack' },
    h('p', {}, 'In Stripe › Developers › Webhooks, add an endpoint:'),
    h('pre', { class: 'code-inline' }, status.webhookUrl),
    h('p', { class: 'muted small' }, `Events to send: ${status.events.join(', ')}.`),
    field('Signing secret', secret),
    field(
      'Restricted key',
      apiKey,
      'Optional: lets Dataflare look up who a customer is when their metadata is missing.',
    ),
    field(
      'Customer metadata key with your user id',
      personKey,
      'What you pass to glass.identify. Without it, revenue goes to stripe:<customer>.',
    ),
    h(
      'div',
      { class: 'grid-2' },
      field('Accounts: group type', groupType),
      field('Accounts: metadata key', groupKey),
    ),
    toggle({
      checked: byEmail,
      label: 'Match customers to people by email (the email is not stored)',
      onChange: (c) => (byEmail = c),
    }),
    error,
    h(
      'div',
      { class: 'form-actions' },
      h(
        'button',
        { type: 'submit', class: 'primary' },
        status.connected ? 'Save' : 'Connect Stripe',
      ),
      status.connected
        ? h(
            'button',
            {
              type: 'button',
              class: 'danger',
              onclick: async () => {
                if (!confirm('Disconnect Stripe? Revenue already recorded stays.')) return;
                await api.delete('/api/stripe', { project });
                toast('Stripe disconnected');
                location.reload();
              },
            },
            'Disconnect',
          )
        : null,
    ),
    h(
      'p',
      { class: 'muted small' },
      'Backfill history: npx dataflare-cli stripe import --api-key rk_…',
    ),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api.post<{ summary: string }>('/api/stripe', {
        project,
        ...(secret.value ? { webhookSecret: secret.value } : {}),
        ...(apiKey.value ? { apiKey: apiKey.value } : {}),
        personKey: personKey.value || undefined,
        groupType: groupType.value || undefined,
        groupKey: groupKey.value || undefined,
        linkByEmail: byEmail,
      });
      toast(r.summary);
    } catch (err) {
      mount(error, errorState(err));
    }
  });
  const subtitle = status.connected
    ? `Connected · ${status.received ?? 0} webhooks received${status.lastEventAt ? `, the last ${new Date(status.lastEventAt).toLocaleString()}` : ''} · ${status.customers?.linked ?? 0} of ${status.customers?.known ?? 0} customers linked to people`
    : 'Not connected. Record payments, refunds and subscriptions (MRR) from Stripe.';
  return panel('Stripe', form, { icon: 'dollar', subtitle });
}

export function projectSettingsPanels(): HTMLElement {
  const project = scope().project;
  return later(async () => {
    const [{ settings }, { destinations }, stripe] = await Promise.all([
      api.get<{ settings: Settings }>('/api/settings', { project }),
      api.get<{ destinations: { id: string; name: string; template: string }[] }>(
        '/api/destinations',
        { project },
      ),
      api.get<Parameters<typeof stripePanel>[0]>('/api/stripe', { project }),
    ]);
    const chat = destinations.filter((d) =>
      ['slack', 'discord', 'teams', 'webhook', 'zapier', 'make', 'n8n'].includes(d.template),
    );
    return h(
      'div',
      { class: 'grid-2' },
      panel(`Project settings${project ? ` · ${project}` : ''}`, settingsForm(settings, chat), {
        icon: 'settings',
      }),
      stripePanel(stripe),
    );
  });
}
