/**
 * Data pipelines: destinations (forward events as they arrive), transformations
 * (rules applied at ingest) and batch exports (hourly or daily files or rows).
 */

import { api } from '../api.ts';
import { lineChart } from '../components/charts.ts';
import { cleanFilters, type FilterRow, filterEditor } from '../components/filter-editor.ts';
import { icon } from '../components/icons.ts';
import { toggle } from '../components/menu.ts';
import { eventPicker } from '../components/picker.ts';
import {
  cleanTransformationRule,
  eventListEditor,
  transformationRuleEditor,
} from '../components/rich-editors.ts';
import {
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
import { ago, count, dateTime } from '../format.ts';
import { go, href, type Route, scope } from '../state.ts';

type Tab = 'destinations' | 'transformations' | 'exports';

interface TemplateInput {
  key: string;
  label: string;
  type: 'string' | 'secret' | 'boolean' | 'json' | 'select';
  required?: boolean;
  description?: string;
  default?: unknown;
  options?: string[];
}
interface Template {
  id: string;
  name: string;
  description: string;
  category: string;
  inputs: TemplateInput[];
  defaultEvents?: string[];
}
interface Destination {
  id: string;
  name: string;
  template: string;
  enabled: boolean;
  match: { events?: string[]; filters?: unknown[] };
  config: Record<string, unknown>;
  secretsSet: string[];
}

/** A <label> wraps one input (clicking the text focuses it); composite editors get a <div>. */
const labelable = (control: unknown) =>
  control instanceof HTMLInputElement ||
  control instanceof HTMLSelectElement ||
  control instanceof HTMLTextAreaElement;

const field = (label: string, control: HTMLElement, hint?: string) =>
  h(
    labelable(control) ? 'label' : 'div',
    { class: 'field' },
    h('span', {}, label),
    control,
    hint ? h('small', { class: 'muted' }, hint) : null,
  );

const parseJson = (text: string, what: string): unknown => {
  try {
    return text.trim() ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
};

// ── Destinations ───────────────────────────────────────────────────────────

function destinationForm(
  templates: Template[],
  existing: Destination | null,
  initial: string,
): HTMLElement {
  const project = scope().project;
  const holder = h('div', {});
  const paint = (templateId: string) => {
    const t = templates.find((x) => x.id === templateId) ?? templates[0]!;
    const name = h('input', { type: 'text', value: existing?.name ?? t.name, required: true });
    const eventList = [...(existing?.match.events ?? t.defaultEvents ?? [])];
    if (eventList.length === 0) eventList.push('');
    const events = eventListEditor(eventList, project, {
      allLabel: 'All events (except bookkeeping)',
    });
    const filterRows = structuredClone((existing?.match.filters ?? []) as FilterRow[]);
    const filters = filterEditor(filterRows, () => {}, { project });
    const controls = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
    const inputs = t.inputs.map((i) => {
      const current = existing?.config[i.key] ?? i.default;
      let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (i.type === 'boolean')
        control = h('input', { type: 'checkbox', checked: current === true });
      else if (i.type === 'select')
        control = h(
          'select',
          {},
          (i.options ?? []).map((o) => h('option', { value: o, selected: o === current }, o)),
        );
      else if (i.type === 'json')
        control = h(
          'textarea',
          { rows: 3, spellcheck: false },
          current === undefined ? '' : JSON.stringify(current, null, 2),
        );
      else
        control = h('input', {
          type: i.type === 'secret' ? 'password' : 'text',
          value: i.type === 'secret' ? '' : current === undefined ? '' : String(current),
          placeholder:
            i.type === 'secret' && existing?.secretsSet.includes(i.key)
              ? '•••••• (set; leave empty to keep)'
              : '',
          required:
            Boolean(i.required) && !(i.type === 'secret' && existing?.secretsSet.includes(i.key)),
          autocomplete: 'off',
        });
      controls.set(i.key, control);
      return field(`${i.label}${i.required ? '' : ' (optional)'}`, control, i.description);
    });
    const error = h('div', {});
    const form = h(
      'form',
      { class: 'stack' },
      existing
        ? null
        : field(
            'Destination',
            (() => {
              const sel = h(
                'select',
                {},
                templates.map((x) => h('option', { value: x.id, selected: x.id === t.id }, x.name)),
              );
              sel.addEventListener('change', () => paint(sel.value));
              return sel;
            })(),
            t.description,
          ),
      field('Name', name),
      field('Events to send', events),
      field('Only events matching (optional)', filters, 'e.g. paid plans only.'),
      inputs,
      error,
      h(
        'div',
        { class: 'form-actions' },
        h('button', { type: 'submit', class: 'primary' }, existing ? 'Save' : 'Create destination'),
      ),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const values: Record<string, unknown> = {};
        for (const i of t.inputs) {
          const c = controls.get(i.key)!;
          if (i.type === 'boolean') values[i.key] = (c as HTMLInputElement).checked;
          else if (i.type === 'json') {
            const v = parseJson(c.value, i.label);
            if (v !== undefined) values[i.key] = v;
          } else if (c.value !== '') values[i.key] = c.value;
        }
        const body = {
          project,
          name: name.value,
          template: t.id,
          events: eventList.filter(Boolean),
          filters: cleanFilters(filterRows) ?? [],
          inputs: values,
        };
        const r = existing
          ? await api.put<{ destination: Destination }>(`/api/destinations/${existing.id}`, body)
          : await api.post<{ destination: Destination }>('/api/destinations', body);
        toast(
          existing ? 'Destination saved' : 'Destination created: send a test event to check it',
        );
        go(`pipelines/destinations/${r.destination.id}`);
      } catch (err) {
        mount(error, errorState(err));
      }
    });
    mount(holder, form);
  };
  paint(existing?.template ?? initial);
  return holder;
}

function destinationDetail(id: string): HTMLElement {
  const project = scope().project;
  return later(async () => {
    const [{ templates }, r] = await Promise.all([
      api.get<{ templates: Template[] }>('/api/destinations/templates'),
      api.get<{
        destination: Destination;
        activity: {
          totals: { delivered: number; failed: number; skipped: number };
          pending: number;
          byHour: { hour: string; delivered: number; failed: number; skipped: number }[];
          failures: {
            id: string;
            event_id: string;
            at: string;
            status: number | null;
            error: string;
          }[];
        };
        summary: string;
      }>(`/api/destinations/${id}`, { project }),
    ]);
    const d = r.destination;
    const out = h('div', {});
    const test = h(
      'button',
      {
        type: 'button',
        onclick: async () => {
          try {
            const res = await api.post<{
              ok: boolean;
              skipped?: boolean;
              error?: string;
              status?: number;
              response?: string;
              summary: string;
            }>(`/api/destinations/${id}/test`, { project });
            mount(
              out,
              h(
                'div',
                { class: `state ${res.ok ? 'ok' : 'error'}` },
                h('p', {}, res.summary),
                res.response ? h('pre', { class: 'code-inline' }, res.response) : null,
              ),
            );
          } catch (err) {
            mount(out, errorState(err));
          }
        },
      },
      icon('play', 14),
      'Send a test event',
    );
    const retry = r.activity.failures.length
      ? h(
          'button',
          {
            type: 'button',
            onclick: async () => {
              const res = await api.post<{ summary: string }>(`/api/destinations/${id}/retry`, {
                project,
              });
              toast(res.summary);
            },
          },
          'Retry failed',
        )
      : null;
    const remove = h(
      'button',
      {
        type: 'button',
        class: 'danger',
        onclick: async () => {
          if (!confirm(`Delete "${d.name}"?`)) return;
          await api.delete(`/api/destinations/${id}`, { project });
          toast('Destination deleted');
          go('pipelines/destinations');
        },
      },
      'Delete',
    );
    const hours = r.activity.byHour;
    return [
      pageHeader(
        d.name,
        `${templates.find((t) => t.id === d.template)?.name ?? d.template} · ${r.summary}`,
        [test, retry, remove],
      ),
      out,
      hours.length
        ? panel(
            'Deliveries',
            lineChart(
              hours.map((x) => Date.parse(x.hour)),
              [
                { label: 'Delivered', values: hours.map((x) => x.delivered) },
                { label: 'Failed', values: hours.map((x) => x.failed) },
                { label: 'Skipped', values: hours.map((x) => x.skipped) },
              ],
              'hour',
              { type: 'bar', height: 180 },
            ),
            { icon: 'zap', subtitle: `${r.activity.pending} waiting` },
          )
        : null,
      r.activity.failures.length
        ? panel(
            'Recent failures',
            table(
              ['When', 'Event', 'Status', 'Error'],
              r.activity.failures.map((f) => [
                dateTime(f.at),
                h('code', {}, f.event_id),
                f.status ?? '—',
                f.error,
              ]),
            ),
            { icon: 'alert' },
          )
        : null,
      panel('Settings', destinationForm(templates, d, d.template), { icon: 'settings' }),
    ];
  });
}

function destinations(route: Route): Child {
  const project = scope().project;
  const sub = route.rest[1];
  if (sub === 'new') {
    return later(async () => {
      const { templates } = await api.get<{ templates: Template[] }>('/api/destinations/templates');
      return panel(
        'New destination',
        destinationForm(templates, null, route.params.get('template') ?? 'slack'),
        { icon: 'zap' },
      );
    });
  }
  if (sub) return destinationDetail(sub);
  return later(async () => {
    const [{ destinations: list, delivery }, { templates }] = await Promise.all([
      api.get<{ destinations: Destination[]; delivery: 'queue' | 'outbox' }>('/api/destinations', {
        project,
      }),
      api.get<{ templates: Template[] }>('/api/destinations/templates'),
    ]);
    const newButton = h(
      'a',
      { class: 'button primary', href: href('pipelines/destinations/new') },
      icon('plus', 15),
      'New destination',
    );
    const gallery = h(
      'div',
      { class: 'template-grid' },
      templates.map((t) =>
        h(
          'a',
          { class: 'template-card', href: href('pipelines/destinations/new', { template: t.id }) },
          h('strong', {}, t.name),
          h('span', { class: 'muted small' }, t.description),
        ),
      ),
    );
    if (!list.length)
      return [
        empty(
          'Forward events as they arrive: chat alerts, ad platforms (with hashed identifiers), CRMs, other analytics tools or your own webhook.',
          newButton,
          { icon: 'zap', title: 'No destinations' },
        ),
        gallery,
      ];
    return [
      panel(
        `${list.length} ${list.length === 1 ? 'destination' : 'destinations'}`,
        table(
          ['Destination', 'Type', 'Events', 'On'],
          list.map((d) => [
            h('a', { href: href(`pipelines/destinations/${d.id}`) }, d.name),
            templates.find((t) => t.id === d.template)?.name ?? d.template,
            (d.match.events ?? []).join(', ') || 'default events',
            toggle({
              checked: d.enabled,
              label: h('span', { class: 'visually-hidden' }, `${d.name} on`),
              onChange: async (checked) => {
                await api.put(`/api/destinations/${d.id}`, { project, enabled: checked });
                toast(`${d.name} turned ${checked ? 'on' : 'off'}`);
              },
            }),
          ]),
        ),
        {
          icon: 'zap',
          subtitle:
            delivery === 'queue'
              ? 'Events are delivered within seconds through Cloudflare Queues, with retries.'
              : 'Events are delivered every five minutes, with retries (no queue: run dataflare upgrade to add one).',
          actions: newButton,
        },
      ),
      panel('Add another', gallery, {}),
    ];
  });
}

// ── Transformations ────────────────────────────────────────────────────────

/** A rule in a few words, e.g. "Rename planName → plan". */
function describeRule(rule: Record<string, unknown>): string {
  const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');
  switch (rule.kind) {
    case 'drop_event':
      return 'Drop the event';
    case 'drop_properties':
      return `Drop ${list(rule.properties)}`;
    case 'rename_property':
      return `Rename ${rule.from} → ${rule.to}`;
    case 'set_property':
      return `Set ${rule.property} = ${JSON.stringify(rule.value)}`;
    case 'hash_properties':
      return `Hash ${list(rule.properties)}`;
    case 'redact':
      return `Redact ${list(rule.patterns) || 'email, phone'}${Array.isArray(rule.custom) && rule.custom.length ? ' and custom patterns' : ''}`;
    default:
      return String(rule.kind);
  }
}

function transformations(): Child {
  const project = scope().project;
  return later(async () => {
    const r = await api.get<{
      transformations: {
        id: string;
        position: number;
        enabled: boolean;
        applied: number;
        rule: { kind: string; name?: string; events?: string[] } & Record<string, unknown>;
      }[];
      summary: string;
    }>('/api/transformations', { project });
    const rule: Record<string, unknown> & { kind: string } = {
      kind: 'redact',
      patterns: ['email', 'phone'],
    };
    let sampleEvent = 'signup';
    const sampleProps = h(
      'textarea',
      { rows: 2, spellcheck: false },
      '{"note":"mail ann@example.com","plan":"pro"}',
    );
    const out = h('div', {});
    const run = async (save: boolean) => {
      try {
        const parsed = cleanTransformationRule(rule);
        if (save) {
          await api.post('/api/transformations', {
            project,
            rule: parsed,
            position: (r.transformations.at(-1)?.position ?? 0) + 1,
          });
          toast('Rule added: it applies to events from now on');
          go('pipelines/transformations', { t: String(Date.now()) });
          return;
        }
        const res = await api.post<{ dropped: boolean; after: unknown; summary: string }>(
          '/api/transformations/test',
          {
            project,
            rule: parsed,
            event: {
              event: sampleEvent,
              props: parseJson(sampleProps.value, 'The sample properties') ?? {},
            },
          },
        );
        mount(
          out,
          h(
            'div',
            { class: 'state ok' },
            h('p', {}, res.summary),
            res.after
              ? h('pre', { class: 'code-inline' }, JSON.stringify(res.after, null, 2))
              : null,
          ),
        );
      } catch (err) {
        mount(out, errorState(err));
      }
    };
    return [
      r.transformations.length
        ? panel(
            'Rules, in order',
            table(
              ['#', 'Rule', 'Applies to', 'Changed', 'On', ''],
              r.transformations.map((t, i) => [
                String(i + 1),
                t.rule.name
                  ? h(
                      'span',
                      {},
                      h('strong', {}, t.rule.name),
                      h('span', { class: 'muted' }, ` · ${describeRule(t.rule)}`),
                    )
                  : describeRule(t.rule),
                t.rule.events?.join(', ') ?? 'all events',
                count(t.applied),
                toggle({
                  checked: t.enabled,
                  label: h('span', { class: 'visually-hidden' }, 'on'),
                  onChange: async (checked) => {
                    await api.put(`/api/transformations/${t.id}`, {
                      project,
                      enabled: checked,
                      rule: t.rule,
                    });
                    toast(checked ? 'Rule on' : 'Rule off');
                  },
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'icon-button',
                    'aria-label': 'Delete rule',
                    onclick: async () => {
                      await api.delete(`/api/transformations/${t.id}`, { project });
                      go('pipelines/transformations', { t: String(Date.now()) });
                    },
                  },
                  icon('trash', 14),
                ),
              ]),
              { numeric: [3] },
            ),
            {
              icon: 'filter',
              subtitle:
                'Applied to every event at ingest, top to bottom, before it is stored or forwarded.',
            },
          )
        : empty(
            'Rules run on every event at ingest, before it is stored or forwarded: keep personal data out, drop noise, fix property names without a deploy.',
            null,
            {
              icon: 'filter',
              title: 'No transformations',
            },
          ),
      panel(
        'Add a rule',
        h(
          'div',
          { class: 'stack' },
          transformationRuleEditor(rule, project),
          field(
            'Try it on a sample event',
            h(
              'div',
              { class: 'stack tight' },
              eventPicker({
                value: sampleEvent,
                project,
                label: 'Sample event',
                onChange: (v) => {
                  sampleEvent = v;
                },
              }),
              sampleProps,
            ),
            'The sample’s properties, as JSON.',
          ),
          h(
            'div',
            { class: 'form-actions' },
            h('button', { type: 'button', onclick: () => run(false) }, 'Try it'),
            h('button', { type: 'button', class: 'primary', onclick: () => run(true) }, 'Add rule'),
          ),
          out,
        ),
        { icon: 'plus' },
      ),
    ];
  });
}

// ── Batch exports ──────────────────────────────────────────────────────────

const TARGET_FIELDS: Record<
  string,
  { key: string; label: string; secret?: boolean; placeholder?: string; json?: boolean }[]
> = {
  s3: [
    {
      key: 'endpoint',
      label: 'Endpoint',
      placeholder: 'https://<account>.r2.cloudflarestorage.com',
    },
    { key: 'bucket', label: 'Bucket' },
    { key: 'region', label: 'Region', placeholder: 'auto' },
    { key: 'prefix', label: 'Prefix', placeholder: 'dataflare/' },
    { key: 'accessKeyId', label: 'Access key id', secret: true },
    { key: 'secretAccessKey', label: 'Secret access key', secret: true },
  ],
  bigquery: [
    { key: 'projectId', label: 'Google Cloud project' },
    { key: 'dataset', label: 'Dataset' },
    { key: 'table', label: 'Table', placeholder: 'events' },
    { key: 'serviceAccount', label: 'Service account key (JSON)', secret: true, json: true },
  ],
  http: [
    { key: 'url', label: 'URL', secret: true, placeholder: 'https://etl.example.com/dataflare' },
    {
      key: 'headers',
      label: 'Headers (JSON)',
      secret: true,
      json: true,
      placeholder: '{"Authorization":"Bearer …"}',
    },
  ],
};

function exports(): Child {
  const project = scope().project;
  return later(async () => {
    const r = await api.get<{
      exports: {
        id: string;
        name: string;
        target: string;
        format: string;
        frequency: string;
        enabled: boolean;
        watermark: string;
        running: boolean;
      }[];
      summary: string;
    }>('/api/exports', { project });
    const target = h(
      'select',
      {},
      ['s3', 'bigquery', 'http'].map((t) =>
        h(
          'option',
          { value: t },
          { s3: 'S3 or R2 (files)', bigquery: 'BigQuery (rows)', http: 'HTTP (NDJSON)' }[t]!,
        ),
      ),
    );
    const format = h(
      'select',
      {},
      ['jsonl', 'csv'].map((t) => h('option', { value: t }, t.toUpperCase())),
    );
    const frequency = h(
      'select',
      {},
      ['hour', 'day'].map((t) => h('option', { value: t }, `Every ${t}`)),
    );
    const from = h('input', { type: 'text', value: '-7d', placeholder: '-30d' });
    const fields = h('div', { class: 'stack' });
    const controls = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
    const paint = () => {
      controls.clear();
      mount(
        fields,
        TARGET_FIELDS[target.value]!.map((f) => {
          const c = f.json
            ? h('textarea', { rows: 3, spellcheck: false, placeholder: f.placeholder ?? '' })
            : h('input', {
                type: f.secret ? 'password' : 'text',
                placeholder: f.placeholder ?? '',
                autocomplete: 'off',
              });
          controls.set(f.key, c);
          return field(f.label, c);
        }),
      );
    };
    target.addEventListener('change', paint);
    paint();
    const error = h('div', {});
    const form = h(
      'form',
      { class: 'stack' },
      h(
        'div',
        { class: 'grid-3' },
        field('Target', target),
        field('Format', format),
        field('How often', frequency),
      ),
      fields,
      field('Start with events received since', from),
      error,
      h(
        'div',
        { class: 'form-actions' },
        h('button', { type: 'submit', class: 'primary' }, 'Create export'),
      ),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const settings: Record<string, unknown> = {};
        for (const f of TARGET_FIELDS[target.value]!) {
          const v = controls.get(f.key)!.value.trim();
          if (v) settings[f.key] = f.json && f.key === 'headers' ? parseJson(v, f.label) : v;
        }
        await api.post('/api/exports', {
          project,
          target: target.value,
          format: format.value,
          frequency: frequency.value,
          settings,
          from: from.value || undefined,
        });
        toast('Export created: files appear after the first full period');
        go('pipelines/exports', { t: String(Date.now()) });
      } catch (err) {
        mount(error, errorState(err));
      }
    });
    const runs = h('div', {});
    return [
      r.exports.length
        ? panel(
            'Exports',
            table(
              ['Export', 'Target', 'Every', 'Sent up to', 'On', ''],
              r.exports.map((x) => [
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'link-button',
                    onclick: async () => {
                      const res = await api.get<{
                        runs: {
                          status: string;
                          window: { from: string; to: string };
                          rows: number;
                          files: number;
                          error?: string;
                          startedAt: string;
                        }[];
                      }>(`/api/exports/${x.id}/runs`, { project });
                      mount(
                        runs,
                        panel(
                          `Runs of ${x.name}`,
                          res.runs.length
                            ? table(
                                ['Started', 'Window', 'Status', 'Rows', 'Files'],
                                res.runs.map((u) => [
                                  ago(u.startedAt),
                                  `${dateTime(u.window.from)} → ${dateTime(u.window.to)}`,
                                  u.error ? `${u.status}: ${u.error}` : u.status,
                                  count(u.rows),
                                  String(u.files),
                                ]),
                                { numeric: [3, 4] },
                              )
                            : empty('No runs yet.'),
                          { icon: 'clock' },
                        ),
                      );
                    },
                  },
                  x.name,
                ),
                `${x.target} · ${x.format}`,
                x.frequency,
                `${dateTime(x.watermark)}${x.running ? ' (sending)' : ''}`,
                toggle({
                  checked: x.enabled,
                  label: h('span', { class: 'visually-hidden' }, 'on'),
                  onChange: async (checked) => {
                    await api.put(`/api/exports/${x.id}`, { project, enabled: checked });
                    toast(checked ? 'Export on' : 'Export paused');
                  },
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    onclick: async () => {
                      const since = prompt(
                        'Re-export everything received since (e.g. -30d or 2026-01-01):',
                        '-30d',
                      );
                      if (!since) return;
                      const res = await api.post<{ summary: string }>(
                        `/api/exports/${x.id}/backfill`,
                        { project, from: since },
                      );
                      toast(res.summary);
                    },
                  },
                  'Backfill',
                ),
              ]),
            ),
            {
              icon: 'database',
              subtitle:
                'Each run sends the events received in a closed hour or day; runs pick up where the last one stopped.',
            },
          )
        : empty(
            'Send events to your warehouse every hour or day: gzipped JSONL/CSV files in S3 or R2 (Snowflake, Databricks and Spark read these), rows in BigQuery, or NDJSON to your own endpoint.',
            null,
            {
              icon: 'database',
              title: 'No exports',
            },
          ),
      runs,
      panel('New export', form, {
        icon: 'plus',
        subtitle: 'Credentials are encrypted and never shown again.',
      }),
      panel(
        'Import history',
        [
          h(
            'p',
            { class: 'muted' },
            'Bring events from another tool, with their timestamps (ids de-duplicate re-runs):',
          ),
          h(
            'pre',
            { class: 'code-inline' },
            'npx dataflare-cli import export.ndjson --preset posthog   # or mixpanel, amplitude, segment, ga4',
          ),
        ],
        { icon: 'inbox' },
      ),
    ];
  });
}

export function pipelinesPage(route: Route): Node[] {
  const tab = (route.rest[0] ?? 'destinations') as Tab;
  return [
    pageHeader(
      'Pipelines',
      'Send events to other tools as they arrive, clean them at ingest, and export them to your warehouse.',
    ),
    tabs(
      [
        { value: 'destinations', label: 'Destinations', icon: 'zap' },
        { value: 'transformations', label: 'Transformations', icon: 'filter' },
        { value: 'exports', label: 'Exports', icon: 'database' },
      ],
      tab,
      (v) => go(`pipelines/${v}`),
      'page-tabs',
    ),
    h(
      'div',
      { class: 'tab-body' },
      tab === 'transformations'
        ? transformations()
        : tab === 'exports'
          ? exports()
          : destinations(route),
    ),
  ];
}
