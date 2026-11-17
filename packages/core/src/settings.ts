/**
 * Project settings: per-project configuration every surface reads.
 *
 * Stored as JSON on the project row (migration 0008). Every field is optional,
 * so older projects keep working and agents can change one setting at a time.
 */

import { z } from 'zod/v4';
import { filterSchema } from './insights/schemas.ts';
import { isValidTimeZone } from './time.ts';

export const revenueEventSchema = z.object({
  event: z.string().min(1).describe('Event that carries revenue, e.g. "order_paid".'),
  amountProperty: z
    .string()
    .min(1)
    .describe('Numeric property with the amount, in major units (e.g. 49.99), e.g. "amount".'),
  currencyProperty: z
    .string()
    .optional()
    .describe('Property with the ISO currency code (e.g. "currency"). Default: the base currency.'),
  currency: z
    .string()
    .length(3)
    .optional()
    .describe('Fixed currency for this event when it has no currency property, e.g. "GBP".'),
  productProperty: z
    .string()
    .optional()
    .describe('Property naming the product or plan, for revenue by product.'),
  subscriptionProperty: z
    .string()
    .optional()
    .describe('Property with a subscription id, so recurring revenue (MRR) can be tracked.'),
});

export type RevenueEvent = z.infer<typeof revenueEventSchema>;

export const projectSettingsSchema = z.object({
  timezone: z
    .string()
    .optional()
    .refine((tz) => tz === undefined || isValidTimeZone(tz), {
      message: 'Unknown time zone: use an IANA name such as "Europe/London".',
    })
    .describe(
      'IANA time zone for day/week/month boundaries in every report, e.g. "Europe/London". Default UTC.',
    ),
  internalFilters: z
    .array(filterSchema)
    .optional()
    .describe(
      'Conditions that mark internal or test traffic, e.g. [{"property":"person.email","op":"contains","value":"@acme.com"}]. Specs with filterTestAccounts: true leave out events matching ANY of them.',
    ),
  baseCurrency: z
    .string()
    .length(3)
    .optional()
    .describe('ISO code revenue is converted to for reporting, e.g. "GBP". Default "USD".'),
  revenueEvents: z
    .array(revenueEventSchema)
    .optional()
    .describe(
      'Events that carry revenue. Their amounts are converted to the base currency at ingest.',
    ),
  inAppIncludes: z
    .array(z.string())
    .optional()
    .describe(
      'Error tracking: path fragments of your own code (e.g. "/assets/app-"), so stack frames from them count as in-app.',
    ),
  allowFlagOverrides: z
    .boolean()
    .optional()
    .describe(
      'Let ?__glass_flags=key:variant in a page URL override flags in that browser, for QA.',
    ),
  errorRateLimitPerMinute: z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .optional()
    .describe(
      'Error tracking: keep at most this many exceptions per issue per minute. Default 100.',
    ),
});

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

export function parseSettings(raw: string | null | undefined): ProjectSettings {
  if (!raw) return {};
  try {
    const parsed = projectSettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * Turn internal-traffic conditions into filters that exclude it. Each condition
 * marks traffic as internal, so the exclusion keeps an event only when it matches
 * none of them: NOT (a OR b) = (NOT a) AND (NOT b).
 */
export function excludeInternal(
  internal: readonly z.infer<typeof filterSchema>[],
): z.infer<typeof filterSchema>[] {
  const negate: Record<string, string> = {
    eq: 'neq',
    neq: 'eq',
    contains: 'not_contains',
    not_contains: 'contains',
    in: 'not_in',
    not_in: 'in',
    is_set: 'is_not_set',
    is_not_set: 'is_set',
    gt: 'lte',
    gte: 'lt',
    lt: 'gte',
    lte: 'gt',
  };
  return internal.map((f) => ({
    ...f,
    op: negate[f.op ?? 'eq'] as z.infer<typeof filterSchema>['op'],
  }));
}
