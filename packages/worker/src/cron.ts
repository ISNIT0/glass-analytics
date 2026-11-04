/**
 * Hourly housekeeping (Cron Trigger): data retention for events and replays,
 * and summaries of sessions that have finished (for replay search and
 * analysis; see `GlassService.summariseSettled`).
 */

import { DAY_MS } from '@glassanalytics/core/time';
import type { Env } from './env.ts';
import { listProjects } from './projects.ts';
import { deleteReplays, sessionsToSummarise } from './replays.ts';
import { GlassService } from './service.ts';
import type { EventStore } from './stores/types.ts';

/** Sessions summarised per run: each reads all its chunks, and a run has a subrequest budget. */
const SUMMARIES_PER_RUN = 10;
const SETTLED_MS = 30 * 60_000;

export async function runMaintenance(
  env: Env,
  store: EventStore,
  now = Date.now(),
): Promise<{ events: number; replays: number; summarised: number }> {
  let events = 0;
  let replays = 0;
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
    for (const project of await listProjects(env.DB)) {
      for (let i = 0; i < 10; i++) {
        const n = await deleteReplays(env, project.id, 'started_at < ?', [cutoff]);
        replays += n;
        if (n < 500) break;
      }
    }
  }
  let summarised = 0;
  if (env.REPLAYS) {
    const service = new GlassService(env, store, env.GLASS_PUBLIC_URL?.replace(/\/+$/, '') ?? '');
    summarised = await service.summariseSettled(
      await sessionsToSummarise(env.DB, now - SETTLED_MS, SUMMARIES_PER_RUN),
    );
  }
  return { events, replays, summarised };
}
