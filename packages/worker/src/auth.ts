/**
 * API keys.
 *
 * Two keys, both Worker secrets created by `glass init`:
 * - GLASS_ADMIN_KEY: everything (queries and changes to flags, experiments, projects).
 * - GLASS_READ_KEY: queries only — safe to give to a read-only agent or teammate.
 *
 * Ingest endpoints (/e, /r, /f) are public by design: browsers call them.
 */

import { timingSafeEqual } from '@glass/core/hash';
import type { Env } from './env.ts';
import { HttpError } from './http.ts';

export type Scope = 'read' | 'admin';

export function authenticate(request: Request, env: Env): Scope | null {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  if (env.GLASS_ADMIN_KEY && timingSafeEqual(token, env.GLASS_ADMIN_KEY)) return 'admin';
  if (env.GLASS_READ_KEY && timingSafeEqual(token, env.GLASS_READ_KEY)) return 'read';
  return null;
}

export function requireScope(request: Request, env: Env, needed: Scope): Scope {
  if (!env.GLASS_ADMIN_KEY) {
    throw new HttpError(503, 'GLASS_ADMIN_KEY is not set on this Worker', 'Run `glass upgrade` or set it with `wrangler secret put GLASS_ADMIN_KEY`.');
  }
  const scope = authenticate(request, env);
  if (!scope) {
    throw new HttpError(401, 'Missing or invalid API key', 'Send "Authorization: Bearer <key>". Keys are in .glass/credentials.json; run `glass key`.');
  }
  if (needed === 'admin' && scope !== 'admin') throw new HttpError(403, 'This action needs the admin key');
  return scope;
}
