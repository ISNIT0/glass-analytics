/**
 * Patterns across many sessions: which elements people rage- or dead-click,
 * which errors and failing requests they hit, and the pages where frustrated
 * sessions end. Built from the per-session timelines in `replay-summary.ts`,
 * each finding carries example sessions so an agent (or person) can open one.
 */

import type { ReplayStats, TimelineItem } from './replay-summary.ts';

export interface AnalysedSession {
  session: string;
  stats: ReplayStats;
  timeline: readonly TimelineItem[];
}

export interface Finding {
  /** What happened, e.g. `Rage-clicked "Pay now" (button) · #pay`. */
  what: string;
  /** Times it happened across all sessions. */
  occurrences: number;
  /** Sessions it happened in. */
  sessions: number;
  /** Up to three sessions with the ms offset of the first occurrence, to open in the player. */
  examples: { session: string; t: number }[];
}

export interface ReplayAnalysis {
  sessions: number;
  totals: {
    rageClicks: number;
    deadClicks: number;
    errorClicks: number;
    errors: number;
    consoleErrors: number;
    failedRequests: number;
  };
  rageClicks: Finding[];
  deadClicks: Finding[];
  errors: Finding[];
  failedRequests: Finding[];
  consoleErrors: Finding[];
  /** The last page of sessions that had a problem: where frustrated visitors gave up. */
  exitPages: Finding[];
  text: string;
}

class Tally {
  private rows = new Map<
    string,
    { occurrences: number; sessions: Set<string>; examples: { session: string; t: number }[] }
  >();
  add(what: string, session: string, t: number, times = 1): void {
    const row = this.rows.get(what) ?? { occurrences: 0, sessions: new Set(), examples: [] };
    row.occurrences += times;
    if (!row.sessions.has(session)) {
      row.sessions.add(session);
      if (row.examples.length < 3) row.examples.push({ session, t });
    }
    this.rows.set(what, row);
  }
  top(n: number): Finding[] {
    return [...this.rows]
      .map(([what, r]) => ({
        what,
        occurrences: r.occurrences,
        sessions: r.sessions.size,
        examples: r.examples,
      }))
      .sort((a, b) => b.sessions - a.sessions || b.occurrences - a.occurrences)
      .slice(0, n);
  }
}

/**
 * Ids vary between occurrences of the same problem; fold them so the same error groups together.
 * Short numbers (HTTP statuses, line numbers) and hosts and ports in URLs are kept.
 */
const normalise = (text: string) =>
  text
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
    .replace(/\/\d+(?=\/|\s|$)/g, '/<id>')
    .replace(/(?<![:.\d])\b\d{4,}\b(?![.:]\d)/g, '<n>')
    .replace(/ \(\d+(\.\d+)? m?s\)$/, '')
    .trim();

const element = (i: TimelineItem) => `${i.label ?? i.text}${i.selector ? ` · ${i.selector}` : ''}`;

export function analyseReplays(sessions: readonly AnalysedSession[], top = 10): ReplayAnalysis {
  const rage = new Tally();
  const dead = new Tally();
  const errors = new Tally();
  const requests = new Tally();
  const consoleErrors = new Tally();
  const exits = new Tally();
  const totals = {
    rageClicks: 0,
    deadClicks: 0,
    errorClicks: 0,
    errors: 0,
    consoleErrors: 0,
    failedRequests: 0,
  };

  for (const s of sessions) {
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += s.stats[k] ?? 0;
    let lastPage: TimelineItem | null = null;
    let troubled = false;
    for (const item of s.timeline) {
      if (item.kind === 'page') lastPage = item;
      if (item.kind === 'click' && item.signals?.includes('rage'))
        rage.add(element(item), s.session, item.t, item.count ?? 1);
      if (item.kind === 'click' && item.signals?.includes('dead'))
        dead.add(element(item), s.session, item.t);
      if (item.kind === 'error')
        errors.add(normalise(item.text.replace(/^ERROR /, '')), s.session, item.t);
      if (item.kind === 'network' && item.level === 'error')
        requests.add(normalise(item.text.replace(/^Request failed: /, '')), s.session, item.t);
      if (item.kind === 'console' && item.level === 'error')
        consoleErrors.add(normalise(item.text.replace(/^Console error: /, '')), s.session, item.t);
      if (item.signals?.length || item.level === 'error') troubled = true;
    }
    if (troubled && lastPage) exits.add(lastPage.url ?? lastPage.text, s.session, lastPage.t);
  }

  const result = {
    sessions: sessions.length,
    totals,
    rageClicks: rage.top(top),
    deadClicks: dead.top(top),
    errors: errors.top(top),
    failedRequests: requests.top(top),
    consoleErrors: consoleErrors.top(top),
    exitPages: exits.top(top),
  };
  return { ...result, text: describe(result) };
}

function describe(a: Omit<ReplayAnalysis, 'text'>): string {
  const lines = [
    `${a.sessions} sessions analysed: ${a.totals.rageClicks} rage clicks, ${a.totals.deadClicks} dead clicks, ${a.totals.errorClicks} clicks followed by an error, ${a.totals.errors} errors, ${a.totals.consoleErrors} console errors, ${a.totals.failedRequests} failed requests.`,
  ];
  const section = (title: string, findings: Finding[]) => {
    if (!findings.length) return;
    lines.push('', `${title}:`);
    for (const f of findings) {
      lines.push(
        `- ${f.what} — ${f.sessions} session${f.sessions === 1 ? '' : 's'}, ${f.occurrences}× (e.g. ${f.examples.map((e) => e.session).join(', ')})`,
      );
    }
  };
  section('Rage-clicked elements', a.rageClicks);
  section('Dead clicks (nothing happened)', a.deadClicks);
  section('Errors', a.errors);
  section('Failed requests', a.failedRequests);
  section('Console errors', a.consoleErrors);
  section('Last page of sessions with problems', a.exitPages);
  if (lines.length === 1) lines.push('', 'No frustration signals or errors found.');
  return lines.join('\n');
}
