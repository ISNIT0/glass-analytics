/**
 * Revenue at ingest: events that carry money get normalised `$revenue_*` fields
 * in the base currency, so every report and both stores read revenue the same way.
 *
 * Two ways an event carries revenue:
 * - it matches one of the project's `revenueEvents` (an event name with the
 *   property holding the amount, and optionally currency, product and subscription);
 * - it already has `$revenue_amount` and `$revenue_currency` (Stripe events, or an
 *   app that sends them).
 *
 * Fields written (in `props`):
 * - `$revenue_base`: the amount in the base currency (negative for refunds);
 * - `$revenue_amount`, `$revenue_currency`: the original amount and currency;
 * - `$revenue_product`: the product or plan, when known;
 * - `$subscription_id`, `$mrr` (monthly recurring revenue in the base currency, 0 when
 *   cancelled), `$subscription_status`, and `$mrr_grace_days` for payment-based
 *   subscriptions (no payment within the grace period counts as churned).
 * - `$revenue_unconverted: true` when no exchange rate was available.
 */

import { convert, type RateTable, roundMoney } from './fx.ts';
import type { RevenueEvent } from './settings.ts';

type Props = Record<string, unknown>;

function at(props: Props, path: string | undefined): unknown {
  if (!path) return undefined;
  let v: unknown = props;
  for (const part of path.replace(/^props\./, '').split('.')) {
    if (!v || typeof v !== 'object') return undefined;
    v = (v as Props)[part];
  }
  return v;
}

const numberOf = (v: unknown): number | null => {
  const n =
    typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

/** The currencies an event's revenue and MRR are in (empty when it carries neither). */
export function revenueCurrencies(
  event: string,
  props: Props,
  rules: readonly RevenueEvent[],
  base: string,
): string[] {
  const out: string[] = [];
  if (props.$revenue_amount !== undefined && typeof props.$revenue_currency === 'string') {
    out.push(props.$revenue_currency.toUpperCase());
  } else {
    const rule = rules.find((r) => r.event === event);
    if (rule) {
      const c = at(props, rule.currencyProperty);
      out.push(
        (typeof c === 'string' && c.length === 3 ? c : (rule.currency ?? base)).toUpperCase(),
      );
    }
  }
  if (props.$mrr_amount !== undefined && typeof props.$mrr_currency === 'string')
    out.push(props.$mrr_currency.toUpperCase());
  return out;
}

/**
 * Add the normalised revenue fields to an event's props. Returns null when the event carries no
 * revenue and no subscription state. `rates` are for the event's day (an empty table is enough
 * when everything is in the base currency).
 */
export function applyRevenue(
  event: string,
  props: Props,
  rules: readonly RevenueEvent[],
  base: string,
  rates: RateTable,
): Props | null {
  const baseCcy = base.toUpperCase();
  let out: Props | null = null;
  // Money that moved: a payment (positive) or a refund (negative).
  let amount: number | null = null;
  let currency = baseCcy;
  let product: unknown;
  let subscription: unknown;
  let interval: 'month' | 'year' = 'month';
  let fromRule = false;
  if (props.$revenue_amount !== undefined && typeof props.$revenue_currency === 'string') {
    amount = numberOf(props.$revenue_amount);
    currency = props.$revenue_currency.toUpperCase();
    product = props.$revenue_product;
  } else {
    const rule = rules.find((r) => r.event === event);
    if (rule) {
      fromRule = true;
      amount = numberOf(at(props, rule.amountProperty));
      const c = at(props, rule.currencyProperty);
      currency = (
        typeof c === 'string' && c.length === 3 ? c : (rule.currency ?? baseCcy)
      ).toUpperCase();
      product = at(props, rule.productProperty);
      subscription = at(props, rule.subscriptionProperty);
      interval = rule.interval ?? 'month';
      if (amount !== null && rule.kind === 'refund') amount = -Math.abs(amount);
    }
  }
  if (amount !== null) {
    out = { ...props, $revenue_amount: amount, $revenue_currency: currency };
    if (product !== undefined && product !== null && product !== '')
      out.$revenue_product = String(product).slice(0, 200);
    const converted = convert(amount, currency, baseCcy, rates);
    if (converted === null) {
      out.$revenue_unconverted = true;
      delete out.$revenue_base;
    } else {
      out.$revenue_base = roundMoney(converted, baseCcy);
      delete out.$revenue_unconverted;
    }
    // A payment of a subscription (custom events): its amount is the subscription's MRR until the
    // next one; 0 cancels it, and no payment within the grace period counts as churned.
    if (
      fromRule &&
      subscription !== undefined &&
      subscription !== null &&
      subscription !== '' &&
      amount >= 0
    ) {
      out.$subscription_id = String(subscription).slice(0, 200);
      if (converted !== null)
        out.$mrr = roundMoney(interval === 'year' ? converted / 12 : converted, baseCcy);
      out.$subscription_status = amount > 0 ? 'active' : 'canceled';
      out.$mrr_grace_days = interval === 'year' ? 370 : 35;
    }
  }
  // Subscription state with an explicit monthly amount (Stripe subscription events).
  if (props.$mrr_amount !== undefined && typeof props.$mrr_currency === 'string') {
    const mrrAmount = numberOf(props.$mrr_amount);
    out = out ?? { ...props };
    const mrr = mrrAmount === null ? null : convert(mrrAmount, props.$mrr_currency, baseCcy, rates);
    if (mrr === null) out.$revenue_unconverted = true;
    else out.$mrr = roundMoney(mrr, baseCcy);
  }
  return out;
}
