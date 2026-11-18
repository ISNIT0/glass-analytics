/**
 * Scheduled work (one Cron Trigger, every five minutes).
 *
 * Every tick runs the registered `FREQUENT_TASKS` (scheduled flag changes, error alerts,
 * batch exports, delivery retries…). Once an hour it also does housekeeping: data
 * retention for events and replays, erasures, and summaries of sessions that have
 * finished (for replay search and analysis; see `GlassService.summariseSettled`).
 *
 * Deployments from before the five-minute trigger run once an hour ("17 * * * *"); every
 * tick of theirs is an hourly tick.
 */

import { DAY_MS } from '@dataflare/core/time';
import { refreshFlagCohorts } from './cohorts.ts';
import type { Env } from './env.ts';
import { resumeErasures } from './erasure.ts';
import { applyDueSchedules, listFlags } from './flags.ts';
import { listProjects } from './projects.ts';
import {
  deleteReplays,
  moveLegacyReplays,
  REPLAY_DELETE_SLICE,
  sessionsToSummarise,
} from './replays.ts';
import { GlassService } from './service.ts';
import type { EventStore } from './stores/types.ts';

/** Sessions summarised per run: each reads all its chunks, and a run has a subrequest budget. */
const SUMMARIES_PER_RUN = 10;
/** Replay slices retention may delete per run, across all projects (see `REPLAY_DELETE_SLICE`). */
const RETENTION_SLICES_PER_RUN = 4;
/** Objects moved per run out of a pre-0.8.1 EU deployment's legacy replay bucket. */
const LEGACY_MOVES_PER_RUN = 50;
const SETTLED_MS = 30 * 60_000;

/** The Cron Trigger every deployment gets (see renderWranglerConfig in the CLI). */
export const CRON_SCHEDULE = '*/5 * * * *';

/** Whether this tick should also run the hourly housekeeping. */
export function isHourlyTick(cron: string | undefined, now: number): boolean {
  // Unknown or legacy hourly schedules: every tick is the hourly one.
  if (cron !== CRON_SCHEDULE) return true;
  const minute = new Date(now).getUTCMinutes();
  return minute >= 15 && minute < 20;
}

/** Work that runs on every tick. Later features register here; each returns a count for the log. */
export type FrequentTask = (env: Env, store: EventStore, now: number) => Promise<number>;
export const FREQUENT_TASKS: { name: string; run: FrequentTask }[] = [
  { name: 'flagSchedules', run: async (env, _store, now) => applyDueSchedules(env.DB, now) },
  {
    // Dynamic cohorts that flags target, recomputed when an hour old (a few per tick).
    name: 'flagCohorts',
    run: async (env, store, now) =>
      refreshFlagCohorts(
        env,
        store,
        now,
        (project) => listFlags(env.DB, project),
        (await listProjects(env.DB)).map((p) => p.id),
      ),
  },
];

export interface MaintenanceResult {
  events: number;
  replays: number;
  summarised: number;
  erased: number;
  legacyMoved: number;
  hourly: boolean;
  tasks: Record<string, number | string>;
}

export async function runMaintenance(
  env: Env,
  store: EventStore,
  now = Date.now(),
  options: { hourly?: boolean } = {},
): Promise<MaintenanceResult> {
  const hourly = options.hourly ?? true;
  const tasks: Record<string, number | string> = {};
  for (const task of FREQUENT_TASKS) {
    // One failing task must not stop the others (or the hourly housekeeping).
    try {
      tasks[task.name] = await task.run(env, store, now);
    } catch (err) {
      tasks[task.name] = `error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  if (!hourly) {
    return { events: 0, replays: 0, summarised: 0, erased: 0, legacyMoved: 0, hourly, tasks };
  }
  let events = 0;
  let replays = 0;
  // Erasures someone asked for come before routine retention.
  const erasures = await resumeErasures(env);
  replays += erasures.replays;
  const eventDays = Number(env.GLASS_RETENTION_DAYS);
  if (store.kind === 'd1' && eventDays > 0) {
    const cutoff = now - eventDays * DAY_MS;
    // Delete in slices so a big backlog never exceeds a single invocation's limits.
    for (let i = 0; i < 20; i++) {
      const res = await env.DB.prepare(
        'DELETE FROM events WHERE rowid IN (SELECT rowid FROM events WHERE ts_ms < ? LIMIT 5000)',
      )
        .bind(cutoff)
        .run();
      const changes = res.meta.changes ?? 0;
      events += changes;
      if (changes < 5000) break;
    }
  }
  const replayDays = Number(env.GLASS_REPLAY_RETENTION_DAYS ?? 30);
  if (replayDays > 0) {
    const cutoff = now - replayDays * DAY_MS;
    let slices = RETENTION_SLICES_PER_RUN;
    for (const project of await listProjects(env.DB)) {
      while (slices > 0) {
        slices--;
        const n = await deleteReplays(env, project.id, 'started_at < ?', [cutoff]);
        replays += n;
        if (n < REPLAY_DELETE_SLICE) break;
      }
      if (slices === 0) break;
    }
  }
  let summarised = 0;
  if (env.REPLAYS) {
    const service = new GlassService(env, store, env.GLASS_PUBLIC_URL?.replace(/\/+$/, '') ?? '');
    summarised = await service.summariseSettled(
      await sessionsToSummarise(env.DB, now - SETTLED_MS, SUMMARIES_PER_RUN),
    );
  }
  const legacy = await moveLegacyReplays(env, LEGACY_MOVES_PER_RUN);
  return {
    events,
    replays,
    summarised,
    erased: erasures.completed,
    legacyMoved: legacy.moved,
    hourly,
    tasks,
  };
}
