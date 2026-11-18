/**
 * Feature flag storage, history, schedules and the public evaluation endpoint (`POST /f`).
 *
 * Flags are evaluated on the server so targeting rules (which may mention
 * person properties) are never shipped to browsers. Backends can evaluate
 * locally instead with the definitions from `GET /api/flags/definitions`
 * (server key), which is what dataflare-node does.
 */

import type { EvaluationContext } from '@dataflare/core/filters';
import {
  EARLY_ACCESS_PROPERTY,
  evaluateFlagsDetailed,
  type FlagDefinition,
  payloadsFor,
  validateFlag,
  validateFlagSet,
} from '@dataflare/core/flags';
import { sha256Hex } from '@dataflare/core/hash';
import { parseUserAgent } from '@dataflare/core/ua';
import { cohortsOf, cohortsUsedByFlags } from './cohorts.ts';
import type { D1Database, Env } from './env.ts';
import { HttpError, readJson } from './http.ts';
import { requestInfo } from './ingest.ts';
import { getProject } from './projects.ts';

const cache = new Map<string, { flags: FlagDefinition[]; until: number }>();
const TTL_MS = 10_000;

export async function listFlags(
  db: D1Database,
  project: string,
  fresh = false,
): Promise<FlagDefinition[]> {
  const hit = cache.get(project);
  if (!fresh && hit && hit.until > Date.now()) return hit.flags;
  const { results } = await db
    .prepare('SELECT definition FROM flags WHERE project = ? ORDER BY key')
    .bind(project)
    .all<{ definition: string }>();
  const flags = results.map((r) => JSON.parse(r.definition) as FlagDefinition);
  cache.set(project, { flags, until: Date.now() + TTL_MS });
  return flags;
}

export function clearFlagCache(): void {
  cache.clear();
}

export async function getFlag(
  db: D1Database,
  project: string,
  key: string,
): Promise<FlagDefinition | null> {
  const row = await db
    .prepare('SELECT definition FROM flags WHERE project = ? AND key = ?')
    .bind(project, key)
    .first<{ definition: string }>();
  return row ? (JSON.parse(row.definition) as FlagDefinition) : null;
}

/** Fields of a flag that can be set (and scheduled). */
export type FlagInput = Partial<FlagDefinition> & { key: string };

const FIELDS = [
  'description',
  'enabled',
  'rollout',
  'variants',
  'rules',
  'salt',
  'payloads',
  'bucketBy',
  'earlyAccess',
  'holdout',
  'tags',
] as const;

async function recordChange(
  db: D1Database,
  project: string,
  key: string,
  action: 'create' | 'update' | 'delete' | 'schedule',
  actor: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO flag_changes (project, id, flag_key, at, action, actor, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      project,
      crypto.randomUUID(),
      key,
      Date.now(),
      action,
      actor,
      before === null || before === undefined ? null : JSON.stringify(before),
      after === null || after === undefined ? null : JSON.stringify(after),
    )
    .run();
}

/** Create or replace a flag. Returns the stored definition and what changed. */
export async function saveFlag(db: D1Database, project: string, input: FlagInput, actor = '') {
  const existing = await getFlag(db, project, input.key);
  const flag: FlagDefinition = {
    key: input.key,
    enabled: input.enabled ?? existing?.enabled ?? true,
    rollout: input.rollout ?? existing?.rollout ?? 100,
  };
  for (const f of FIELDS) {
    if (f === 'enabled' || f === 'rollout') continue;
    // null clears a field; undefined keeps it.
    const v = (input as Record<string, unknown>)[f];
    const value = v === undefined ? (existing as Record<string, unknown> | null)?.[f] : v;
    if (value !== undefined && value !== null)
      (flag as unknown as Record<string, unknown>)[f] = value;
  }
  const problems = validateFlag(flag);
  const others = (await listFlags(db, project, true)).filter((f) => f.key !== flag.key);
  problems.push(
    ...validateFlagSet([...others, flag]).filter(
      (p) => p.includes(`"${flag.key}"`) || p.includes(flag.key),
    ),
  );
  if (problems.length) throw new HttpError(400, `Invalid flag: ${problems.join('; ')}`);
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO flags (project, key, definition, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project, key) DO UPDATE SET definition = excluded.definition, updated_at = excluded.updated_at`,
    )
    .bind(project, flag.key, JSON.stringify(flag), now, now)
    .run();
  cache.delete(project);
  const changed = Object.keys({ ...flag, ...(existing ?? {}) }).filter(
    (k) =>
      JSON.stringify((flag as unknown as Record<string, unknown>)[k]) !==
      JSON.stringify((existing as unknown as Record<string, unknown> | null)?.[k]),
  );
  if (!existing || changed.length) {
    await recordChange(
      db,
      project,
      flag.key,
      existing ? 'update' : 'create',
      actor,
      existing,
      flag,
    );
  }
  return { flag, created: !existing, changed };
}

export async function deleteFlag(
  db: D1Database,
  project: string,
  key: string,
  actor = '',
): Promise<boolean> {
  const dependents = (await listFlags(db, project, true)).filter((f) =>
    (f.rules ?? []).some((r) => r.conditions.some((c) => c.property === `flag.${key}`)),
  );
  if (dependents.length) {
    throw new HttpError(
      409,
      `Flag "${key}" is used by ${dependents.map((f) => `"${f.key}"`).join(', ')}`,
      'Remove the flag.<key> condition from those flags first.',
    );
  }
  const existing = await getFlag(db, project, key);
  const res = await db
    .prepare('DELETE FROM flags WHERE project = ? AND key = ?')
    .bind(project, key)
    .run();
  cache.delete(project);
  const deleted = (res.meta.changes ?? 0) > 0;
  if (deleted) await recordChange(db, project, key, 'delete', actor, existing, null);
  return deleted;
}

export async function flagHistory(db: D1Database, project: string, key: string, limit = 50) {
  const { results } = await db
    .prepare(
      'SELECT at, action, actor, before, after FROM flag_changes WHERE project = ? AND flag_key = ? ORDER BY at DESC LIMIT ?',
    )
    .bind(project, key, limit)
    .all<{
      at: number;
      action: string;
      actor: string;
      before: string | null;
      after: string | null;
    }>();
  return results.map((r) => {
    const before = r.before ? (JSON.parse(r.before) as Record<string, unknown>) : null;
    const after = r.after ? (JSON.parse(r.after) as Record<string, unknown>) : null;
    const changed =
      before && after
        ? Object.keys({ ...before, ...after }).filter(
            (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
          )
        : [];
    return {
      at: new Date(r.at).toISOString(),
      action: r.action,
      actor: r.actor,
      changed,
      before,
      after,
    };
  });
}

// ── Schedules ──────────────────────────────────────────────────────────────

export async function scheduleFlagChange(
  db: D1Database,
  project: string,
  key: string,
  runAt: number,
  change: Record<string, unknown>,
  actor = '',
) {
  if (!(await getFlag(db, project, key))) throw new HttpError(404, `No flag "${key}"`);
  const allowed = new Set<string>(['enabled', 'rollout', 'variants', 'rules', 'payloads']);
  const bad = Object.keys(change).filter((k) => !allowed.has(k));
  if (bad.length)
    throw new HttpError(
      400,
      `Can't schedule ${bad.join(', ')}`,
      `Schedule: ${[...allowed].join(', ')}.`,
    );
  if (Object.keys(change).length === 0) throw new HttpError(400, 'Nothing to change');
  const id = crypto.randomUUID().slice(0, 12);
  await db
    .prepare(
      'INSERT INTO flag_schedules (project, id, flag_key, run_at, change, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(project, id, key, runAt, JSON.stringify(change), Date.now())
    .run();
  await recordChange(db, project, key, 'schedule', actor, null, {
    runAt: new Date(runAt).toISOString(),
    change,
  });
  return { id, flag: key, runAt: new Date(runAt).toISOString(), change, status: 'pending' };
}

export async function listFlagSchedules(db: D1Database, project: string, key?: string) {
  const { results } = await db
    .prepare(
      `SELECT id, flag_key, run_at, change, status, executed_at, error FROM flag_schedules
       WHERE project = ? ${key ? 'AND flag_key = ?' : ''} ORDER BY run_at DESC LIMIT 100`,
    )
    .bind(project, ...(key ? [key] : []))
    .all<{
      id: string;
      flag_key: string;
      run_at: number;
      change: string;
      status: string;
      executed_at: number | null;
      error: string | null;
    }>();
  return results.map((r) => ({
    id: r.id,
    flag: r.flag_key,
    runAt: new Date(r.run_at).toISOString(),
    change: JSON.parse(r.change) as Record<string, unknown>,
    status: r.status,
    executedAt: r.executed_at ? new Date(r.executed_at).toISOString() : null,
    ...(r.error ? { error: r.error } : {}),
  }));
}

export async function cancelFlagSchedule(
  db: D1Database,
  project: string,
  id: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE flag_schedules SET status = 'cancelled' WHERE project = ? AND id = ? AND status = 'pending'",
    )
    .bind(project, id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Maintenance: apply scheduled changes that are due. */
export async function applyDueSchedules(db: D1Database, now: number): Promise<number> {
  const { results } = await db
    .prepare(
      "SELECT project, id, flag_key, change FROM flag_schedules WHERE status = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 20",
    )
    .bind(now)
    .all<{ project: string; id: string; flag_key: string; change: string }>();
  let applied = 0;
  for (const r of results) {
    try {
      await saveFlag(
        db,
        r.project,
        { key: r.flag_key, ...(JSON.parse(r.change) as object) },
        'schedule',
      );
      await db
        .prepare(
          "UPDATE flag_schedules SET status = 'done', executed_at = ? WHERE project = ? AND id = ?",
        )
        .bind(now, r.project, r.id)
        .run();
      applied++;
    } catch (err) {
      await db
        .prepare(
          "UPDATE flag_schedules SET status = 'failed', executed_at = ?, error = ? WHERE project = ? AND id = ?",
        )
        .bind(now, err instanceof Error ? err.message : String(err), r.project, r.id)
        .run();
    }
  }
  return applied;
}

// ── Evaluation ─────────────────────────────────────────────────────────────

/** Build the evaluation context for a user from D1 and the request. */
export async function flagContext(
  db: D1Database,
  project: string,
  distinctId: string,
  userId: string | null,
  request?: Request,
  withCohorts = false,
  groups: Record<string, string> = {},
  withGroupProps = false,
): Promise<EvaluationContext> {
  let personId = userId;
  if (!personId) {
    const link = await db
      .prepare('SELECT person_id FROM identities WHERE project = ? AND distinct_id = ?')
      .bind(project, distinctId)
      .first<{ person_id: string }>();
    personId = link?.person_id ?? null;
  }
  const row = personId
    ? await db
        .prepare('SELECT props FROM persons WHERE project = ? AND person_id = ?')
        .bind(project, personId)
        .first<{ props: string }>()
    : await db
        .prepare('SELECT props FROM persons WHERE project = ? AND person_id = ?')
        .bind(project, distinctId)
        .first<{ props: string }>();
  const info = request ? requestInfo(request) : null;
  const ua = info ? parseUserAgent(info.userAgent) : null;
  let groupProps: Record<string, Record<string, unknown>> | undefined;
  if (withGroupProps && Object.keys(groups).length) {
    const { results } = await db
      .prepare(
        `SELECT type, props FROM groups WHERE project = ?1 AND (type || char(0) || key) IN (SELECT value FROM json_each(?2))`,
      )
      .bind(project, JSON.stringify(Object.entries(groups).map(([t, k]) => `${t}\u0000${k}`)))
      .all<{ type: string; props: string }>();
    groupProps = Object.fromEntries(
      results.map((r) => [r.type, JSON.parse(r.props) as Record<string, unknown>]),
    );
  }
  return {
    distinct_id: distinctId,
    user_id: personId ?? userId,
    person: row ? (JSON.parse(row.props) as Record<string, unknown>) : {},
    ...(withCohorts
      ? {
          cohorts: await cohortsOf(db, project, [...new Set([personId ?? distinctId, distinctId])]),
        }
      : {}),
    groups,
    ...(groupProps ? { groupProps } : {}),
    country: info?.country ?? '',
    region: info?.region ?? '',
    city: info?.city ?? '',
    device: ua?.device ?? '',
    browser: ua?.browser ?? '',
    os: ua?.os ?? '',
  };
}

export interface FlagResponse {
  flags: Record<string, string>;
  payloads?: Record<string, unknown>;
  /** Whether ?__glass_flags= overrides are allowed in this project (for QA). */
  allowOverrides?: boolean;
  /** Early-access features this person can opt into, with their choice. */
  earlyAccess?: {
    key: string;
    name: string;
    description?: string;
    docsUrl?: string;
    stage: string;
    enrolled: boolean | null;
  }[];
  /** With debug: why each flag has its value. */
  reasons?: Record<string, string>;
}

function referencesGroupProps(flags: FlagDefinition[]): boolean {
  return flags.some((f) =>
    (f.rules ?? []).some((r) => r.conditions.some((c) => /^group\.[^.]+\./.test(c.property))),
  );
}

export async function handleFlagEvaluation(request: Request, env: Env): Promise<FlagResponse> {
  const body = await readJson<{
    project?: string;
    distinct_id?: string | null;
    user_id?: string | null;
    groups?: Record<string, unknown>;
    early_access?: boolean;
    debug?: boolean;
  }>(request, 10_000);
  const project = body.project ? await getProject(env.DB, body.project) : null;
  if (!project) throw new HttpError(404, 'Unknown project');
  const allowOverrides = project.settings.allowFlagOverrides ? { allowOverrides: true } : {};
  // Cookieless visitors have no stable id, so they can't be bucketed consistently.
  if (!body.distinct_id) return { flags: {}, ...allowOverrides };
  const flags = await listFlags(env.DB, project.id);
  if (flags.length === 0)
    return { flags: {}, ...allowOverrides, ...(body.early_access ? { earlyAccess: [] } : {}) };
  const groups: Record<string, string> = {};
  for (const [t, k] of Object.entries(body.groups ?? {})) {
    if (typeof k === 'string' || typeof k === 'number') groups[t] = String(k);
  }
  const ctx = await flagContext(
    env.DB,
    project.id,
    String(body.distinct_id),
    body.user_id ? String(body.user_id) : null,
    request,
    cohortsUsedByFlags(flags).size > 0,
    groups,
    referencesGroupProps(flags),
  );
  const results = evaluateFlagsDetailed(flags, ctx);
  const values: Record<string, string> = {};
  for (const [k, r] of Object.entries(results)) if (r.value !== null) values[k] = r.value;
  const payloads = payloadsFor(flags, values);
  const response: FlagResponse = { flags: values, ...allowOverrides };
  if (Object.keys(payloads).length) response.payloads = payloads;
  if (body.early_access) {
    const choices = (ctx.person?.[EARLY_ACCESS_PROPERTY] ?? {}) as Record<string, unknown>;
    response.earlyAccess = flags
      .filter((f) => f.earlyAccess && f.enabled)
      .map((f) => ({
        key: f.key,
        name: f.earlyAccess!.name,
        ...(f.earlyAccess!.description ? { description: f.earlyAccess!.description } : {}),
        ...(f.earlyAccess!.docsUrl ? { docsUrl: f.earlyAccess!.docsUrl } : {}),
        stage: f.earlyAccess!.stage,
        enrolled: typeof choices[f.key] === 'boolean' ? (choices[f.key] as boolean) : null,
      }));
  }
  if (body.debug)
    response.reasons = Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.reason]));
  return response;
}

/**
 * What a backend needs to evaluate flags itself: the definitions, the members of cohorts they
 * target (static lists and materialised dynamic cohorts), and an ETag to poll cheaply.
 */
export async function flagDefinitions(env: Env, project: string) {
  const flags = await listFlags(env.DB, project, true);
  const cohorts: Record<string, string[]> = {};
  for (const key of cohortsUsedByFlags(flags)) {
    const { results } = await env.DB.prepare(
      'SELECT person_id FROM cohort_members WHERE project = ? AND cohort = ? LIMIT 10001',
    )
      .bind(project, key)
      .all<{ person_id: string }>();
    cohorts[key] = results.slice(0, 10_000).map((r) => r.person_id);
  }
  const body = { project, flags, cohorts };
  const etag = `"${(await sha256Hex(JSON.stringify(body))).slice(0, 32)}"`;
  return { ...body, etag };
}
