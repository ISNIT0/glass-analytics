/**
 * Query specs.
 *
 * These zod schemas are the single source of truth for every query shape. The
 * same definitions validate HTTP API input, generate the JSON Schemas served at
 * `/api/schema`, and become the input schemas of the MCP tools — so the
 * `.describe()` text here is what coding agents read. Keep it precise.
 */

import { z } from 'zod/v4';
import { FILTER_OPS } from '../filters.ts';

const time = z
  .union([z.string(), z.number()])
  .describe(
    'ISO date ("2026-10-01"), epoch ms, "now", "today", "yesterday", or a relative offset like "-30d", "-12h", "-3mo".',
  );

export const filterSchema = z
  .object({
    property: z
      .string()
      .describe(
        'Property to test. Built-in columns: path, url, host, referrer_host, utm_source, utm_medium, utm_campaign, country, region, city, device, browser, os, event, session_id, user_id. Anything else is an event property ("plan" or "props.plan"); prefix with "person." for person properties ("person.plan"). Use "cohort" with a saved cohort key as the value (ops eq/in or neq/not_in) to keep only people in (or not in) that cohort; list keys with list_cohorts. Prefix with "session." to keep whole visits: "session.utm_source" = "google" keeps every event of sessions that landed from Google, so their later pages and conversions count.',
      ),
    op: z.enum(FILTER_OPS).optional().describe('Comparison operator. Defaults to "eq".'),
    value: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
      .optional()
      .describe('Value to compare with. Lists for "in"/"not_in". Omit for "is_set"/"is_not_set".'),
  })
  .describe('A condition on an event, column or person property.');

const common = {
  project: z
    .string()
    .optional()
    .describe('Project id. Defaults to the only project, or "default".'),
  from: time.optional().describe('Start of the range (inclusive). Defaults to "-30d".'),
  to: time.optional().describe('End of the range (exclusive). Defaults to "now".'),
  filters: z.array(filterSchema).optional().describe('Conditions every event must match.'),
  utcOffsetMinutes: z
    .number()
    .int()
    .min(-840)
    .max(840)
    .optional()
    .describe(
      'Shift day/week/month boundaries by a fixed offset from UTC, e.g. 60 for UTC+1. Prefer timezone, which follows daylight saving.',
    ),
  timezone: z
    .string()
    .optional()
    .describe(
      'IANA time zone for day/week/month boundaries, e.g. "Europe/London" (follows daylight saving). Defaults to the project time zone, else UTC.',
    ),
  filterTestAccounts: z
    .boolean()
    .optional()
    .describe(
      "Leave out internal and test traffic, using the project's internalFilters setting (see get_settings).",
    ),
};

const stepSchema = z.object({
  event: z.string().describe('Event name, e.g. "$pageview" or "signup_completed".'),
  filters: z.array(filterSchema).optional().describe('Extra conditions for this step only.'),
  label: z.string().optional().describe('Display name for this step.'),
});

/** Every way a trends series can aggregate its events. */
export const TRENDS_MATHS = [
  'total',
  'dau',
  'unique_persons',
  'unique_sessions',
  'unique_groups',
  'wau',
  'mau',
  'first_time',
  'sum',
  'avg',
  'min',
  'max',
  'median',
  'p75',
  'p90',
  'p95',
  'p99',
  'revenue',
  'avg_count_per_actor',
  'min_count_per_actor',
  'max_count_per_actor',
  'median_count_per_actor',
  'p75_count_per_actor',
  'p90_count_per_actor',
  'p95_count_per_actor',
  'p99_count_per_actor',
] as const;

export type TrendsMath = (typeof TRENDS_MATHS)[number];

const aggregateBy = z
  .string()
  .optional()
  .describe(
    'What unique counts and per-actor maths count: "person" (default), "session", or a group type such as "company" (from glass.group("company", id)).',
  );

const breakdownSpec = z
  .union([z.string(), z.array(z.string()).min(1).max(4)])
  .optional()
  .describe(
    'Split by one or more properties, e.g. "browser", "person.plan", "group.company.plan" or ["browser","utm_source"] (joined with " · "). "cohort" splits by the saved cohorts in breakdownCohorts.',
  );

const breakdownExtras = {
  breakdownLimit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Top N breakdown values to keep. Default 10.'),
  breakdownCohorts: z
    .array(z.string())
    .max(10)
    .optional()
    .describe('With breakdown "cohort": the saved cohort keys to compare (list_cohorts).'),
  breakdownBins: z
    .number()
    .int()
    .min(2)
    .max(50)
    .optional()
    .describe(
      'For a numeric breakdown property: group its values into this many equal-width ranges instead of one line per value.',
    ),
};

export const trendsSpec = z
  .object({
    ...common,
    series: z
      .array(
        z.object({
          event: z
            .union([z.string(), z.array(z.string()).min(1).max(20)])
            .describe('Event name, a list of names (any of them), or "*" for all events.'),
          math: z
            .enum(TRENDS_MATHS)
            .optional()
            .describe(
              'How to aggregate. total: events (default). dau/unique_persons: unique actors per interval. wau/mau: unique actors in the 7/30 days up to each point. unique_sessions. unique_groups: distinct groups of groupType. first_time: actors doing it for the first time ever. sum/avg/min/max/median/p75/p90/p95/p99 of a numeric "property". revenue: sum of revenue in the base currency. avg|min|max|median|p75|p90|p95|p99_count_per_actor: how many times each actor did it.',
            ),
          property: z
            .string()
            .optional()
            .describe(
              'Numeric property for sum, avg, min, max and the percentiles, e.g. "amount".',
            ),
          groupType: z
            .string()
            .optional()
            .describe('For unique_groups: the group type to count, e.g. "company".'),
          filters: z.array(filterSchema).optional(),
          label: z.string().optional(),
        }),
      )
      .min(1)
      .max(20)
      .describe('One line per series; formulas refer to them as A, B, C… in order.'),
    interval: z
      .enum(['minute', 'hour', 'day', 'week', 'month'])
      .optional()
      .describe('Bucket size. Defaults to "day". "minute" works for ranges up to two days.'),
    aggregateBy,
    breakdown: breakdownSpec,
    ...breakdownExtras,
    formulas: z
      .array(
        z.object({
          expr: z
            .string()
            .min(1)
            .describe(
              'Arithmetic over series letters, e.g. "B / A * 100" (A is the first series).',
            ),
          label: z.string().optional(),
        }),
      )
      .max(5)
      .optional()
      .describe('Lines computed from the series, per interval and breakdown value.'),
    formulaOnly: z
      .boolean()
      .optional()
      .describe('Show only the formula lines (the series still run, as inputs).'),
    compare: z
      .boolean()
      .optional()
      .describe('Also return the previous period of the same length, aligned bucket by bucket.'),
    cumulative: z.boolean().optional().describe('Running totals instead of per-interval values.'),
    smoothing: z
      .number()
      .int()
      .min(2)
      .max(90)
      .optional()
      .describe('Moving average over this many intervals, e.g. 7 on a daily chart.'),
    trendLine: z.boolean().optional().describe('Add a least-squares trend line to each series.'),
    display: z
      .enum(['line', 'area', 'bar', 'bar_value', 'table', 'pie', 'number', 'world_map'])
      .optional()
      .describe('How the dashboard draws it. world_map expects breakdown "country".'),
    logScale: z.boolean().optional().describe('Dashboard: logarithmic y axis.'),
    percentStack: z.boolean().optional().describe('Dashboard: stack breakdowns as shares of 100%.'),
    showValues: z.boolean().optional().describe('Dashboard: label points with their values.'),
  })
  .describe('Event counts or aggregates over time.');

const funnelStepSchema = stepSchema.extend({
  optional: z
    .boolean()
    .optional()
    .describe('People may skip this step and still reach the next ones (not for the first step).'),
});

export const funnelSpec = z
  .object({
    ...common,
    steps: z
      .array(funnelStepSchema)
      .min(2)
      .max(20)
      .describe('Ordered steps. A person converts by doing each step after the previous one.'),
    window: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        'Maximum time from the first step to the last, e.g. "1h", "7d", "2w". Seconds if a number. Default "7d".',
      ),
    order: z
      .enum(['ordered', 'strict', 'unordered'])
      .optional()
      .describe(
        '"ordered" (default): each step after the previous one, other events in between allowed. "strict": each step must be the very next event. "unordered": steps in any order within the window.',
      ),
    exclusions: z
      .array(
        z.object({
          event: z.string(),
          filters: z.array(filterSchema).optional(),
          fromStep: z
            .number()
            .int()
            .min(1)
            .describe('Step after which the event excludes (1 = first).'),
          toStep: z.number().int().min(2).describe('Step before which it excludes.'),
        }),
      )
      .max(5)
      .optional()
      .describe(
        'Drop attempts where this event happened between two steps, e.g. a "coupon_applied" between checkout and purchase.',
      ),
    aggregateBy,
    breakdown: z
      .union([z.string(), z.array(z.string()).min(1).max(4)])
      .optional()
      .describe(
        'Split by one or more properties, e.g. "utm_source" or ["utm_source","device"]. "cohort" splits by breakdownCohorts.',
      ),
    breakdownAttribution: z
      .union([z.enum(['first_touch', 'last_touch', 'all_steps']), z.number().int().min(1)])
      .optional()
      .describe(
        'Which event the breakdown value comes from: the first step (default), the last step reached, a step number, or "all_steps" (the value must be the same on every step).',
      ),
    ...breakdownExtras,
    viz: z
      .enum(['steps', 'time_to_convert', 'trends'])
      .optional()
      .describe(
        '"steps" (default): counts and conversion per step. "time_to_convert": the distribution of time between fromStep and toStep. "trends": conversion rate over time, by when people entered.',
      ),
    fromStep: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('time_to_convert / trends: from this step (default 1).'),
    toStep: z
      .number()
      .int()
      .min(2)
      .optional()
      .describe('time_to_convert / trends: to this step (default the last).'),
    interval: z
      .enum(['hour', 'day', 'week', 'month'])
      .optional()
      .describe('trends view: bucket size. Default picks from the range length.'),
  })
  .describe('Conversion through an ordered sequence of events.');

export const funnelCorrelationSpec = funnelSpec
  .extend({
    correlation: z
      .enum(['events', 'properties'])
      .optional()
      .describe(
        '"events" (default): which other events people did before converting or dropping off. "properties": which values of `properties` go with converting.',
      ),
    properties: z
      .array(z.string())
      .max(10)
      .optional()
      .describe(
        'For correlation "properties": person or first-step properties, e.g. ["person.plan","browser"].',
      ),
    exclude: z.array(z.string()).optional().describe('Events to leave out of the correlation.'),
    limit: z.number().int().min(1).max(50).optional().describe('Top N each way. Default 10.'),
  })
  .describe('What goes with converting through a funnel, and with dropping off.');

export const retentionSpec = z
  .object({
    ...common,
    cohortEvent: stepSchema.describe(
      'The event that puts a person in a cohort ("*" for any event). With retentionType "first_time", their first one in the range.',
    ),
    returnEvent: stepSchema.describe('The event that counts as coming back ("*" for any event).'),
    period: z
      .enum(['hour', 'day', 'week', 'month'])
      .optional()
      .describe('Cohort and return period. Default "week".'),
    periods: z
      .number()
      .int()
      .min(1)
      .max(52)
      .optional()
      .describe('How many periods after the cohort to measure. Default 8.'),
    retentionType: z
      .enum(['first_time', 'recurring'])
      .optional()
      .describe(
        '"first_time" (default): a person joins the cohort of their first cohortEvent in the range. "recurring": they join every period in which they did it, so returning users count again.',
      ),
    cumulative: z
      .boolean()
      .optional()
      .describe(
        'Count a person in period k if they came back in period k or any later one ("on or after"), instead of exactly in period k.',
      ),
    meanMethod: z
      .enum(['weighted', 'simple'])
      .optional()
      .describe(
        'The average row: "weighted" (default) by cohort size, or "simple", the plain mean of each cohort’s rate.',
      ),
    aggregateBy,
    breakdown: z
      .union([z.string(), z.array(z.string()).min(1).max(4)])
      .optional()
      .describe(
        'One retention table per value of a property of the cohort event, e.g. "utm_source", "person.plan", or "cohort" with breakdownCohorts.',
      ),
    breakdownLimit: breakdownExtras.breakdownLimit,
    breakdownCohorts: breakdownExtras.breakdownCohorts,
  })
  .describe('How many people come back after their first event.');

export const webSpec = z
  .object({
    ...common,
    interval: z
      .enum(['hour', 'day', 'week', 'month'])
      .optional()
      .describe('Time series bucket. Default picks from the range length.'),
    compare: z
      .boolean()
      .optional()
      .describe('Include totals for the previous period of the same length. Default true.'),
  })
  .describe(
    'Web analytics overview: visitors, pageviews, sessions, bounce rate and top breakdowns.',
  );

export const experimentSpec = z
  .object({
    project: common.project,
    flag: z.string().describe('Feature flag key whose variants are compared.'),
    goal: stepSchema
      .extend({
        value: z
          .string()
          .optional()
          .describe(
            'Optional numeric property summed per person (e.g. "revenue") for a mean metric.',
          ),
      })
      .describe('The conversion event.'),
    variants: z
      .array(z.string())
      .min(2)
      .optional()
      .describe(
        'Variant keys, control first. Defaults to the variants seen, with "control" first if present.',
      ),
    from: time.optional(),
    to: time.optional(),
  })
  .describe('A/B test readout for a flag.');

export const sqlSpec = z
  .object({
    project: common.project,
    query: z
      .string()
      .min(1)
      .describe(
        'One read-only SELECT. Tables: events, identities (D1 mode) or <namespace>.events / <namespace>.identities (lake mode).',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe('Maximum rows returned. Default 1000.'),
  })
  .describe('Raw read-only SQL against the event store.');

export type TrendsSpec = z.infer<typeof trendsSpec>;
export type FunnelSpec = z.infer<typeof funnelSpec>;
export type FunnelCorrelationSpec = z.infer<typeof funnelCorrelationSpec>;
export type RetentionSpec = z.infer<typeof retentionSpec>;
export type WebSpec = z.infer<typeof webSpec>;
export type ExperimentSpec = z.infer<typeof experimentSpec>;
export type SqlSpec = z.infer<typeof sqlSpec>;
export type FilterSpec = z.infer<typeof filterSchema>;
