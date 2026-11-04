/**
 * Experiments: a flag with a goal and a lifecycle.
 *
 *   draft → running → stopped → shipped
 *
 * Starting enables the flag. Shipping sets the flag to the winning variant for
 * 100% of users and stops the experiment. Results are computed on demand from
 * `$exposure` events (see packages/core/src/insights/experiment.ts).
 */

import type { FlagDefinition } from '@glassanalytics/core/flags';
import type { D1Database } from './env.ts';
import { getFlag, saveFlag } from './flags.ts';
import { HttpError } from './http.ts';

export type ExperimentStatus = 'draft' | 'running' | 'stopped' | 'shipped';

export interface ExperimentGoal {
  event: string;
  filters?: { property: string; op?: string; value?: unknown }[];
  value?: string;
}

export interface Experiment {
  key: string;
  flag: string;
  status: ExperimentStatus;
  goal: ExperimentGoal;
  secondary: ExperimentGoal[];
  hypothesis: string;
  startedAt: number | null;
  endedAt: number | null;
  shippedVariant: string | null;
  createdAt: number;
}

interface Row {
  key: string;
  flag_key: string;
  definition: string;
  status: ExperimentStatus;
  started_at: number | null;
  ended_at: number | null;
  shipped_variant: string | null;
  created_at: number;
}

function toExperiment(r: Row): Experiment {
  const def = JSON.parse(r.definition) as {
    goal: ExperimentGoal;
    secondary?: ExperimentGoal[];
    hypothesis?: string;
  };
  return {
    key: r.key,
    flag: r.flag_key,
    status: r.status,
    goal: def.goal,
    secondary: def.secondary ?? [],
    hypothesis: def.hypothesis ?? '',
    startedAt: r.started_at,
    endedAt: r.ended_at,
    shippedVariant: r.shipped_variant,
    createdAt: r.created_at,
  };
}

export async function listExperiments(db: D1Database, project: string): Promise<Experiment[]> {
  const { results } = await db
    .prepare('SELECT * FROM experiments WHERE project = ? ORDER BY created_at DESC')
    .bind(project)
    .all<Row>();
  return results.map(toExperiment);
}

export async function getExperiment(
  db: D1Database,
  project: string,
  key: string,
): Promise<Experiment> {
  const row = await db
    .prepare('SELECT * FROM experiments WHERE project = ? AND key = ?')
    .bind(project, key)
    .first<Row>();
  if (!row) throw new HttpError(404, `No experiment "${key}"`);
  return toExperiment(row);
}

export interface CreateExperimentInput {
  key: string;
  flag?: string;
  goal: ExperimentGoal;
  secondary?: ExperimentGoal[];
  hypothesis?: string;
  /** Variants for a new flag. Default control/test 50/50. */
  variants?: { key: string; weight: number }[];
}

/** Create an experiment, creating its flag (disabled until start) if needed. */
export async function createExperiment(
  db: D1Database,
  project: string,
  input: CreateExperimentInput,
): Promise<Experiment> {
  const flagKey = input.flag ?? input.key;
  let flag = await getFlag(db, project, flagKey);
  if (!flag) {
    flag = (
      await saveFlag(db, project, {
        key: flagKey,
        description: `Experiment: ${input.hypothesis ?? input.key}`,
        enabled: false,
        rollout: 100,
        variants: input.variants ?? [
          { key: 'control', weight: 50 },
          { key: 'test', weight: 50 },
        ],
      })
    ).flag;
  }
  if (!flag.variants || flag.variants.length < 2) {
    throw new HttpError(400, `Flag "${flagKey}" needs at least two variants to run an experiment`);
  }
  const now = Date.now();
  await db
    .prepare(
      'INSERT INTO experiments (project, key, flag_key, definition, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      project,
      input.key,
      flagKey,
      JSON.stringify({
        goal: input.goal,
        secondary: input.secondary ?? [],
        hypothesis: input.hypothesis ?? '',
      }),
      'draft',
      now,
      now,
    )
    .run()
    .catch((err: unknown) => {
      if (String(err).includes('UNIQUE'))
        throw new HttpError(409, `Experiment "${input.key}" already exists`);
      throw err;
    });
  return getExperiment(db, project, input.key);
}

export async function transitionExperiment(
  db: D1Database,
  project: string,
  key: string,
  action: 'start' | 'stop' | 'ship',
  variant?: string,
): Promise<{ experiment: Experiment; flag: FlagDefinition }> {
  const exp = await getExperiment(db, project, key);
  const flag = await getFlag(db, project, exp.flag);
  if (!flag) throw new HttpError(409, `Flag "${exp.flag}" no longer exists`);
  const now = Date.now();
  if (action === 'start') {
    if (exp.status === 'running') throw new HttpError(409, 'Experiment is already running');
    if (exp.status === 'shipped')
      throw new HttpError(409, 'Experiment has shipped; create a new one');
    await saveFlag(db, project, { ...flag, enabled: true });
    await db
      .prepare(
        "UPDATE experiments SET status = 'running', started_at = COALESCE(started_at, ?), ended_at = NULL, updated_at = ? WHERE project = ? AND key = ?",
      )
      .bind(now, now, project, key)
      .run();
  } else if (action === 'stop') {
    if (exp.status !== 'running')
      throw new HttpError(409, `Experiment is ${exp.status}, not running`);
    await db
      .prepare(
        "UPDATE experiments SET status = 'stopped', ended_at = ?, updated_at = ? WHERE project = ? AND key = ?",
      )
      .bind(now, now, project, key)
      .run();
  } else {
    if (!variant || !flag.variants?.some((v) => v.key === variant)) {
      throw new HttpError(
        400,
        `Pass the variant to ship, one of: ${(flag.variants ?? []).map((v) => v.key).join(', ')}`,
      );
    }
    // Everyone gets the shipped variant from now on.
    await saveFlag(db, project, {
      ...flag,
      enabled: true,
      rollout: 100,
      rules: [{ conditions: [], rollout: 100, variant }],
    });
    await db
      .prepare(
        "UPDATE experiments SET status = 'shipped', ended_at = COALESCE(ended_at, ?), shipped_variant = ?, updated_at = ? WHERE project = ? AND key = ?",
      )
      .bind(now, variant, now, project, key)
      .run();
  }
  return {
    experiment: await getExperiment(db, project, key),
    flag: (await getFlag(db, project, exp.flag))!,
  };
}
