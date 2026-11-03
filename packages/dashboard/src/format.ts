export function count(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`;
  return Math.round(n).toLocaleString('en-US');
}

export function decimal(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '–';
}

export function percent(n: number, digits = 1): string {
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '–';
}

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Signed relative change, e.g. "+12%" or "−3%". */
export function change(now: number, before: number | undefined | null): { text: string; direction: 'up' | 'down' | 'flat' } | null {
  if (!before) return null;
  const c = (now - before) / before;
  if (Math.abs(c) < 0.005) return { text: '0%', direction: 'flat' };
  return { text: `${c > 0 ? '+' : '−'}${Math.abs(c * 100).toFixed(0)}%`, direction: c > 0 ? 'up' : 'down' };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function bucketLabel(ms: number, interval: string): string {
  const d = new Date(ms);
  if (interval === 'hour') return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
  if (interval === 'month') return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function dateTime(value: string | number): string {
  const d = new Date(value);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ago(value: string | number): string {
  const seconds = (Date.now() - new Date(value).getTime()) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}
