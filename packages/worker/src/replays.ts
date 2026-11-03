/**
 * Session replay storage.
 *
 * Each upload from replay.js is one gzipped JSON array of rrweb events, stored
 * as its own R2 object:
 *
 *   replays/<project>/<session>/<start>-<page>-<seq>.json.gz
 *
 * `start` is the chunk's first timestamp (so keys sort by time), `page` is a
 * random id per page load and `seq` counts chunks within that page load. A row
 * in the D1 `replays` table indexes the session (time range, counts, start URL),
 * so listing replays never touches R2.
 *
 * A session spans page loads, and rrweb numbers DOM nodes per page load, so
 * readers that resolve node ids (the transcript) need the chunks grouped by
 * page: see `loadReplayPages`.
 */

import type { RrwebEvent } from '@glass/core/replay-summary';
import { parseUserAgent } from '@glass/core/ua';
import type { D1Database, Env, R2Bucket } from './env.ts';
import { HttpError } from './http.ts';
import { requestInfo } from './ingest.ts';
import { getProject } from './projects.ts';

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const MAX_CHUNK_BYTES = 5_000_000;

export function replaysEnabled(env: Env): env is Env & { REPLAYS: R2Bucket } {
  return Boolean(env.REPLAYS);
}

function requireBucket(env: Env): R2Bucket {
  if (!env.REPLAYS) {
    throw new HttpError(501, 'Session replay is not enabled on this deployment', 'Enable R2 on your Cloudflare account, then run `glass upgrade`.');
  }
  return env.REPLAYS;
}

export const chunkPrefix = (project: string, session: string) => `replays/${project}/${session}/`;

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: ArrayBuffer): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** `POST /r` — store one chunk and update the session index. */
export async function handleReplayChunk(request: Request, env: Env, url: URL): Promise<void> {
  const bucket = requireBucket(env);
  const q = url.searchParams;
  const project = q.get('project') ?? '';
  const session = q.get('session') ?? '';
  const seq = Number(q.get('seq'));
  if (!(await getProject(env.DB, project))) throw new HttpError(404, `Unknown project "${project}"`);
  if (!SAFE_ID.test(session) || !Number.isInteger(seq) || seq < 0) throw new HttpError(400, 'Invalid session or seq');

  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength === 0) return;
  if (raw.byteLength > MAX_CHUNK_BYTES) throw new HttpError(413, 'Replay chunk too large');
  const body = q.get('enc') === 'gzip' ? raw : await gzip(raw);
  // Keys sort by start time; the page id keeps chunks from different page loads apart.
  const startKey = String(Math.max(0, Math.floor(Number(q.get('start')) || Date.now()))).padStart(15, '0');
  const page = /^[a-z0-9]{1,16}$/i.test(q.get('page') ?? '') ? q.get('page') : 'p';
  await bucket.put(`${chunkPrefix(project, session)}${startKey}-${page}-${String(seq).padStart(6, '0')}.json.gz`, body, {
    httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
  });

  const info = requestInfo(request);
  const ua = parseUserAgent(info.userAgent);
  const n = (name: string) => {
    const v = Number(q.get(name));
    return Number.isFinite(v) ? v : 0;
  };
  const start = n('start') || Date.now();
  await env.DB.prepare(
    `INSERT INTO replays (project, session_id, distinct_id, user_id, started_at, ended_at, chunks, bytes, clicks, errors, start_url, device, browser, country)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT (project, session_id) DO UPDATE SET
       started_at = MIN(replays.started_at, excluded.started_at),
       ended_at = MAX(replays.ended_at, excluded.ended_at),
       chunks = replays.chunks + 1,
       bytes = replays.bytes + excluded.bytes,
       clicks = replays.clicks + excluded.clicks,
       errors = replays.errors + excluded.errors,
       user_id = COALESCE(excluded.user_id, replays.user_id),
       start_url = CASE WHEN excluded.started_at < replays.started_at THEN excluded.start_url ELSE replays.start_url END`,
  )
    .bind(
      project,
      session,
      q.get('d') ?? '',
      q.get('u') || null,
      start,
      n('end') || start,
      body.byteLength,
      n('clicks'),
      n('errors'),
      (q.get('href') ?? '').slice(0, 500),
      ua.device,
      ua.browser,
      info.country,
    )
    .run();
}

export interface ReplayRow {
  session_id: string;
  distinct_id: string;
  user_id: string | null;
  started_at: number;
  ended_at: number;
  chunks: number;
  bytes: number;
  clicks: number;
  errors: number;
  start_url: string;
  device: string;
  browser: string;
  country: string;
}

export async function listReplays(
  db: D1Database,
  project: string,
  options: { person?: string; withErrors?: boolean; from?: number; limit?: number } = {},
): Promise<ReplayRow[]> {
  const where = ['project = ?'];
  const args: unknown[] = [project];
  if (options.person) {
    where.push('(user_id = ? OR distinct_id = ? OR distinct_id IN (SELECT distinct_id FROM identities WHERE project = ? AND person_id = ?))');
    args.push(options.person, options.person, project, options.person);
  }
  if (options.withErrors) where.push('errors > 0');
  if (options.from) {
    where.push('started_at >= ?');
    args.push(options.from);
  }
  const { results } = await db
    .prepare(`SELECT session_id, distinct_id, user_id, started_at, ended_at, chunks, bytes, clicks, errors, start_url, device, browser, country
      FROM replays WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT ?`)
    .bind(...args, Math.min(options.limit ?? 50, 500))
    .all<ReplayRow>();
  return results;
}

export async function getReplay(db: D1Database, project: string, session: string): Promise<ReplayRow | null> {
  return db.prepare('SELECT * FROM replays WHERE project = ? AND session_id = ?').bind(project, session).first<ReplayRow>();
}

/** One page load's part of a recording. Node ids are only meaningful within it. */
export interface ReplayPage {
  page: string;
  events: RrwebEvent[];
}

const byTime = (a: RrwebEvent, b: RrwebEvent) => a.timestamp - b.timestamp;

/** A session's recording as one event list per page load, each in time order, earliest page first. */
export async function loadReplayPages(env: Env, project: string, session: string): Promise<ReplayPage[]> {
  const bucket = requireBucket(env);
  if (!SAFE_ID.test(session)) throw new HttpError(400, 'Invalid session id');
  const prefix = chunkPrefix(project, session);
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listing = await bucket.list({ prefix, cursor, limit: 1000 });
    keys.push(...listing.objects.map((o) => o.key));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  keys.sort();

  const pages = new Map<string, RrwebEvent[]>();
  for (const key of keys) {
    const object = await bucket.get(key);
    if (!object) continue;
    const page = key.slice(prefix.length).split('-')[1] ?? 'p';
    try {
      const chunk: unknown = JSON.parse(await gunzip(await object.arrayBuffer()));
      if (!Array.isArray(chunk)) throw new Error('chunk is not an array of rrweb events');
      const list = pages.get(page) ?? [];
      // A loop rather than push(...chunk): a big chunk has more events than a call can take arguments.
      for (const event of chunk as RrwebEvent[]) list.push(event);
      pages.set(page, list);
    } catch (err) {
      console.warn('[glass] skipping unreadable replay chunk', key, err);
    }
  }
  return [...pages]
    .map(([page, events]) => ({ page, events: events.sort(byTime) }))
    .sort((a, b) => (a.events[0]?.timestamp ?? 0) - (b.events[0]?.timestamp ?? 0));
}

/** All rrweb events of a session in time order, for playback. */
export async function loadReplayEvents(env: Env, project: string, session: string): Promise<RrwebEvent[]> {
  return (await loadReplayPages(env, project, session)).flatMap((p) => p.events).sort(byTime);
}

/** Delete replays (R2 chunks and index rows) matching a SQL condition on the replays table. */
export async function deleteReplays(env: Env, project: string, where: string, args: unknown[]): Promise<number> {
  const { results } = await env.DB.prepare(`SELECT session_id FROM replays WHERE project = ? AND ${where} LIMIT 500`)
    .bind(project, ...args)
    .all<{ session_id: string }>();
  for (const { session_id } of results) {
    if (env.REPLAYS) {
      const page = await env.REPLAYS.list({ prefix: chunkPrefix(project, session_id), limit: 1000 });
      if (page.objects.length) await env.REPLAYS.delete(page.objects.map((o) => o.key));
    }
    await env.DB.prepare('DELETE FROM replays WHERE project = ? AND session_id = ?').bind(project, session_id).run();
  }
  return results.length;
}
