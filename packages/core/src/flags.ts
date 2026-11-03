/**
 * Feature flags.
 *
 * A flag either returns `null` (off for this user) or a value: `"on"` for simple
 * flags, or a variant key for multivariate flags. Assignment is deterministic —
 * a hash of the flag key and the user's `distinct_id` — so the browser, the
 * Worker and your own servers always agree, with no shared state.
 *
 * We hash `distinct_id` (the device id), not the user id, because Glass keeps
 * `distinct_id` stable across `identify()`: logging in never flips a user's
 * experiment variant mid-session.
 */

import { type EvaluationContext, type Filter, matchFilter } from './filters.ts';
import { fnv1a32 } from './hash.ts';

export interface FlagVariant {
  key: string;
  /** Relative weight; weights need not sum to 100. */
  weight: number;
}

export interface FlagRule {
  /** All conditions must match (AND). Properties as in query filters, e.g. `person.plan`, `country`. */
  conditions: Filter[];
  /** Percentage (0-100) of matching users who get the flag. Defaults to the flag's rollout. */
  rollout?: number;
  /** Force a specific variant for matching users. */
  variant?: string;
}

export interface FlagDefinition {
  key: string;
  description?: string;
  enabled: boolean;
  /** Percentage (0-100) of users who get the flag when no rule matches. */
  rollout: number;
  /** Multivariate split. Omit for a simple on/off flag. The first variant is the control. */
  variants?: FlagVariant[];
  /** Targeting rules, checked in order; the first match wins. */
  rules?: FlagRule[];
  /** Change to reshuffle everyone's buckets. */
  salt?: string;
}

export const FLAG_ON = 'on';

/** A user's position in [0, 100) for a given flag and purpose. */
export function bucketOf(flag: Pick<FlagDefinition, 'key' | 'salt'>, distinctId: string, purpose = 'rollout'): number {
  return (fnv1a32(`${flag.key}:${flag.salt ?? ''}:${purpose}:${distinctId}`) % 10_000) / 100;
}

function pickVariant(flag: FlagDefinition, distinctId: string): string {
  const variants = flag.variants ?? [];
  const total = variants.reduce((a, v) => a + Math.max(0, v.weight), 0);
  if (total <= 0) return variants[0]?.key ?? FLAG_ON;
  const point = (bucketOf(flag, distinctId, 'variant') / 100) * total;
  let cumulative = 0;
  for (const v of variants) {
    cumulative += Math.max(0, v.weight);
    if (point < cumulative) return v.key;
  }
  return variants[variants.length - 1]!.key;
}

/** Evaluate one flag. Returns null when the flag is off for this context. */
export function evaluateFlag(flag: FlagDefinition, ctx: EvaluationContext): string | null {
  if (!flag.enabled) return null;
  let rollout = flag.rollout;
  let forced: string | undefined;
  for (const rule of flag.rules ?? []) {
    if (rule.conditions.every((c) => matchFilter(c, ctx))) {
      rollout = rule.rollout ?? flag.rollout;
      forced = rule.variant;
      break;
    }
  }
  if (bucketOf(flag, ctx.distinct_id) >= rollout) return null;
  if (forced) return forced;
  return flag.variants && flag.variants.length > 0 ? pickVariant(flag, ctx.distinct_id) : FLAG_ON;
}

/** Evaluate every flag for a context. Flags that are off are omitted. */
export function evaluateFlags(flags: readonly FlagDefinition[], ctx: EvaluationContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const flag of flags) {
    const value = evaluateFlag(flag, ctx);
    if (value !== null) out[flag.key] = value;
  }
  return out;
}

const FLAG_KEY = /^[a-z0-9][a-z0-9_.-]{0,99}$/i;

/** Validate a definition, returning a list of human-readable problems (empty when valid). */
export function validateFlag(flag: FlagDefinition): string[] {
  const problems: string[] = [];
  if (!FLAG_KEY.test(flag.key)) problems.push('key must be 1-100 characters: letters, digits, "_", "-", "."');
  if (!(flag.rollout >= 0 && flag.rollout <= 100)) problems.push('rollout must be between 0 and 100');
  const keys = new Set<string>();
  for (const v of flag.variants ?? []) {
    if (!FLAG_KEY.test(v.key)) problems.push(`variant "${v.key}" has an invalid key`);
    if (keys.has(v.key)) problems.push(`variant "${v.key}" is duplicated`);
    if (!(v.weight >= 0)) problems.push(`variant "${v.key}" needs a weight >= 0`);
    keys.add(v.key);
  }
  if (flag.variants && flag.variants.length === 1) problems.push('a multivariate flag needs at least two variants');
  for (const rule of flag.rules ?? []) {
    if (rule.variant && !keys.has(rule.variant)) problems.push(`rule forces unknown variant "${rule.variant}"`);
    if (rule.rollout !== undefined && !(rule.rollout >= 0 && rule.rollout <= 100)) {
      problems.push('rule rollout must be between 0 and 100');
    }
  }
  return problems;
}
