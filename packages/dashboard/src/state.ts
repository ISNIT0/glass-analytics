/**
 * App state that lives in the URL (so every view is a shareable link) or in
 * localStorage (the API key and preferences).
 */

const base = document.querySelector<HTMLMetaElement>('meta[name="glass-base"]')?.content ?? '';

export const config = {
  /** Path prefix of the Worker, '' or '/_glass'. */
  base,
};

function stored(key: string): string | null {
  try {
    return localStorage.getItem(`glass:${key}`);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(`glass:${key}`);
    else localStorage.setItem(`glass:${key}`, value);
  } catch {
    // ignore
  }
}

export const prefs = {
  get key(): string | null {
    return stored('key');
  },
  set key(value: string | null) {
    store('key', value);
  },
  get showSql(): boolean {
    return stored('show-sql') === '1';
  },
  set showSql(value: boolean) {
    store('show-sql', value ? '1' : null);
    document.documentElement.classList.toggle('show-sql', value);
  },
  get project(): string | null {
    return stored('project');
  },
  set project(value: string | null) {
    store('project', value);
  },
};

export interface Route {
  /** e.g. "web", "insights", "replays" */
  page: string;
  /** Path segments after the page, e.g. ["funnel"] or ["session-id"] */
  rest: string[];
  params: URLSearchParams;
}

export function currentRoute(): Route {
  const hash = location.hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = hash.split('?');
  const [page = 'web', ...rest] = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { page, rest, params: new URLSearchParams(query) };
}

/** Navigate, keeping the shared project and date range parameters unless overridden. */
export function go(page: string, params: Record<string, string | undefined | null> = {}, keep = true): void {
  const current = currentRoute().params;
  const next = new URLSearchParams();
  if (keep) for (const k of ['project', 'from', 'to']) if (current.get(k)) next.set(k, current.get(k)!);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') next.delete(k);
    else next.set(k, v);
  }
  const q = next.toString();
  location.hash = `#/${page}${q ? `?${q}` : ''}`;
}

export function href(page: string, params: Record<string, string | undefined | null> = {}): string {
  const current = currentRoute().params;
  const next = new URLSearchParams();
  for (const k of ['project', 'from', 'to']) if (current.get(k)) next.set(k, current.get(k)!);
  for (const [k, v] of Object.entries(params)) if (v) next.set(k, v);
  const q = next.toString();
  return `#/${page}${q ? `?${q}` : ''}`;
}

/** The shared query parameters every page passes to the API. */
export function scope(): { project?: string; from: string; to?: string } {
  const p = currentRoute().params;
  return {
    project: p.get('project') ?? prefs.project ?? undefined,
    from: p.get('from') ?? '-30d',
    to: p.get('to') ?? undefined,
  };
}
