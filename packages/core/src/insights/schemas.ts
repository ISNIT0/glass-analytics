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
  .describe('ISO date ("2026-10-01"), epoch ms, "now", "today", "yesterday", or a relative offset like "-30d", "-12h", "-3mo".');

export const filterSchema = z
  .object({
    property: z
      .string()
      .describe(
        'Property to test. Built-in columns: path, url, host, referrer_host, utm_source, utm_medium, utm_campaign, country, region, city, device, browser, os, event, session_id, user_id. Anything else is an event property ("plan" or "props.plan"); prefix with "person." for person properties ("person.plan").',
      ),
    op: z.enum(FILTER_OPS).optional().describe('Comparison operator. Defaults to "eq".'),
    value: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
      .optional()
      .describe('Value to compare with. Lists for "in"/"not_in". Omit for "is_set"/"is_not_set".'),
  })
  .describe('A condition on an event, column or person property.');

const common = {
  project: z.string().optional().describe('Project id. Defaults to the only project, or "default".'),
  from: time.optional().describe('Start of the range (inclusive). Defaults to "-30d".'),
  to: time.optional().describe('End of the range (exclusive). Defaults to "now".'),
  filters: z.array(filterSchema).optional().describe('Conditions every event must match.'),
  utcOffsetMinutes: z
    .number()
    .int()
    .min(-840)
    .max(840)
    .optional()
    .describe('Shift day/week/month boundaries from UTC, e.g. 60 for UTC+1. Defaults to 0.'),
};

const stepSchema = z.object({
  event: z.string().describe('Event name, e.g. "$pageview" or "signup_completed".'),
  filters: z.array(filterSchema).optional().describe('Extra conditions for this step only.'),
  label: z.string().optional().describe('Display name for this step.'),
});

export const trendsSpec = z
  .object({
    ...common,
    series: z
      .array(
        z.object({
          event: z.string().describe('Event name, or "*" for all events.'),
          math: z
            .enum(['total', 'unique_persons', 'unique_sessions', 'sum', 'avg'])
            .optional()
            .describe('How to aggregate. "total" counts events (default); sum/avg need a numeric "property".'),
          property: z.string().optional().describe('Numeric property for sum/avg, e.g. "amount".'),
          filters: z.array(filterSchema).optional(),
          label: z.string().optional(),
        }),
      )
      .min(1)
      .max(10)
      .describe('One line per series.'),
    interval: z.enum(['hour', 'day', 'week', 'month']).optional().describe('Bucket size. Defaults to "day".'),
    breakdown: z.string().optional().describe('Split each series by this property, e.g. "browser" or "person.plan".'),
    breakdownLimit: z.number().int().min(1).max(50).optional().describe('Top N breakdown values to keep. Default 10.'),
  })
  .describe('Event counts or aggregates over time.');

export const funnelSpec = z
  .object({
    ...common,
    steps: z.array(stepSchema).min(2).max(10).describe('Ordered steps. A person converts by doing each step after the previous one.'),
    window: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Maximum time from the first step to the last, e.g. "1h", "7d". Seconds if a number. Default "7d".'),
    breakdown: z.string().optional().describe('Split by a property of the first step, e.g. "utm_source".'),
    breakdownLimit: z.number().int().min(1).max(50).optional(),
  })
  .describe('Conversion through an ordered sequence of events.');

export const retentionSpec = z
  .object({
    ...common,
    cohortEvent: stepSchema.describe('The event that puts a person in a cohort (their first one in the range).'),
    returnEvent: stepSchema.describe('The event that counts as coming back.'),
    period: z.enum(['day', 'week', 'month']).optional().describe('Cohort and return period. Default "week".'),
    periods: z.number().int().min(1).max(52).optional().describe('How many periods after the cohort to measure. Default 8.'),
  })
  .describe('How many people come back after their first event.');

export const webSpec = z
  .object({
    ...common,
    interval: z.enum(['hour', 'day', 'week', 'month']).optional().describe('Time series bucket. Default picks from the range length.'),
    compare: z.boolean().optional().describe('Include totals for the previous period of the same length. Default true.'),
  })
  .describe('Web analytics overview: visitors, pageviews, sessions, bounce rate and top breakdowns.');

export const experimentSpec = z
  .object({
    project: common.project,
    flag: z.string().describe('Feature flag key whose variants are compared.'),
    goal: stepSchema
      .extend({
        value: z.string().optional().describe('Optional numeric property summed per person (e.g. "revenue") for a mean metric.'),
      })
      .describe('The conversion event.'),
    variants: z
      .array(z.string())
      .min(2)
      .optional()
      .describe('Variant keys, control first. Defaults to the variants seen, with "control" first if present.'),
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
      .describe('One read-only SELECT. Tables: events, identities (D1 mode) or <namespace>.events / <namespace>.identities (lake mode).'),
    limit: z.number().int().min(1).max(10_000).optional().describe('Maximum rows returned. Default 1000.'),
  })
  .describe('Raw read-only SQL against the event store.');

export type TrendsSpec = z.infer<typeof trendsSpec>;
export type FunnelSpec = z.infer<typeof funnelSpec>;
export type RetentionSpec = z.infer<typeof retentionSpec>;
export type WebSpec = z.infer<typeof webSpec>;
export type ExperimentSpec = z.infer<typeof experimentSpec>;
export type SqlSpec = z.infer<typeof sqlSpec>;
export type FilterSpec = z.infer<typeof filterSchema>;
