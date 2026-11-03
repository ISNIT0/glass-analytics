/**
 * HTTP client for a deployed Glass Worker.
 */

import { UsageError, connection } from './config.ts';

export async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  options: { host?: string; key?: string; fetcher?: typeof fetch } = {},
): Promise<T> {
  const conn = options.host && options.key ? { host: options.host, key: options.key } : connection();
  const res = await (options.fetcher ?? fetch)(`${conn.host}${path}`, {
    method,
    headers: { Authorization: `Bearer ${conn.key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((err: unknown) => {
    throw new UsageError(`Could not reach ${conn.host}: ${err instanceof Error ? err.message : String(err)}`, 'Check your network, or run `glass status`.');
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
  if (!res.ok) throw new UsageError(data.error ?? `HTTP ${res.status}`, data.hint);
  return data as T;
}

/** Add the default project to a body or query when none is given. */
export function withProject<T extends Record<string, unknown>>(value: T): T & { project?: string } {
  const project = (value.project as string | undefined) ?? connection().project;
  return project ? { ...value, project } : value;
}
