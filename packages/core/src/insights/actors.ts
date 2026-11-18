/**
 * Actors: the people (or sessions, or groups) behind a number on a chart.
 *
 * Every insight that counts actors can list them: the people in a trends point,
 * those who converted at or dropped off after a funnel step, the members of a
 * retention cell. Each insight module compiles its own actors SQL from the same
 * CTE chain as its results, so the list always agrees with the number. The SQL
 * returns `actor` and `n` (how many matching events, or 1).
 */

import { z } from 'zod/v4';
import { type Aggregation, parseAggregation } from '../sql/source.ts';
import { compileFunnelActors } from './funnel.ts';
import { compileTrendsActors } from './trends.ts';
import type { QueryContext } from './types.ts';

export const actorSelection = z
  .object({
    series: z.number().int().min(0).optional().describe('Trends: index of the series (0 is A).'),
    bucket: z
      .union([z.number(), z.string()])
      .optional()
      .describe(
        'Trends: bucket start (epoch ms or ISO date) from the result; omit for the whole range.',
      ),
    breakdown: z.string().optional().describe('Breakdown value to narrow to.'),
    step: z.number().int().min(1).optional().describe('Funnel: step number (1 is the first step).'),
    status: z
      .enum(['converted', 'dropped'])
      .optional()
      .describe(
        'Funnel: people who reached the step ("converted"), or reached the step before but not this one ("dropped").',
      ),
    cohort: z
      .union([z.number(), z.string()])
      .optional()
      .describe('Retention: cohort start (epoch ms or ISO date) from the result.'),
    period: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Retention: period number (0 is the cohort itself).'),
  })
  .describe('Which number to list the actors of.');

export type ActorSelection = z.infer<typeof actorSelection>;

export type ActorCompiler = (
  spec: unknown,
  ctx: QueryContext,
  selection: ActorSelection,
  page: { limit: number; offset: number },
) => string;

/** Insight kinds that can list their actors, registered by each module. */
export const ACTOR_COMPILERS: Record<string, ActorCompiler> = {
  trends: (spec, ctx, sel, page) => {
    const bucket = typeof sel.bucket === 'string' ? Date.parse(sel.bucket) : sel.bucket;
    return compileTrendsActors(
      spec as Parameters<typeof compileTrendsActors>[0],
      ctx,
      { series: sel.series ?? 0, bucket, breakdown: sel.breakdown },
      page,
    );
  },
  funnel: (spec, ctx, sel, page) =>
    compileFunnelActors(
      spec as Parameters<typeof compileFunnelActors>[0],
      ctx,
      { step: sel.step, status: sel.status, breakdown: sel.breakdown },
      page,
    ),
};

/** The aggregation a spec counts (its `aggregateBy`). */
export function aggregationOf(spec: { aggregateBy?: string }): Aggregation {
  return parseAggregation(spec.aggregateBy);
}
