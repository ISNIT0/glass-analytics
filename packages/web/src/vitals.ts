/**
 * Core Web Vitals, measured with PerformanceObserver.
 *
 * These are close approximations of Google's definitions, without the
 * `web-vitals` dependency: LCP is the last largest-contentful-paint entry, CLS
 * sums layout shifts not caused by input, INP is the slowest interaction. If you
 * need exact values, use the `web-vitals` package and send them yourself with
 * `glass.capture('$web_vitals', { metric: 'LCP', value })`.
 */

export type VitalName = 'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB';

interface LayoutShift extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

interface EventTiming extends PerformanceEntry {
  interactionId?: number;
}

export function observeVitals(report: (metric: VitalName, value: number) => void): () => void {
  const values: Partial<Record<VitalName, number>> = {};
  const observers: PerformanceObserver[] = [];

  const observe = (type: string, onEntry: (entry: PerformanceEntry) => void, extra: Record<string, unknown> = {}) => {
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) onEntry(entry);
      });
      po.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      observers.push(po);
    } catch {
      // Entry type not supported in this browser.
    }
  };

  observe('largest-contentful-paint', (e) => {
    values.LCP = e.startTime;
  });
  observe('layout-shift', (e) => {
    const shift = e as LayoutShift;
    if (!shift.hadRecentInput) values.CLS = (values.CLS ?? 0) + shift.value;
  });
  observe(
    'event',
    (e) => {
      const timing = e as EventTiming;
      if (timing.interactionId) values.INP = Math.max(values.INP ?? 0, timing.duration);
    },
    { durationThreshold: 16 },
  );
  observe('paint', (e) => {
    if (e.name === 'first-contentful-paint') values.FCP = e.startTime;
  });

  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.responseStart > 0) values.TTFB = nav.responseStart;
  } catch {
    // ignore
  }

  let reported = false;
  return () => {
    if (reported) return;
    reported = true;
    for (const po of observers) po.disconnect();
    for (const [metric, value] of Object.entries(values)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        report(metric as VitalName, metric === 'CLS' ? Math.round(value * 1000) / 1000 : Math.round(value));
      }
    }
  };
}
