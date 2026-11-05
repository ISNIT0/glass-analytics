/**
 * Usage & cost: what this Dataflare deployment adds to the Cloudflare bill,
 * projected to a month from the last 7 days, and how to cut it.
 * Data: `GET /api/usage` (also the `usage_and_cost` MCP tool).
 */

import { api } from '../api.ts';
import { icon } from '../components/icons.ts';
import { copyButton, later, pageHeader, panel, table } from '../components/ui.ts';
import { h } from '../dom.ts';
import { count, percent } from '../format.ts';
import type { Route } from '../state.ts';

interface Line {
  resource: string;
  unit: string;
  monthly: number;
  included: number;
  share: number;
  overageUsd: number;
  basis: string;
}

interface Usage {
  store: string;
  window: { days: number };
  monthly: {
    events: number;
    pageviews: number;
    sessions: number;
    replaySessions: number;
    requests: number;
    rowsWritten: number;
    replayGb: number;
  };
  lines: Line[];
  overageUsd: number;
  reads: { perReportLoad: number; loadsIncluded: number };
  projects: {
    project: string;
    monthlyEvents: number;
    share: number;
    replaySessions: number;
    replayBytes: number;
  }[];
  recommendations: { id: string; title: string; detail: string; impact: string; prompt: string }[];
  prices: { checked: string; plan: { name: string; monthly: number } };
  summary: string;
}

const money = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
const amount = (l: Line) =>
  l.unit === 'GB'
    ? `${l.monthly < 0.01 && l.monthly > 0 ? '<0.01' : l.monthly.toFixed(2)} GB`
    : count(l.monthly);
const allowance = (l: Line) => (l.unit === 'GB' ? `${l.included} GB` : count(l.included));

function meter(share: number): HTMLElement {
  const pct = Math.min(100, share * 100);
  return h(
    'span',
    {
      class: `usage-meter ${share >= 1 ? 'over' : share > 0.6 ? 'high' : ''}`,
      title: `${percent(share, 1)} of the included allowance`,
    },
    h(
      'span',
      { class: 'meter-track' },
      h('span', { class: 'meter-fill', style: `width:${Math.max(pct, share > 0 ? 1 : 0)}%` }),
    ),
    h(
      'span',
      { class: 'meter-label' },
      share < 0.001 && share > 0 ? '<0.1%' : percent(share, share < 0.1 ? 1 : 0),
    ),
  );
}

export function usagePage(_route: Route): Node[] {
  return [
    pageHeader(
      'Usage & cost',
      'What Dataflare adds to your Cloudflare bill, projected to a month from the last 7 days, and how to keep it low.',
    ),
    later(
      async () => {
        const u = await api.get<Usage>('/api/usage');
        const plan = u.prices.plan;
        const tiles = [
          {
            label: 'Projected cost / month',
            value: u.overageUsd > 0 ? money(u.overageUsd) : '$0.00',
            sub:
              u.overageUsd > 0
                ? `beyond the ${plan.name} allowances`
                : `within the ${plan.name} allowances ($${plan.monthly}/month plan)`,
            tone: u.overageUsd > 0 ? 'warn' : 'good',
          },
          {
            label: 'Events / month',
            value: count(u.monthly.events),
            sub: `${count(u.monthly.pageviews)} pageviews`,
            tone: '',
          },
          {
            label: 'Worker requests / month',
            value: count(u.monthly.requests),
            sub: `${percent(u.monthly.requests / 10e6, 1)} of 10M included`,
            tone: '',
          },
          {
            label: 'Replays',
            value: `${u.monthly.replayGb < 0.01 ? '<0.01' : u.monthly.replayGb.toFixed(2)} GB`,
            sub: `${count(u.monthly.replaySessions)} recordings a month`,
            tone: '',
          },
        ];
        return [
          h(
            'dl',
            { class: 'kpis usage-kpis' },
            tiles.map((t) =>
              h(
                'div',
                { class: `kpi ${t.tone}` },
                h('dt', {}, t.label),
                h('dd', {}, t.value),
                h('span', { class: 'muted small' }, t.sub),
              ),
            ),
          ),
          panel(
            'Recommendations',
            u.recommendations.length
              ? h(
                  'div',
                  { class: 'recs' },
                  u.recommendations.map((r) =>
                    h(
                      'article',
                      { class: 'rec' },
                      h(
                        'div',
                        { class: 'rec-head' },
                        h('strong', {}, r.title),
                        h('span', { class: 'badge good' }, r.impact),
                      ),
                      h('p', { class: 'muted' }, r.detail),
                      h(
                        'div',
                        { class: 'rec-prompt' },
                        h('code', {}, r.prompt),
                        copyButton(r.prompt, 'Copy prompt', 'bot'),
                      ),
                    ),
                  ),
                )
              : h(
                  'div',
                  { class: 'recs-clear' },
                  h('span', { class: 'empty-icon' }, icon('check', 18)),
                  h(
                    'div',
                    {},
                    h('strong', {}, 'Nothing to change'),
                    h(
                      'p',
                      { class: 'muted' },
                      'Usage is comfortably within the allowances. As traffic grows, the usual levers are recording fewer replays (sample 10% plus every session with an error), expiring old events, and moving events to the lake store. This page suggests them when they start to matter.',
                    ),
                  ),
                ),
            { icon: 'zap', subtitle: 'Each comes with a prompt for your coding agent' },
          ),
          panel(
            'Projected monthly usage',
            [
              table(
                ['Resource', 'Per month', 'Included', 'Share of allowance', 'Est. cost'],
                u.lines.map((l) => [
                  h(
                    'span',
                    { title: l.basis },
                    l.resource,
                    h('span', { class: 'muted small usage-basis' }, l.basis),
                  ),
                  amount(l),
                  h('span', { class: 'muted' }, allowance(l)),
                  meter(l.share),
                  l.overageUsd > 0 ? money(l.overageUsd) : h('span', { class: 'muted' }, '$0.00'),
                ]),
                { numeric: [1, 2, 4], class: 'usage-table' },
              ),
              h(
                'p',
                { class: 'muted small usage-note' },
                `Queries: each Reports load reads about ${count(u.reads.perReportLoad)} rows; the 25B rows read included each month cover ${u.reads.loadsIncluded > 1e6 ? 'over a million' : count(u.reads.loadsIncluded)} loads.`,
              ),
            ],
            {
              icon: 'database',
              subtitle: `Events are stored in ${u.store === 'lake' ? 'the lake (Iceberg on R2)' : 'D1'}`,
            },
          ),
          u.projects.length > 1
            ? panel(
                'By project',
                table(
                  ['Project', 'Events / month', 'Share', 'Recordings (7 days)'],
                  u.projects.map((p) => [
                    p.project,
                    count(p.monthlyEvents),
                    percent(p.share, 0),
                    count(p.replaySessions),
                  ]),
                  { numeric: [1, 2, 3] },
                ),
                { icon: 'layers' },
              )
            : null,
          h(
            'p',
            { class: 'muted small usage-note' },
            `Estimates, not your bill: Dataflare can't see Cloudflare billing, so this is inferred from what it stored in the last ${u.window.days} days. Allowances on ${plan.name} are shared with your other Workers, so costs here assume Dataflare is the only thing using them. Prices checked ${u.prices.checked}: `,
            h(
              'a',
              {
                href: 'https://developers.cloudflare.com/workers/platform/pricing/',
                target: '_blank',
                rel: 'noreferrer',
              },
              'Workers',
            ),
            ', ',
            h(
              'a',
              {
                href: 'https://developers.cloudflare.com/d1/platform/pricing/',
                target: '_blank',
                rel: 'noreferrer',
              },
              'D1',
            ),
            ', ',
            h(
              'a',
              {
                href: 'https://developers.cloudflare.com/r2/pricing/',
                target: '_blank',
                rel: 'noreferrer',
              },
              'R2',
            ),
            '.',
          ),
        ];
      },
      'Estimating usage',
      'report',
    ),
  ];
}
