/**
 * Test helpers: a real SQLite database (Node's built-in `node:sqlite`) with the
 * production D1 migration applied, so compiled queries are executed, not just
 * string-compared.
 */

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { EVENT_COLUMNS, type StoredEvent } from '../src/events.ts';
import type { QueryContext, Row } from '../src/insights/types.ts';
import { sqlite } from '../src/sql/dialect.ts';

const MIGRATION = new URL('../../worker/migrations/0001_init.sql', import.meta.url);

export const NOW = Date.UTC(2026, 9, 31, 12, 0, 0); // Sat 31 Oct 2026, 12:00 UTC
export const DAY = 86_400_000;

export function createDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(MIGRATION, 'utf8'));
  return db;
}

let seq = 0;

/** Insert events with sensible defaults; `ts_ms` may be given as days before NOW via `daysAgo`. */
export type TestEvent = Omit<Partial<StoredEvent>, 'props' | 'person_props'> & {
  daysAgo?: number;
  props?: string | object;
  person_props?: string | object;
};

export function insert(db: DatabaseSync, events: TestEvent[]): void {
  const stmt = db.prepare(
    `INSERT INTO events (${EVENT_COLUMNS.join(', ')}) VALUES (${EVENT_COLUMNS.map(() => '?').join(', ')})`,
  );
  for (const e of events) {
    const distinct = e.distinct_id ?? 'd1';
    const row: StoredEvent = {
      id: e.id ?? `evt-${++seq}`,
      project: e.project ?? 'p',
      event: e.event ?? '$pageview',
      // A minute before NOW by default: ranges end at "now" exclusive.
      ts_ms: e.ts_ms ?? NOW - (e.daysAgo ?? 0) * DAY - 60_000,
      distinct_id: distinct,
      user_id: e.user_id ?? null,
      person_id: e.person_id ?? e.user_id ?? distinct,
      session_id: e.session_id ?? `s-${distinct}`,
      url: e.url ?? '',
      host: e.host ?? 'example.com',
      path: e.path ?? '/',
      referrer: e.referrer ?? '',
      referrer_host: e.referrer_host ?? '',
      title: e.title ?? '',
      utm_source: e.utm_source ?? '',
      utm_medium: e.utm_medium ?? '',
      utm_campaign: e.utm_campaign ?? '',
      utm_term: e.utm_term ?? '',
      utm_content: e.utm_content ?? '',
      country: e.country ?? 'GB',
      region: e.region ?? '',
      city: e.city ?? '',
      device: e.device ?? 'desktop',
      browser: e.browser ?? 'Chrome',
      os: e.os ?? 'macOS',
      flags: e.flags ?? '{}',
      props: typeof e.props === 'object' ? JSON.stringify(e.props) : (e.props ?? '{}'),
      person_props: typeof e.person_props === 'object' ? JSON.stringify(e.person_props) : (e.person_props ?? '{}'),
      lib: e.lib ?? 'test',
      received_ms: e.received_ms ?? NOW,
    };
    stmt.run(...EVENT_COLUMNS.map((c) => row[c]));
  }
}

export function link(db: DatabaseSync, distinctId: string, personId: string, project = 'p'): void {
  db.prepare('INSERT OR IGNORE INTO identities (project, distinct_id, person_id, created_at) VALUES (?, ?, ?, ?)').run(
    project,
    distinctId,
    personId,
    NOW,
  );
}

export function context(db: DatabaseSync, project = 'p'): QueryContext & { queries: string[] } {
  const queries: string[] = [];
  return {
    dialect: sqlite,
    project,
    now: NOW,
    queries,
    async execute(sql: string): Promise<Row[]> {
      queries.push(sql);
      return db.prepare(sql).all() as Row[];
    },
  };
}
