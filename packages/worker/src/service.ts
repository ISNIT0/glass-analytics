/**
 * The Glass service: every operation the HTTP API, the MCP server and the
 * dashboard can perform, in one place. Inputs are validated here (with the
 * shared zod schemas), so all three surfaces behave identically and an agent
 * gets the same answer whichever way it asks.
 */

import { COHORT_PROPERTY, type CohortMembers, type Filter, toList } from '@glassanalytics/core/filters';
import { type InsightKind, INSIGHTS, experimentSpec, filterSchema, isInsightKind, sqlSpec, webSpec } from '@glassanalytics/core/insights';
import type { QueryContext, ResultBase } from '@glassanalytics/core/insights/types';
import { runWeb } from '@glassanalytics/core/insights/web';
import { EVENT_DOCUMENTATION_GUIDE, EVENT_NAMING_GUIDE, FRAMEWORKS, type Framework } from '@glassanalytics/core/instrument';
import { summariseReplay } from '@glassanalytics/core/replay-summary';
import { assertReadOnlySql } from '@glassanalytics/core/sql/guard';
import { propertyText } from '@glassanalytics/core/sql/filters';
import { eventsCte, num, text } from '@glassanalytics/core/sql/source';
import { DAY_MS, resolveRange } from '@glassanalytics/core/time';
import { GLASS_VERSION, UPGRADE_COMMAND, isNewerThan, upgradeMessage } from '@glassanalytics/core/version';
import { fetchLatestVersion } from './latest.ts';
import { runExperiment } from '@glassanalytics/core/insights/experiment';
import { z } from 'zod/v4';
import type { Env } from './env.ts';
import {
  type CreateExperimentInput,
  createExperiment,
  getExperiment,
  listExperiments,
  transitionExperiment,
} from './experiments.ts';
import { deleteFlag, getFlag, listFlags, saveFlag } from './flags.ts';
import { HttpError } from './http.ts';
import { upsertPerson } from './ingest.ts';
import { DEFAULT_INSIGHTS } from './insight-defaults.ts';
import { createProject, listProjects, resolveProject } from './projects.ts';
import { deleteReplays, getReplay, listReplays, loadReplayEvents, loadReplayPages, replaysEnabled } from './replays.ts';
import type { EventStore } from './stores/types.ts';

const project = z.string().optional();
const insightKind = z.enum(['trends', 'funnel', 'retention']);

export const inputs = {
  overview: z.object({ project, from: z.union([z.string(), z.number()]).optional(), to: z.union([z.string(), z.number()]).optional() }),
  listEvents: z.object({ project, days: z.number().int().min(1).max(365).optional().describe('Look-back window in days. Default 30.') }),
  describeEvent: z.object({ project, event: z.string().describe('Event name, e.g. "signup_completed".') }),
  defineEvent: z.object({
    project,
    event: z.string().describe('Event name, e.g. "signup_completed".'),
    description: z
      .string()
      .optional()
      .describe(
        'How and when this event is fired: the user action or code path that triggers capture. Example: "Fired when payment succeeds and the account is marked active."',
      ),
    owner: z.string().optional().describe('Team or person responsible for this event.'),
    properties: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Property name → what it means and which values to expect. Example: { "plan": "Chosen plan id (free|pro|enterprise)", "amount": "Charge in the account currency" }.',
      ),
  }),
  propertyValues: z.object({
    project,
    property: z.string().describe('Property to list values of: a column ("utm_source"), event property ("plan") or person property ("person.plan"). "cohort" lists saved cohorts.'),
    event: z.string().optional().describe('Only values seen on this event.'),
    query: z.string().optional().describe('Only values containing this text (case-insensitive).'),
    days: z.number().int().min(1).max(365).optional().describe('Look-back window in days. Default 30.'),
    limit: z.number().int().min(1).max(200).optional().describe('Default 50.'),
  }),
  listPersonProperties: z.object({ project }),
  instrument: z.object({
    event: z.string().describe('Event name to track, snake_case past tense, e.g. "checkout_started".'),
    properties: z.record(z.string(), z.unknown()).optional().describe('Example properties to send with it.'),
    framework: z.enum(Object.keys(FRAMEWORKS) as [Framework, ...Framework[]]).optional().describe('Defaults to plain HTML / script tag.'),
    project,
  }),
  searchPersons: z.object({
    project,
    query: z.string().optional().describe('Matches person id or any property value.'),
    limit: z.number().int().min(1).max(200).optional(),
    days: z.number().int().min(1).max(365).optional().describe('Window for the anonymous-device count. Default 30.'),
  }),
  getPerson: z.object({ project, person_id: z.string().describe('Your user id, or an anonymous device id.') }),
  setPersonProperties: z.object({ project, person_id: z.string(), properties: z.record(z.string(), z.unknown()) }),
  cohortDefinition: z.object({
    filters: z.array(filterSchema).default([]).describe('Person/event filters, e.g. [{"property":"person.plan","value":"pro"}].'),
    didEvent: z.string().optional().describe('Only people who did this event in the look-back window.'),
    from: z.union([z.string(), z.number()]).optional().describe('Look-back for membership. Default -90d.'),
  }),
  listCohorts: z.object({ project }),
  saveCohort: z.object({
    project,
    key: z.string().optional().describe('Stable id. Defaults to a slug of the name.'),
    name: z.string().min(1).describe('Human label, e.g. "Pro plan".'),
    filters: z.array(filterSchema).default([]),
    didEvent: z.string().optional(),
    from: z.union([z.string(), z.number()]).optional(),
  }),
  deleteCohort: z.object({ project, key: z.string() }),
  countCohort: z.object({
    project,
    filters: z.array(filterSchema).default([]),
    didEvent: z.string().optional(),
    from: z.union([z.string(), z.number()]).optional(),
  }),
  listReplays: z.object({
    project,
    person: z.string().optional().describe('Only sessions of this person (user id or device id).'),
    with_errors: z.boolean().optional().describe('Only sessions with JavaScript errors.'),
    from: z.union([z.string(), z.number()]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  replay: z.object({ project, session_id: z.string() }),
  flagKey: z.object({ project, key: z.string() }),
  saveFlag: z.object({
    project,
    key: z.string().describe('Flag key, e.g. "new-checkout".'),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
    rollout: z.number().min(0).max(100).optional().describe('Percentage of users who get the flag.'),
    variants: z
      .array(z.object({ key: z.string(), weight: z.number().min(0) }))
      .optional()
      .describe('For multivariate flags; first is control.'),
    rules: z
      .array(z.object({ conditions: z.array(filterSchema), rollout: z.number().min(0).max(100).optional(), variant: z.string().optional() }))
      .optional()
      .describe('Targeting rules, first match wins, e.g. [{"conditions":[{"property":"person.plan","value":"pro"}],"rollout":100}].'),
  }),
  createExperiment: z.object({
    project,
    key: z.string().describe('Experiment key, e.g. "pricing-page-v2".'),
    flag: z.string().optional().describe('Existing multivariate flag to use. Default: a new flag named after the experiment with control/test 50/50.'),
    goal: z.object({ event: z.string(), filters: z.array(filterSchema).optional(), value: z.string().optional() }),
    secondary: z.array(z.object({ event: z.string(), filters: z.array(filterSchema).optional() })).optional(),
    hypothesis: z.string().optional(),
    variants: z.array(z.object({ key: z.string(), weight: z.number().min(0) })).optional(),
  }),
  experimentKey: z.object({ project, key: z.string() }),
  updateExperiment: z.object({
    project,
    key: z.string(),
    action: z.enum(['start', 'stop', 'ship']),
    variant: z.string().optional().describe('Required for "ship": the variant everyone gets.'),
  }),
  createProject: z.object({
    id: z.string().describe('Lowercase id, e.g. "acme-web".'),
    name: z.string().optional(),
    allowed_origins: z.array(z.string()).optional().describe('Restrict browser ingest to these origins.'),
  }),
  listInsights: z.object({ project }),
  getInsight: z.object({ project, key: z.string() }),
  saveInsight: z.object({
    project,
    key: z.string().optional().describe('Stable id. Defaults to a slug of the name.'),
    name: z.string().min(1).describe('Title shown in the Insights list.'),
    description: z.string().optional().describe('Short explanation of what this analysis answers.'),
    kind: insightKind,
    spec: z.record(z.string(), z.unknown()).describe('Query spec without kind/project (series, steps, cohortEvent, …).'),
  }),
  deleteInsight: z.object({ project, key: z.string() }),
};

export class GlassService {
  readonly env: Env;
  readonly store: EventStore;
  readonly baseUrl: string;

  constructor(env: Env, store: EventStore, baseUrl: string) {
    this.env = env;
    this.store = store;
    this.baseUrl = baseUrl;
  }

  private async context(requested?: string): Promise<QueryContext> {
    const project = await resolveProject(this.env.DB, requested);
    return { dialect: this.store.dialect, project, execute: (sql) => this.store.query(sql) };
  }

  /** A link to the same view in the dashboard, included in every response. */
  link(route: string, params: Record<string, unknown> = {}): string {
    const q = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
    ).toString();
    return `${this.baseUrl}/app#/${route}${q ? `?${q}` : ''}`;
  }

  async health() {
    const latest = await fetchLatestVersion();
    const upgradeAvailable = latest != null && isNewerThan(latest, GLASS_VERSION);
    return {
      ok: true,
      version: GLASS_VERSION,
      latest,
      upgradeAvailable,
      upgradeCommand: UPGRADE_COMMAND,
      store: this.store.kind,
      freshnessSeconds: this.store.freshnessSeconds,
      replay: replaysEnabled(this.env),
      ...(upgradeAvailable && latest ? { summary: upgradeMessage(GLASS_VERSION, latest) } : {}),
    };
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  async runInsight(kind: string, input: unknown) {
    if (!isInsightKind(kind)) {
      throw new HttpError(400, `Unknown query kind "${kind}"`, `Use one of: ${Object.keys(INSIGHTS).join(', ')}, or the sql tool.`);
    }
    const def = INSIGHTS[kind as InsightKind];
    const spec = def.schema.parse(input) as { project?: string };
    const ctx = await this.context(spec.project);
    const run = def.run as unknown as (s: unknown, c: QueryContext) => Promise<ResultBase>;
    const result = await run(await this.resolveCohorts(ctx.project, spec), ctx);
    // Web lives under Reports; trends/funnel/retention stay as ephemeral Insights links.
    const route = kind === 'web' ? 'reports' : `insights/${kind}`;
    return { ...result, project: ctx.project, dashboard: this.link(route, { project: ctx.project, spec: { ...spec, project: undefined } }) };
  }

  async sql(input: unknown) {
    const spec = sqlSpec.parse(input);
    const ctx = await this.context(spec.project);
    const safe = assertReadOnlySql(spec.query);
    const limit = spec.limit ?? 1000;
    const wrapped = `SELECT * FROM (${safe}) glass_q LIMIT ${limit}`;
    const rows = await this.store.query(wrapped);
    return {
      kind: 'sql',
      project: ctx.project,
      columns: rows[0] ? Object.keys(rows[0]) : [],
      rows,
      sql: [wrapped],
      summary: `${rows.length} row${rows.length === 1 ? '' : 's'}${rows.length === limit ? ` (limit ${limit} reached)` : ''}.`,
      tables:
        this.store.kind === 'lake'
          ? `${this.store.dialect.table('events')}, ${this.store.dialect.table('identities')}`
          : 'events, identities, persons, cohorts, insights, flags, experiments, replays, event_definitions',
      dashboard: this.link('sql', { project: ctx.project, query: spec.query }),
    };
  }

  /** Headline numbers for a period plus the events that moved most. A good first call. */
  async overview(input: unknown) {
    const spec = inputs.overview.parse(input);
    const ctx = await this.context(spec.project);
    const web = await runWeb(webSpec.parse({ from: spec.from, to: spec.to }), ctx);
    const range = resolveRange(spec.from, spec.to);
    const length = range.to - range.from;
    const d = this.store.dialect;
    const sql = `SELECT event,
  SUM(CASE WHEN ts_ms >= ${range.from} THEN 1 ELSE 0 END) AS cur,
  SUM(CASE WHEN ts_ms < ${range.from} THEN 1 ELSE 0 END) AS prev
FROM ${d.table('events')}
WHERE project = ${d.str(ctx.project)} AND ts_ms >= ${range.from - length} AND ts_ms < ${range.to}
GROUP BY event ORDER BY cur DESC LIMIT 50`;
    const rows = await this.store.query(sql);
    const events = rows.map((r) => {
      const cur = num(r.cur);
      const prev = num(r.prev);
      return { event: text(r.event), count: cur, previous: prev, change: prev ? (cur - prev) / prev : null };
    });
    const movers = events
      .filter((e) => e.count + e.previous >= 20 && e.change !== null && Math.abs(e.change) >= 0.2)
      .sort((a, b) => Math.abs(b.change!) - Math.abs(a.change!))
      .slice(0, 5);
    const top = (k: keyof typeof web.breakdowns) => web.breakdowns[k].slice(0, 5);
    const health = await this.health();
    const baseSummary =
      `${web.summary} ` +
      (movers.length
        ? `Biggest movers: ${movers.map((m) => `${m.event} ${m.change! > 0 ? '+' : ''}${Math.round(m.change! * 100)}%`).join(', ')}.`
        : 'No events moved more than 20% vs the previous period.');
    return {
      project: ctx.project,
      range: web.range,
      web: { totals: web.totals, previous: web.previous },
      topPages: top('pages'),
      topReferrers: top('referrers'),
      topErrors: top('errors'),
      events: events.slice(0, 15),
      movers,
      upgradeAvailable: health.upgradeAvailable,
      ...(health.upgradeAvailable
        ? { upgrade: { version: health.version, latest: health.latest, command: health.upgradeCommand } }
        : {}),
      summary: health.upgradeAvailable && health.latest ? `${baseSummary} ${upgradeMessage(health.version, health.latest)}` : baseSummary,
      sql: [...web.sql, sql],
      dashboard: this.link('reports', { project: ctx.project, from: spec.from, to: spec.to }),
    };
  }

  // ── Event taxonomy ───────────────────────────────────────────────────────

  async listEvents(input: unknown) {
    const spec = inputs.listEvents.parse(input);
    const ctx = await this.context(spec.project);
    const since = Date.now() - (spec.days ?? 30) * DAY_MS;
    const d = this.store.dialect;
    const sql = `SELECT event, COUNT(*) AS n, MAX(ts_ms) AS last_seen FROM ${d.table('events')}
WHERE project = ${d.str(ctx.project)} AND ts_ms >= ${since}
GROUP BY event ORDER BY n DESC LIMIT 500`;
    const [rows, defs] = await Promise.all([
      this.store.query(sql),
      this.env.DB.prepare('SELECT event, description, owner FROM event_definitions WHERE project = ?').bind(ctx.project).all<{ event: string; description: string; owner: string }>(),
    ]);
    const described = new Map(defs.results.map((r) => [r.event, r]));
    const events = rows.map((r) => ({
      event: text(r.event),
      count: num(r.n),
      lastSeen: new Date(num(r.last_seen)).toISOString(),
      description: described.get(text(r.event))?.description ?? '',
      system: text(r.event).startsWith('$'),
    }));
    const undocumented = events.filter((e) => !e.system && !e.description).map((e) => e.event);
    return {
      project: ctx.project,
      days: spec.days ?? 30,
      events,
      undocumented,
      summary: `${events.length} distinct events in the last ${spec.days ?? 30} days${undocumented.length ? `; ${undocumented.length} custom events have no description (use define_event)` : ''}.`,
      namingGuide: EVENT_NAMING_GUIDE,
      documentationGuide: EVENT_DOCUMENTATION_GUIDE,
      sql: [sql],
      dashboard: this.link('events', { project: ctx.project }),
    };
  }

  /** Properties seen on an event (sampled), with types and example values. */
  async describeEvent(input: unknown) {
    const spec = inputs.describeEvent.parse(input);
    const ctx = await this.context(spec.project);
    const d = this.store.dialect;
    const since = Date.now() - 30 * DAY_MS;
    const sql = `SELECT props, ts_ms FROM ${d.table('events')}
WHERE project = ${d.str(ctx.project)} AND event = ${d.str(spec.event)} AND ts_ms >= ${since}
ORDER BY ts_ms DESC LIMIT 500`;
    const rows = await this.store.query(sql);
    const props = new Map<string, { types: Set<string>; examples: Set<string>; seen: number }>();
    for (const row of rows) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text(row.props) || '{}') as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const [key, value] of Object.entries(parsed)) {
        const p = props.get(key) ?? { types: new Set(), examples: new Set(), seen: 0 };
        p.seen++;
        p.types.add(value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
        if (p.examples.size < 5 && value !== null && typeof value !== 'object') p.examples.add(String(value).slice(0, 80));
        props.set(key, p);
      }
    }
    const def = await this.env.DB.prepare('SELECT description, owner, properties FROM event_definitions WHERE project = ? AND event = ?')
      .bind(ctx.project, spec.event)
      .first<{ description: string; owner: string; properties: string }>();
    const documented = def ? (JSON.parse(def.properties) as Record<string, string>) : {};
    return {
      project: ctx.project,
      event: spec.event,
      sampled: rows.length,
      lastSeen: rows[0] ? new Date(num(rows[0].ts_ms)).toISOString() : null,
      description: def?.description ?? '',
      owner: def?.owner ?? '',
      properties: [...props.entries()]
        .sort((a, b) => b[1].seen - a[1].seen)
        .map(([name, p]) => ({
          name,
          types: [...p.types],
          coverage: rows.length ? p.seen / rows.length : 0,
          examples: [...p.examples],
          description: documented[name] ?? '',
        })),
      summary: rows.length
        ? `"${spec.event}": ${props.size} properties across the latest ${rows.length} events.`
        : `No "${spec.event}" events in the last 30 days.`,
      sql: [sql],
    };
  }

  /** Most common values of a property, for filter typeahead. Counts come from events, so they match what a filter would select. */
  async propertyValues(input: unknown) {
    const spec = inputs.propertyValues.parse(input);
    const ctx = await this.context(spec.project);
    const limit = spec.limit ?? 50;
    const q = spec.query?.trim().toLowerCase() ?? '';
    if (spec.property.trim() === COHORT_PROPERTY) {
      const cohorts = await this.env.DB.prepare('SELECT key, name FROM cohorts WHERE project = ? ORDER BY name COLLATE NOCASE')
        .bind(ctx.project)
        .all<{ key: string; name: string }>();
      const values = cohorts.results
        .filter((c) => !q || c.key.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
        .slice(0, limit)
        .map((c) => ({ value: c.key, label: c.name, count: null, people: null }));
      return { project: ctx.project, property: COHORT_PROPERTY, values, summary: `${values.length} saved cohort${values.length === 1 ? '' : 's'}.`, sql: [] };
    }
    const d = this.store.dialect;
    const now = Date.now();
    let expr: string;
    try {
      expr = propertyText(spec.property, d);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : `Invalid property "${spec.property}"`, 'Use a column name, an event property, or person.<name>.');
    }
    const sql = `WITH ${eventsCte(d, { project: ctx.project, from: now - (spec.days ?? 30) * DAY_MS, to: now + 60_000, events: spec.event ? [spec.event] : undefined })}
SELECT v, COUNT(*) AS n, COUNT(DISTINCT pid) AS people FROM (SELECT ${expr} AS v, pid FROM ev) pv
WHERE v IS NOT NULL AND v <> ''${q ? ` AND ${d.containsIgnoreCase('v', q)}` : ''}
GROUP BY v ORDER BY n DESC LIMIT ${d.num(limit)}`;
    const values = (await this.store.query(sql)).map((r) => ({ value: text(r.v), label: text(r.v), count: num(r.n), people: num(r.people) }));
    return {
      project: ctx.project,
      property: spec.property,
      values,
      summary: values.length
        ? `Top ${values.length} values of "${spec.property}"${spec.event ? ` on "${spec.event}"` : ''}: ${values.slice(0, 5).map((v) => v.value).join(', ')}${values.length > 5 ? ', …' : ''}.`
        : `No values of "${spec.property}"${spec.event ? ` on "${spec.event}"` : ''} in the last ${spec.days ?? 30} days.`,
      sql: [sql],
    };
  }

  async defineEvent(input: unknown) {
    const spec = inputs.defineEvent.parse(input);
    const ctx = await this.context(spec.project);
    await this.env.DB.prepare(
      `INSERT INTO event_definitions (project, event, description, owner, properties, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project, event) DO UPDATE SET description = excluded.description, owner = excluded.owner, properties = excluded.properties, updated_at = excluded.updated_at`,
    )
      .bind(ctx.project, spec.event, spec.description ?? '', spec.owner ?? '', JSON.stringify(spec.properties ?? {}), Date.now())
      .run();
    const hasDescription = Boolean(spec.description?.trim());
    const propCount = Object.keys(spec.properties ?? {}).length;
    return {
      project: ctx.project,
      event: spec.event,
      saved: true,
      summary: `Saved the definition of "${spec.event}".`,
      hint: !hasDescription
        ? 'Add a how/when description (which user action or code path fires this event).'
        : propCount === 0
          ? 'If this event has properties, call define_event again with property meanings.'
          : EVENT_DOCUMENTATION_GUIDE,
    };
  }

  instrument(input: unknown) {
    const spec = inputs.instrument.parse(input);
    const framework = spec.framework ?? 'html';
    const snippet = FRAMEWORKS[framework].snippet({ host: this.baseUrl, project: spec.project ?? '<project>' });
    const warnings: string[] = [];
    if (spec.event.startsWith('$')) warnings.push('Names starting with "$" are reserved for Glass.');
    if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(spec.event)) warnings.push(`Consider snake_case object_action names. ${EVENT_NAMING_GUIDE}`);
    return {
      framework: FRAMEWORKS[framework].name,
      install: { file: snippet.file, code: snippet.code },
      capture: snippet.capture(spec.event, spec.properties),
      declarative: `<button data-glass-event="${spec.event}"${Object.entries(spec.properties ?? {})
        .map(([k, v]) => ` data-glass-prop-${k.replace(/_/g, '-')}="${String(v)}"`)
        .join('')}>…</button>`,
      warnings,
      summary: `Add the install snippet once, then call capture where "${spec.event}" happens. After deploying, check with describe_event, then define_event with how/when it fires and property meanings.`,
    };
  }

  // ── Persons ──────────────────────────────────────────────────────────────

  async searchPersons(input: unknown) {
    const spec = inputs.searchPersons.parse(input);
    const ctx = await this.context(spec.project);
    const q = spec.query?.trim();
    const days = spec.days ?? 30;
    const [{ results }, stats] = await Promise.all([
      this.env.DB.prepare(
        `SELECT person_id, props, first_seen, last_seen FROM persons WHERE project = ?
         ${q ? 'AND (instr(lower(person_id), lower(?)) > 0 OR instr(lower(props), lower(?)) > 0)' : ''}
         ORDER BY last_seen DESC LIMIT ?`,
      )
        .bind(ctx.project, ...(q ? [q, q] : []), spec.limit ?? 50)
        .all<{ person_id: string; props: string; first_seen: number; last_seen: number }>(),
      this.peopleStats(ctx.project, days),
    ]);
    return {
      project: ctx.project,
      persons: results.map((r) => ({
        id: r.person_id,
        properties: JSON.parse(r.props) as Record<string, unknown>,
        firstSeen: new Date(r.first_seen).toISOString(),
        lastSeen: new Date(r.last_seen).toISOString(),
      })),
      stats,
      summary:
        `${stats.identified} identified ${stats.identified === 1 ? 'person' : 'people'}, ` +
        `${stats.anonymousDevices} anonymous device${stats.anonymousDevices === 1 ? '' : 's'} active in the last ${days} days` +
        (q ? `; showing ${results.length} matching "${q}"` : results.length < stats.identified ? `; showing the ${results.length} most recently active` : '') +
        '.',
      sql: stats.sql,
      dashboard: this.link('users', { project: ctx.project, q }),
    };
  }

  /** Identified people (persons table) plus anonymous devices active in the window. */
  private async peopleStats(project: string, days: number): Promise<{
    identified: number;
    anonymousDevices: number;
    days: number;
    sql: string[];
  }> {
    const from = Date.now() - days * DAY_MS;
    const identifiedRow = await this.env.DB.prepare('SELECT COUNT(*) AS n FROM persons WHERE project = ?').bind(project).first<{ n: number }>();
    const identified = Number(identifiedRow?.n ?? 0);
    const d = this.store.dialect;
    let anonymousDevices: number;
    let sql: string;
    if (this.store.kind === 'd1') {
      // Same SQLite DB holds events, persons and identities.
      sql = `SELECT COUNT(DISTINCT e.distinct_id) AS n
FROM ${d.table('events')} e
WHERE e.project = ${d.str(project)} AND e.ts_ms >= ${d.num(from)}
  AND e.distinct_id NOT IN (SELECT distinct_id FROM identities WHERE project = ${d.str(project)})
  AND e.distinct_id NOT IN (SELECT person_id FROM persons WHERE project = ${d.str(project)})`;
      anonymousDevices = num((await this.store.query(sql))[0]?.n);
    } else {
      sql = `SELECT DISTINCT distinct_id AS d FROM ${d.table('events')}
WHERE project = ${d.str(project)} AND ts_ms >= ${d.num(from)}`;
      const [devices, linked, people] = await Promise.all([
        this.store.query(sql),
        this.env.DB.prepare('SELECT distinct_id FROM identities WHERE project = ?').bind(project).all<{ distinct_id: string }>(),
        this.env.DB.prepare('SELECT person_id FROM persons WHERE project = ?').bind(project).all<{ person_id: string }>(),
      ]);
      const skip = new Set<string>([...linked.results.map((r) => r.distinct_id), ...people.results.map((r) => r.person_id)]);
      anonymousDevices = devices.reduce((n, r) => n + (skip.has(text(r.d)) ? 0 : 1), 0);
    }
    return { identified, anonymousDevices, days, sql: [sql] };
  }

  /** Person property keys (sampled from the most recently active people), for filter pickers. */
  async listPersonProperties(input: unknown) {
    const spec = inputs.listPersonProperties.parse(input);
    const ctx = await this.context(spec.project);
    const { results } = await this.env.DB.prepare('SELECT props FROM persons WHERE project = ? ORDER BY last_seen DESC LIMIT 1000')
      .bind(ctx.project)
      .all<{ props: string }>();
    const props = new Map<string, { types: Set<string>; examples: Set<string>; seen: number }>();
    for (const row of results) {
      for (const [key, value] of Object.entries(safeParse(row.props))) {
        const p = props.get(key) ?? { types: new Set(), examples: new Set(), seen: 0 };
        p.seen++;
        p.types.add(value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
        if (p.examples.size < 5 && value !== null && typeof value !== 'object') p.examples.add(String(value).slice(0, 80));
        props.set(key, p);
      }
    }
    const properties = [...props.entries()]
      .sort((a, b) => b[1].seen - a[1].seen)
      .map(([name, p]) => ({
        name: `person.${name}`,
        types: [...p.types],
        coverage: results.length ? p.seen / results.length : 0,
        examples: [...p.examples],
        description: '',
      }));
    return {
      project: ctx.project,
      sampled: results.length,
      properties,
      summary: properties.length
        ? `${properties.length} person properties across the ${results.length} most recently active people. Filter on them as "person.<name>".`
        : 'No person properties yet. Send them with glass.identify(userId, { plan: "pro" }).',
    };
  }

  async getPerson(input: unknown) {
    const spec = inputs.getPerson.parse(input);
    const ctx = await this.context(spec.project);
    const id = spec.person_id;
    const [person, devices] = await Promise.all([
      this.env.DB.prepare('SELECT props, first_seen, last_seen FROM persons WHERE project = ? AND person_id = ?')
        .bind(ctx.project, id)
        .first<{ props: string; first_seen: number; last_seen: number }>(),
      this.env.DB.prepare('SELECT distinct_id FROM identities WHERE project = ? AND person_id = ?').bind(ctx.project, id).all<{ distinct_id: string }>(),
    ]);
    const now = Date.now();
    const d = this.store.dialect;
    const sql = `WITH ${eventsCte(d, { project: ctx.project, from: now - 90 * DAY_MS, to: now + 60_000 })}
SELECT event, ts_ms, path, session_id, props FROM ev WHERE pid = ${d.str(id)} OR distinct_id = ${d.str(id)}
ORDER BY ts_ms DESC LIMIT 100`;
    const events = (await this.store.query(sql)).map((r) => ({
      event: text(r.event),
      time: new Date(num(r.ts_ms)).toISOString(),
      path: text(r.path),
      session: text(r.session_id),
      properties: safeParse(text(r.props)),
    }));
    const replays = replaysEnabled(this.env) ? await listReplays(this.env.DB, ctx.project, { person: id, limit: 20 }) : [];
    if (!person && events.length === 0) throw new HttpError(404, `No person or device "${id}" in project "${ctx.project}"`);
    return {
      project: ctx.project,
      id,
      identified: Boolean(person),
      properties: person ? (JSON.parse(person.props) as Record<string, unknown>) : {},
      firstSeen: person ? new Date(person.first_seen).toISOString() : (events.at(-1)?.time ?? null),
      lastSeen: person ? new Date(person.last_seen).toISOString() : (events[0]?.time ?? null),
      devices: devices.results.map((r) => r.distinct_id),
      recentEvents: events,
      replays: replays.map((r) => ({ session: r.session_id, started: new Date(r.started_at).toISOString(), errors: r.errors, url: r.start_url })),
      summary: `${person ? 'Identified person' : 'Anonymous device'} "${id}": ${events.length} events in 90 days${replays.length ? `, ${replays.length} recorded sessions` : ''}.`,
      sql: [sql],
      dashboard: this.link(`users/${encodeURIComponent(id)}`, { project: ctx.project }),
    };
  }

  async setPersonProperties(input: unknown) {
    const spec = inputs.setPersonProperties.parse(input);
    const ctx = await this.context(spec.project);
    await upsertPerson(this.env.DB, ctx.project, spec.person_id, Date.now(), spec.properties);
    return { project: ctx.project, id: spec.person_id, updated: Object.keys(spec.properties), summary: 'Person properties updated.' };
  }

  /** GDPR erasure: events (where the store allows), person, identity links and replays. */
  async deletePerson(input: unknown) {
    const spec = inputs.getPerson.parse(input);
    const ctx = await this.context(spec.project);
    const devices = (
      await this.env.DB.prepare('SELECT distinct_id FROM identities WHERE project = ? AND person_id = ?').bind(ctx.project, spec.person_id).all<{ distinct_id: string }>()
    ).results.map((r) => r.distinct_id);
    const ids = [spec.person_id, ...devices];
    const eventsDeleted = await this.store.deletePersonEvents(ctx.project, ids);
    const marks = ids.map(() => '?').join(', ');
    const replays = await deleteReplays(this.env, ctx.project, `(user_id IN (${marks}) OR distinct_id IN (${marks}))`, [...ids, ...ids]);
    await this.env.DB.batch([
      this.env.DB.prepare('DELETE FROM persons WHERE project = ? AND person_id = ?').bind(ctx.project, spec.person_id),
      this.env.DB.prepare('DELETE FROM identities WHERE project = ? AND person_id = ?').bind(ctx.project, spec.person_id),
    ]);
    return {
      project: ctx.project,
      id: spec.person_id,
      devices,
      eventsDeleted,
      replaysDeleted: replays,
      summary: eventsDeleted
        ? `Deleted person "${spec.person_id}", ${devices.length} device links, their events and ${replays} replays.`
        : `Deleted person "${spec.person_id}", device links and ${replays} replays. Events in the lake must be removed separately (see docs/privacy.md).`,
    };
  }

  // ── Cohorts ──────────────────────────────────────────────────────────────

  /** How many distinct people match a cohort definition in its look-back window. */
  async countCohort(input: unknown) {
    const spec = inputs.countCohort.parse(input);
    const ctx = await this.context(spec.project);
    const { count, sql, range } = await this.cohortMembership(ctx.project, {
      filters: spec.filters,
      didEvent: spec.didEvent,
      from: spec.from,
    });
    return {
      project: ctx.project,
      count,
      range,
      summary: `${count} ${count === 1 ? 'person' : 'people'} match this cohort in the selected window.`,
      sql: [sql],
    };
  }

  async listCohorts(input: unknown) {
    const spec = inputs.listCohorts.parse(input);
    const ctx = await this.context(spec.project);
    const { results } = await this.env.DB.prepare(
      'SELECT key, name, definition, created_at, updated_at FROM cohorts WHERE project = ? ORDER BY name COLLATE NOCASE',
    )
      .bind(ctx.project)
      .all<{ key: string; name: string; definition: string; created_at: number; updated_at: number }>();
    const cohorts = [];
    for (const row of results) {
      const definition = safeParse(row.definition) as { filters?: unknown; didEvent?: string; from?: string | number };
      const filters = Array.isArray(definition.filters) ? definition.filters : [];
      const parsed = inputs.cohortDefinition.parse({
        filters,
        didEvent: definition.didEvent,
        from: definition.from,
      });
      const { count, sql } = await this.cohortMembership(ctx.project, parsed);
      cohorts.push({
        key: row.key,
        name: row.name,
        filters: parsed.filters,
        didEvent: parsed.didEvent ?? null,
        from: parsed.from ?? '-90d',
        count,
        updatedAt: new Date(row.updated_at).toISOString(),
        sql: [sql],
        retention: this.link('insights/retention', {
          project: ctx.project,
          spec: {
            cohortEvent: { event: parsed.didEvent || '$pageview', filters: parsed.filters },
            returnEvent: { event: '$pageview' },
            period: 'week',
            periods: 8,
            filters: parsed.filters,
          },
        }),
      });
    }
    return {
      project: ctx.project,
      cohorts,
      summary: cohorts.length
        ? `${cohorts.length} cohort${cohorts.length === 1 ? '' : 's'}: ${cohorts.map((c) => `${c.name} (${c.count})`).join(', ')}.`
        : 'No cohorts yet. Save a person filter from the People tab.',
      dashboard: this.link('users', { project: ctx.project }),
    };
  }

  async saveCohort(input: unknown) {
    const spec = inputs.saveCohort.parse(input);
    if (spec.filters.some((f) => f.property === COHORT_PROPERTY)) {
      throw new HttpError(400, 'A cohort cannot filter on another cohort', 'Copy the other cohort\'s person filters into this one instead.');
    }
    const ctx = await this.context(spec.project);
    const key = (spec.key?.trim() || slugKey(spec.name)).slice(0, 64);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
      throw new HttpError(400, `Invalid cohort key "${key}"`, 'Use lowercase letters, numbers, hyphens or underscores.');
    }
    const definition = { filters: spec.filters, didEvent: spec.didEvent, from: spec.from ?? '-90d' };
    const now = Date.now();
    const existing = await this.env.DB.prepare('SELECT key FROM cohorts WHERE project = ? AND key = ?').bind(ctx.project, key).first();
    await this.env.DB.prepare(
      existing
        ? 'UPDATE cohorts SET name = ?, definition = ?, updated_at = ? WHERE project = ? AND key = ?'
        : 'INSERT INTO cohorts (project, key, name, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        ...(existing
          ? [spec.name, JSON.stringify(definition), now, ctx.project, key]
          : [ctx.project, key, spec.name, JSON.stringify(definition), now, now]),
      )
      .run();
    const { count, sql } = await this.cohortMembership(ctx.project, definition);
    return {
      project: ctx.project,
      key,
      name: spec.name,
      created: !existing,
      count,
      summary: `${existing ? 'Updated' : 'Created'} cohort "${spec.name}" (${count} people).`,
      sql: [sql],
      dashboard: this.link('users', { project: ctx.project }),
    };
  }

  async deleteCohort(input: unknown) {
    const spec = inputs.deleteCohort.parse(input);
    const ctx = await this.context(spec.project);
    const result = await this.env.DB.prepare('DELETE FROM cohorts WHERE project = ? AND key = ?').bind(ctx.project, spec.key).run();
    if (!result.meta.changes) throw new HttpError(404, `No cohort "${spec.key}"`);
    return { project: ctx.project, deleted: spec.key, summary: `Deleted cohort "${spec.key}".` };
  }

  /**
   * Attach saved definitions to every `cohort` filter in a query spec, so core
   * can compile membership without reading the cohorts table. Returns a copy.
   */
  private async resolveCohorts<T>(project: string, spec: T): Promise<T> {
    const refs: Filter[] = [];
    const copy = structuredClone(spec);
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if (o.property === COHORT_PROPERTY) refs.push(o as unknown as Filter);
        else Object.values(o).forEach(walk);
      }
    };
    walk(copy);
    if (refs.length === 0) return copy;
    const { results } = await this.env.DB.prepare('SELECT key, definition FROM cohorts WHERE project = ?').bind(project).all<{ key: string; definition: string }>();
    const saved = new Map(results.map((r) => [r.key, r.definition]));
    const now = Date.now();
    for (const f of refs) {
      f.cohorts = {};
      for (const key of toList(f.value)) {
        const raw = saved.get(key);
        if (raw === undefined) {
          throw new HttpError(400, `No cohort "${key}" in project "${project}"`, saved.size ? `Saved cohorts: ${[...saved.keys()].join(', ')}.` : 'Save one with save_cohort or from the People tab first.');
        }
        const def = inputs.cohortDefinition.parse(safeParse(raw));
        const range = resolveRange(def.from ?? '-90d', undefined, now);
        const members: CohortMembers = { project, from: range.from, to: range.to, filters: def.filters as Filter[] };
        if (def.didEvent) members.events = [def.didEvent];
        f.cohorts[key] = members;
      }
    }
    return copy;
  }

  private async cohortMembership(
    project: string,
    definition: { filters?: Filter[]; didEvent?: string; from?: string | number },
  ): Promise<{ count: number; sql: string; range: { from: number; to: number } }> {
    const range = resolveRange(definition.from ?? '-90d', undefined);
    const d = this.store.dialect;
    const sql = `WITH ${eventsCte(d, {
      project,
      from: range.from,
      to: range.to,
      events: definition.didEvent ? [definition.didEvent] : undefined,
      filters: definition.filters,
    })}
SELECT COUNT(DISTINCT pid) AS n FROM ev`;
    const count = num((await this.store.query(sql))[0]?.n);
    return { count, sql, range };
  }

  // ── Replays ──────────────────────────────────────────────────────────────

  async listReplays(input: unknown) {
    const spec = inputs.listReplays.parse(input);
    const ctx = await this.context(spec.project);
    if (!replaysEnabled(this.env)) return { project: ctx.project, enabled: false, replays: [], summary: 'Session replay is not enabled on this deployment.' };
    const rows = await listReplays(this.env.DB, ctx.project, {
      person: spec.person,
      withErrors: spec.with_errors,
      from: spec.from === undefined ? undefined : resolveRange(spec.from, undefined).from,
      limit: spec.limit,
    });
    return {
      project: ctx.project,
      enabled: true,
      replays: rows.map((r) => ({
        session: r.session_id,
        person: r.user_id ?? r.distinct_id,
        started: new Date(r.started_at).toISOString(),
        durationSeconds: Math.round((r.ended_at - r.started_at) / 1000),
        clicks: r.clicks,
        errors: r.errors,
        url: r.start_url,
        device: [r.device, r.browser, r.country].filter(Boolean).join(', '),
        dashboard: this.link(`replays/${r.session_id}`, { project: ctx.project }),
      })),
      summary: `${rows.length} recorded session${rows.length === 1 ? '' : 's'}${spec.with_errors ? ' with errors' : ''}. Use summarise_replay to read one.`,
    };
  }

  async replayEvents(input: unknown) {
    const spec = inputs.replay.parse(input);
    const ctx = await this.context(spec.project);
    const meta = await getReplay(this.env.DB, ctx.project, spec.session_id);
    if (!meta) throw new HttpError(404, `No replay for session "${spec.session_id}"`);
    return { meta, events: await loadReplayEvents(this.env, ctx.project, spec.session_id) };
  }

  /** A text transcript of a session: what the user saw, clicked, typed into, and what broke. */
  async summariseReplay(input: unknown) {
    const spec = inputs.replay.parse(input);
    const ctx = await this.context(spec.project);
    const meta = await getReplay(this.env.DB, ctx.project, spec.session_id);
    if (!meta) throw new HttpError(404, `No replay for session "${spec.session_id}"`);
    const pages = await loadReplayPages(this.env, ctx.project, spec.session_id);
    const d = this.store.dialect;
    const sql = `SELECT event, ts_ms, path, title, props FROM ${d.table('events')}
WHERE project = ${d.str(ctx.project)} AND session_id = ${d.str(spec.session_id)}
  AND ts_ms >= ${meta.started_at - 60_000} AND ts_ms <= ${meta.ended_at + 60_000}
ORDER BY ts_ms LIMIT 2000`;
    const glassEvents = (await this.store.query(sql)).map((r) => ({
      event: text(r.event),
      ts_ms: num(r.ts_ms),
      path: text(r.path),
      title: text(r.title),
      props: safeParse(text(r.props)),
    }));
    const summary = summariseReplay(pages.map((p) => p.events), glassEvents, {
      sessionId: spec.session_id,
      person: meta.user_id ?? meta.distinct_id,
      device: [meta.device, meta.browser, meta.country].filter(Boolean).join(', '),
    });
    return {
      project: ctx.project,
      session: spec.session_id,
      transcript: summary.text,
      stats: summary.stats,
      summary: summary.text.split('\n').slice(0, 4).join(' '),
      dashboard: this.link(`replays/${spec.session_id}`, { project: ctx.project }),
    };
  }

  // ── Flags ────────────────────────────────────────────────────────────────

  async listFlags(input: unknown) {
    const ctx = await this.context(z.object({ project }).parse(input).project);
    const flags = await listFlags(this.env.DB, ctx.project, true);
    return {
      project: ctx.project,
      flags,
      summary: `${flags.length} flag${flags.length === 1 ? '' : 's'}: ${flags.map((f) => `${f.key} (${f.enabled ? `${f.rollout}%` : 'off'})`).join(', ') || 'none'}.`,
      dashboard: this.link('flags', { project: ctx.project }),
    };
  }

  async getFlag(input: unknown) {
    const spec = inputs.flagKey.parse(input);
    const ctx = await this.context(spec.project);
    const flag = await getFlag(this.env.DB, ctx.project, spec.key);
    if (!flag) throw new HttpError(404, `No flag "${spec.key}"`);
    return { project: ctx.project, flag };
  }

  async saveFlag(input: unknown) {
    const spec = inputs.saveFlag.parse(input);
    const ctx = await this.context(spec.project);
    const { project: _, ...definition } = spec;
    const result = await saveFlag(this.env.DB, ctx.project, definition);
    return {
      project: ctx.project,
      ...result,
      summary: `${result.created ? 'Created' : 'Updated'} flag "${spec.key}"${result.changed.length && !result.created ? ` (${result.changed.join(', ')})` : ''}: ${result.flag.enabled ? `${result.flag.rollout}% rollout` : 'disabled'}. Read it with glass.flag("${spec.key}").`,
    };
  }

  async deleteFlag(input: unknown) {
    const spec = inputs.flagKey.parse(input);
    const ctx = await this.context(spec.project);
    const deleted = await deleteFlag(this.env.DB, ctx.project, spec.key);
    if (!deleted) throw new HttpError(404, `No flag "${spec.key}"`);
    return { project: ctx.project, deleted: spec.key, summary: `Deleted flag "${spec.key}". Remove it from your code too.` };
  }

  // ── Experiments ──────────────────────────────────────────────────────────

  async listExperiments(input: unknown) {
    const ctx = await this.context(z.object({ project }).parse(input).project);
    const experiments = await listExperiments(this.env.DB, ctx.project);
    return {
      project: ctx.project,
      experiments,
      summary: `${experiments.length} experiment${experiments.length === 1 ? '' : 's'}: ${experiments.map((e) => `${e.key} (${e.status})`).join(', ') || 'none'}.`,
      dashboard: this.link('experiments', { project: ctx.project }),
    };
  }

  async createExperiment(input: unknown) {
    const spec = inputs.createExperiment.parse(input);
    const ctx = await this.context(spec.project);
    const experiment = await createExperiment(this.env.DB, ctx.project, spec as CreateExperimentInput);
    return {
      project: ctx.project,
      experiment,
      summary: `Created experiment "${experiment.key}" on flag "${experiment.flag}" (draft). In code, branch on glass.flag("${experiment.flag}") — it records exposures — then start it with update_experiment.`,
      dashboard: this.link(`experiments/${experiment.key}`, { project: ctx.project }),
    };
  }

  async experimentResults(input: unknown) {
    const spec = inputs.experimentKey.parse(input);
    const ctx = await this.context(spec.project);
    const experiment = await getExperiment(this.env.DB, ctx.project, spec.key);
    const flag = await getFlag(this.env.DB, ctx.project, experiment.flag);
    const weights = Object.fromEntries((flag?.variants ?? []).map((v) => [v.key, v.weight]));
    // Ten minutes of slack absorbs client clock correction around the start time.
    const from = (experiment.startedAt ?? experiment.createdAt) - 10 * 60_000;
    const results = await runExperiment(
      experimentSpec.parse({
        project: ctx.project,
        flag: experiment.flag,
        goal: experiment.goal,
        variants: flag?.variants?.map((v) => v.key),
        from,
        to: experiment.endedAt ?? 'now',
      }),
      { dialect: this.store.dialect, project: ctx.project, execute: (sql) => this.store.query(sql) },
      { weights },
    );
    return {
      project: ctx.project,
      experiment,
      results,
      summary: `[${experiment.status}] ${results.summary}`,
      dashboard: this.link(`experiments/${experiment.key}`, { project: ctx.project }),
    };
  }

  async updateExperiment(input: unknown) {
    const spec = inputs.updateExperiment.parse(input);
    const ctx = await this.context(spec.project);
    const { experiment, flag } = await transitionExperiment(this.env.DB, ctx.project, spec.key, spec.action, spec.variant);
    const verb = { start: 'Started', stop: 'Stopped', ship: `Shipped "${spec.variant}" for` }[spec.action];
    return { project: ctx.project, experiment, flag, summary: `${verb} experiment "${spec.key}". Flag "${flag.key}" is now ${flag.enabled ? 'on' : 'off'}.` };
  }

  // ── Projects ─────────────────────────────────────────────────────────────

  async listProjects() {
    const projects = await listProjects(this.env.DB);
    return { projects, summary: `${projects.length} project${projects.length === 1 ? '' : 's'}: ${projects.map((p) => p.id).join(', ') || 'none'}.` };
  }

  async createProject(input: unknown) {
    const spec = inputs.createProject.parse(input);
    const created = await createProject(this.env.DB, { id: spec.id, name: spec.name, allowedOrigins: spec.allowed_origins });
    await this.seedDefaultInsights(created.id);
    return { project: created, summary: `Project "${created.id}" is ready. Use data-project="${created.id}" in the snippet.` };
  }

  // ── Saved insights ───────────────────────────────────────────────────────

  async listInsights(input: unknown) {
    const spec = inputs.listInsights.parse(input);
    const ctx = await this.context(spec.project);
    await this.seedDefaultInsights(ctx.project);
    const { results } = await this.env.DB.prepare(
      'SELECT key, name, description, kind, spec, created_at, updated_at FROM insights WHERE project = ? ORDER BY name COLLATE NOCASE',
    )
      .bind(ctx.project)
      .all<{ key: string; name: string; description: string; kind: string; spec: string; created_at: number; updated_at: number }>();
    const insights = results.map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      kind: r.kind as 'trends' | 'funnel' | 'retention',
      spec: safeParse(r.spec),
      updatedAt: new Date(r.updated_at).toISOString(),
      dashboard: this.link(`insights/${r.key}`, { project: ctx.project }),
    }));
    return {
      project: ctx.project,
      insights,
      summary: insights.length
        ? `${insights.length} saved analysis${insights.length === 1 ? '' : 'es'}.`
        : 'No saved analyses yet.',
      dashboard: this.link('insights', { project: ctx.project }),
    };
  }

  async getInsight(input: unknown) {
    const spec = inputs.getInsight.parse(input);
    const ctx = await this.context(spec.project);
    await this.seedDefaultInsights(ctx.project);
    const row = await this.env.DB.prepare(
      'SELECT key, name, description, kind, spec, created_at, updated_at FROM insights WHERE project = ? AND key = ?',
    )
      .bind(ctx.project, spec.key)
      .first<{ key: string; name: string; description: string; kind: string; spec: string; created_at: number; updated_at: number }>();
    if (!row) throw new HttpError(404, `No saved analysis "${spec.key}"`);
    return {
      project: ctx.project,
      key: row.key,
      name: row.name,
      description: row.description,
      kind: row.kind as 'trends' | 'funnel' | 'retention',
      spec: safeParse(row.spec),
      updatedAt: new Date(row.updated_at).toISOString(),
      dashboard: this.link(`insights/${row.key}`, { project: ctx.project }),
    };
  }

  async saveInsight(input: unknown) {
    const spec = inputs.saveInsight.parse(input);
    const ctx = await this.context(spec.project);
    const key = (spec.key?.trim() || slugKey(spec.name)).slice(0, 64);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
      throw new HttpError(400, `Invalid insight key "${key}"`, 'Use lowercase letters, numbers, hyphens or underscores.');
    }
    if (key === 'new' || insightKind.safeParse(key).success) {
      throw new HttpError(400, `Key "${key}" is reserved`, 'Pick another name; trends, funnel, retention and new are used by the UI.');
    }
    const now = Date.now();
    const existing = await this.env.DB.prepare('SELECT key FROM insights WHERE project = ? AND key = ?').bind(ctx.project, key).first();
    const description = spec.description ?? '';
    const body = JSON.stringify(spec.spec);
    await this.env.DB.prepare(
      existing
        ? 'UPDATE insights SET name = ?, description = ?, kind = ?, spec = ?, updated_at = ? WHERE project = ? AND key = ?'
        : 'INSERT INTO insights (project, key, name, description, kind, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        ...(existing
          ? [spec.name, description, spec.kind, body, now, ctx.project, key]
          : [ctx.project, key, spec.name, description, spec.kind, body, now, now]),
      )
      .run();
    return {
      project: ctx.project,
      key,
      name: spec.name,
      description,
      kind: spec.kind,
      created: !existing,
      summary: `${existing ? 'Updated' : 'Saved'} analysis "${spec.name}".`,
      dashboard: this.link(`insights/${key}`, { project: ctx.project }),
    };
  }

  async deleteInsight(input: unknown) {
    const spec = inputs.deleteInsight.parse(input);
    const ctx = await this.context(spec.project);
    const result = await this.env.DB.prepare('DELETE FROM insights WHERE project = ? AND key = ?').bind(ctx.project, spec.key).run();
    if (!result.meta.changes) throw new HttpError(404, `No saved analysis "${spec.key}"`);
    return { project: ctx.project, deleted: spec.key, summary: `Deleted analysis "${spec.key}".` };
  }

  /** Seed starter analyses once per project (new creates and empty existing projects). */
  private async seedDefaultInsights(projectId: string): Promise<void> {
    const row = await this.env.DB.prepare('SELECT COUNT(*) AS n FROM insights WHERE project = ?').bind(projectId).first<{ n: number }>();
    if (Number(row?.n ?? 0) > 0) return;
    const now = Date.now();
    await this.env.DB.batch(
      DEFAULT_INSIGHTS.map((insight) =>
        this.env.DB.prepare(
          'INSERT OR IGNORE INTO insights (project, key, name, description, kind, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(projectId, insight.key, insight.name, insight.description, insight.kind, JSON.stringify(insight.spec), now, now),
      ),
    );
  }
}

function safeParse(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

function slugKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'cohort';
}

