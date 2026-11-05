/**
 * The pricing calculator. It turns slider values into the same inputs the
 * dashboard's Usage & cost page measures, and prices them with the same
 * model (`@dataflare/core/usage`), so the site and the product agree.
 *
 * Mount points: <div data-calculator="compact"> (homepage) and
 * <div data-calculator="full"> (pricing page).
 */

import { estimateUsage, PRICES, type UsageInputs } from '../../../packages/core/src/usage.ts';

const VOLUMES = [1e3, 3e3, 1e4, 3e4, 1e5, 3e5, 1e6, 3e6, 1e7, 3e7, 1e8];
const SAMPLES = [0, 0.01, 0.05, 0.1, 0.25, 0.5, 1];
const RETENTION: [number | null, string][] = [
  [null, 'Keep everything (shown after 12 months)'],
  [30, '30 days'],
  [90, '90 days'],
  [180, '6 months'],
  [365, '1 year'],
  [730, '2 years'],
];
/** Replay size per recorded session: an initial page snapshot plus changes. Gzipped; varies a lot with page size. */
const REPLAY_BASE_BYTES = 80_000;
const REPLAY_BYTES_PER_MINUTE = 25_000;
/** Average page views per session, for turning page views into sessions. */
const VIEWS_PER_SESSION = 2.2;
const GB = 1024 ** 3;

interface State {
  volume: number;
  eventsPerView: number;
  sample: number;
  minutes: number;
  retention: number | null;
  replayRetention: number;
  store: 'd1' | 'lake';
  paid: boolean;
}

const fmt = (n: number) =>
  n >= 1e9
    ? `${+(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${+(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${+(n / 1e3).toFixed(1)}k`
        : String(Math.round(n));
const usd = (n: number) =>
  n === 0 ? '$0' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2).replace(/\.00$/, '')}`;
const gb = (n: number) => (n < 0.01 ? `${Math.round(n * 1024)} MB` : `${+n.toFixed(2)} GB`);

function estimate(s: State) {
  const pageviews = s.volume;
  const sessions = pageviews / VIEWS_PER_SESSION;
  const events = pageviews * s.eventsPerView;
  const replaySessions = sessions * s.sample;
  const replayChunks = replaySessions * Math.max(1, Math.round((s.minutes * 60) / 10));
  const replayBytes = replaySessions * (REPLAY_BASE_BYTES + REPLAY_BYTES_PER_MINUTE * s.minutes);
  const input: UsageInputs = {
    days: 30,
    store: s.store,
    projects: [
      { project: 'site', events, pageviews, sessions, replaySessions, replayChunks, replayBytes },
    ],
    topEvents: [],
    stored: {
      events: s.retention ? (events / 30) * s.retention : events * 12,
      replayBytes: 0,
      d1Bytes: null,
    },
    retentionDays: s.retention,
    replayRetentionDays: s.replayRetention,
  };
  const report = estimateUsage(input);
  const line = (name: string) => report.lines.find((l) => l.resource === name);
  const d1Gb = line('D1 storage')?.monthly ?? 0;
  const perDay = {
    requests: report.monthly.requests / 30,
    rowsWritten: report.monthly.rowsWritten / 30,
  };
  const free = PRICES.free;
  const limits = [
    perDay.requests > free.requestsPerDay &&
      `${fmt(perDay.requests)} requests a day (Free allows ${fmt(free.requestsPerDay)})`,
    perDay.rowsWritten > free.d1RowsWrittenPerDay &&
      `${fmt(perDay.rowsWritten)} D1 rows written a day (Free allows ${fmt(free.d1RowsWrittenPerDay)})`,
    d1Gb > free.d1MaxDatabaseGb &&
      `a ${gb(d1Gb)} database (Free allows ${gb(free.d1MaxDatabaseGb)})`,
  ].filter((x): x is string => Boolean(x));
  const fitsFree = limits.length === 0;
  // R2 bills the same on both plans; Workers and D1 overage only exist on Paid.
  const r2Overage = report.lines
    .filter((l) => l.resource.startsWith('R2'))
    .reduce((n, l) => n + l.overageUsd, 0);
  const onFree = fitsFree && !s.paid;
  const total = onFree ? r2Overage : (s.paid ? 0 : PRICES.plan.monthly) + report.overageUsd;
  // How long until D1 is full, and what retention would keep it under the cap.
  const bytesPerEvent = input.stored.events ? (d1Gb * GB) / input.stored.events : 0;
  const capEvents = bytesPerEvent ? (PRICES.d1.maxDatabaseGb * GB) / bytesPerEvent : Infinity;
  const fillMonths = events ? capEvents / events : Infinity;
  const fitsRetention = events ? Math.floor((capEvents / events) * 30) : Infinity;
  return {
    report,
    total,
    onFree,
    fitsFree,
    limits,
    d1Gb,
    fillMonths,
    fitsRetention,
    events,
    replaySessions,
  };
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c !== null) node.append(c);
  return node;
}

let uid = 0;
function field(
  label: string,
  control: HTMLElement,
  output?: HTMLElement,
  hint?: string,
): HTMLElement {
  const id = `calc-${++uid}`;
  control.id = id;
  return el(
    'div',
    { class: 'calc-field' },
    el('div', { class: 'calc-label' }, el('label', { for: id }, label), output ?? null),
    control,
    hint ? el('p', { class: 'calc-hint' }, hint) : null,
  );
}

function range(min: number, max: number, value: number, step = 1): HTMLInputElement {
  return el('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
  });
}

function select<T>(options: [T, string][], value: T): HTMLSelectElement {
  const s = el('select');
  options.forEach(([v, label], i) => {
    const o = el('option', { value: String(i) }, label);
    if (v === value) o.selected = true;
    s.append(o);
  });
  return s;
}

function mount(root: HTMLElement): void {
  const full = root.dataset.calculator === 'full';
  const s: State = {
    volume: 1e5,
    eventsPerView: 3,
    sample: 0.1,
    minutes: 2,
    retention: null,
    replayRetention: 30,
    store: 'd1',
    paid: false,
  };
  const volume = range(0, VOLUMES.length - 1, VOLUMES.indexOf(s.volume));
  const volumeOut = el('output');
  const sample = range(0, SAMPLES.length - 1, SAMPLES.indexOf(s.sample));
  const sampleOut = el('output');
  const perView = range(1, 10, s.eventsPerView);
  const perViewOut = el('output');
  const minutes = range(1, 15, s.minutes);
  const minutesOut = el('output');
  const retention = select(RETENTION, s.retention);
  const replayRetention = select<number>(
    [
      [7, '7 days'],
      [30, '30 days (default)'],
      [90, '90 days'],
    ],
    s.replayRetention,
  );
  const store = select<'d1' | 'lake'>(
    [
      ['d1', 'D1 (default)'],
      ['lake', 'Lake: Iceberg on R2 (beta)'],
    ],
    s.store,
  );
  const paid = el('input', { type: 'checkbox' });

  const controls = el(
    'div',
    { class: 'calc-controls' },
    field('Page views a month', volume, volumeOut),
    field(
      'Sessions recorded',
      sample,
      sampleOut,
      full ? 'Replay sampling. Dataflare also records sessions where an error happens.' : undefined,
    ),
  );
  if (full) {
    controls.append(
      field(
        'Events per page view',
        perView,
        perViewOut,
        'The page view itself, autocaptured clicks and Web Vitals, plus your custom events. Most sites send 2 to 5.',
      ),
      field('Average recorded session', minutes, minutesOut),
      field(
        'Keep events for',
        retention,
        undefined,
        'GLASS_RETENTION_DAYS. Older events are deleted hourly.',
      ),
      field('Keep recordings for', replayRetention),
      field('Event store', store),
      el(
        'label',
        { class: 'calc-check' },
        paid,
        el('span', {}, 'I already pay for Workers Paid on this Cloudflare account'),
      ),
    );
  }

  const total = el('p', { class: 'calc-total' });
  const plan = el('p', { class: 'calc-plan' });
  const notes = el('ul', { class: 'calc-notes' });
  const table = el('div', { class: 'table-wrap' });
  const recs = el('div', { class: 'calc-recs' });
  const result = el(
    'div',
    { class: 'calc-result', 'aria-live': 'polite' },
    el('p', { class: 'calc-result-label' }, 'Estimated Cloudflare bill'),
    total,
    plan,
    notes,
    full ? table : el('a', { class: 'button small', href: '/pricing/' }, 'See every line →'),
    full ? recs : null,
  );
  root.replaceChildren(controls, result);

  const update = () => {
    s.volume = VOLUMES[Number(volume.value)]!;
    s.sample = SAMPLES[Number(sample.value)]!;
    s.eventsPerView = Number(perView.value);
    s.minutes = Number(minutes.value);
    s.retention = RETENTION[Number(retention.value)]![0];
    s.replayRetention = [7, 30, 90][Number(replayRetention.value)]!;
    s.store = Number(store.value) === 1 ? 'lake' : 'd1';
    s.paid = paid.checked;
    volumeOut.textContent = fmt(s.volume);
    sampleOut.textContent = s.sample === 0 ? 'Replay off' : `${Math.round(s.sample * 100)}%`;
    perViewOut.textContent = String(s.eventsPerView);
    minutesOut.textContent = `${s.minutes} min`;

    const r = estimate(s);
    total.replaceChildren(usd(r.total), el('span', {}, ' / month'));
    plan.textContent = r.onFree
      ? 'Fits the Workers Free plan.'
      : s.paid
        ? 'Extra cost on your existing Workers Paid plan.'
        : r.fitsFree
          ? `Fits Workers Free; shown on Workers Paid ($${PRICES.plan.monthly}/month) as you asked.`
          : `Needs Workers Paid: $${PRICES.plan.monthly}/month${r.report.overageUsd > 0 ? ` plus ${usd(r.report.overageUsd)} usage` : ', usage included'}.`;
    const items: string[] = [
      `${fmt(r.events)} events and ${fmt(r.replaySessions)} recorded sessions a month.`,
    ];
    if (!r.fitsFree && !s.paid && full)
      items.push(`Over the Free plan because of ${r.limits.join(', ')}.`);
    if (s.store === 'd1' && r.d1Gb > PRICES.d1.maxDatabaseGb)
      items.push(
        `That's more than D1's ${PRICES.d1.maxDatabaseGb} GB database limit. Keep about ${r.fitsRetention} days of events (GLASS_RETENTION_DAYS), or use the lake store.`,
      );
    else if (s.store === 'd1' && !s.retention && r.fillMonths < 36)
      items.push(
        `D1 would reach its ${PRICES.d1.maxDatabaseGb} GB limit in about ${Math.max(1, Math.round(r.fillMonths))} months. Set a retention period before then.`,
      );
    notes.replaceChildren(...items.map((t) => el('li', {}, t)));

    if (full) {
      const rows = r.report.lines.map((l) => {
        const unitFmt = l.unit === 'GB' ? gb : fmt;
        return el(
          'tr',
          {},
          el('th', { scope: 'row' }, l.resource, el('span', { class: 'calc-basis' }, l.basis)),
          el('td', { class: 'num' }, unitFmt(l.monthly)),
          el('td', { class: 'num' }, unitFmt(l.included)),
          el(
            'td',
            { class: 'num' },
            el(
              'span',
              { class: 'meter', style: `--w:${Math.min(100, l.share * 100).toFixed(1)}%` },
              el('span', {}),
            ),
            `${l.share < 0.01 && l.share > 0 ? '<1' : Math.round(l.share * 100)}%`,
          ),
          el('td', { class: 'num' }, usd(l.overageUsd)),
        );
      });
      table.replaceChildren(
        el(
          'table',
          { class: 'calc-table' },
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', { scope: 'col' }, 'Resource'),
              el('th', { scope: 'col', class: 'num' }, 'A month'),
              el('th', { scope: 'col', class: 'num' }, 'Included in Paid'),
              el('th', { scope: 'col', class: 'num' }, 'Share used'),
              el('th', { scope: 'col', class: 'num' }, 'Extra'),
            ),
          ),
          el('tbody', {}, ...rows),
        ),
      );
      recs.replaceChildren(
        ...(r.report.recommendations.length
          ? [
              el('h3', {}, 'Ways to spend less'),
              el(
                'ul',
                {},
                ...r.report.recommendations
                  .slice(0, 3)
                  .map((x) => el('li', {}, el('strong', {}, x.title), ` ${x.detail}`)),
              ),
            ]
          : []),
      );
    }
  };
  // One event per settled choice, not one per slider step.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    update();
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        window.glass?.capture('pricing_calculated', {
          pageviews: s.volume,
          replay: s.sample,
          full,
        }),
      1500,
    );
  };
  root.addEventListener('input', changed);
  root.addEventListener('change', changed);
  update();
}

declare global {
  interface Window {
    glass?: { capture(event: string, props?: Record<string, unknown>): void };
  }
}

for (const root of document.querySelectorAll<HTMLElement>('[data-calculator]')) mount(root);
