/**
 * Client for the Glass JSON API. The dashboard uses exactly the endpoints an
 * agent would, so anything you can see here, an agent can query too.
 */

import { config, prefs } from './state.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly hint?: string;
  constructor(status: number, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

type Params = Record<string, string | number | boolean | undefined | null>;

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  params?: Params,
): Promise<T> {
  const url = new URL(`${config.base}${path}`, location.origin);
  for (const [k, v] of Object.entries(params ?? {}))
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${prefs.key ?? ''}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('glass:unauthorized'));
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.hint);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, params?: Params) => request<T>('GET', path, undefined, params),
  post: <T>(path: string, body: unknown = {}, params?: Params) =>
    request<T>('POST', path, body, params),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string, params?: Params) => request<T>('DELETE', path, undefined, params),
};
