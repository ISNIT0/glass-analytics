/**
 * Stripe as a revenue source: verifying webhook signatures, and turning Stripe
 * objects into Dataflare events with normalised revenue fields. Used by the
 * Worker's webhook and by `dataflare stripe import` (the same mapping both ways).
 *
 * - paid invoices → `$stripe_invoice_paid` (revenue)
 * - one-off charges (no invoice) → `$stripe_charge` (revenue)
 * - refunds → `$stripe_refund` (negative revenue)
 * - subscriptions created, updated or deleted → `$stripe_subscription` (MRR state)
 *
 * Events belong to the customer's person: `customer.metadata[personKey]` when the
 * app sets it (it should be the id passed to `glass.identify`), else a person
 * matched by email, else `stripe:<customer id>`. With a group type, events also
 * carry `$groups` (the customer's `metadata[groupKey]`, or the customer id), so
 * revenue can be reported per account.
 */

import type { WireEvent } from './events.ts';
import { fromMinorUnits } from './fx.ts';

/** Verify a `Stripe-Signature` header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`. */
export async function verifyStripeSignature(
  header: string | null | undefined,
  body: string,
  secret: string,
  now = Date.now(),
  toleranceSeconds = 300,
): Promise<boolean> {
  if (!header || !secret) return false;
  let t: string | null = null;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2).map((x) => x.trim());
    if (k === 't') t = v ?? null;
    else if (k === 'v1' && v) sigs.push(v.toLowerCase());
  }
  if (!t || !/^\d+$/.test(t) || sigs.length === 0) return false;
  if (Math.abs(now / 1000 - Number(t)) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`)),
  );
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  // Constant-time comparison.
  return sigs.some((sig) => {
    if (sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

export interface StripeLink {
  /** `customer.metadata` key holding your user id. Default "dataflare_id"; "user_id" and "userId" are also tried. */
  personKey?: string;
  /** Report revenue per account: the group type, e.g. "company". */
  groupType?: string;
  /** `customer.metadata` key holding the group key. Default: the Stripe customer id. */
  groupKey?: string;
}

/** What is known about a Stripe customer (from customer events, metadata or a lookup). */
export interface StripeCustomerLink {
  id: string;
  person?: string | null;
  group?: string | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const idOf = (v: unknown): string | undefined => str(v) ?? str(obj(v).id);

/** Person and group from a customer's metadata. */
export function linkFromCustomer(customer: Obj, link: StripeLink): StripeCustomerLink {
  const meta = obj(customer.metadata);
  const keys = [link.personKey ?? 'dataflare_id', 'dataflare_id', 'user_id', 'userId'];
  const person = keys.map((k) => str(meta[k])).find(Boolean) ?? null;
  const group = link.groupType ? (str(meta[link.groupKey ?? '']) ?? null) : null;
  return { id: String(customer.id), person, group };
}

/** Monthly amount of a subscription, in its currency's major units (0 unless it's paying). */
export function subscriptionMrr(sub: Obj): number {
  const status = str(sub.status) ?? '';
  if (!['active', 'past_due'].includes(status)) return 0;
  let total = 0;
  for (const item of (obj(sub.items).data as Obj[] | undefined) ?? []) {
    const price = obj(item.price ?? item.plan);
    const recurring = obj(price.recurring);
    const interval = str(recurring.interval) ?? str(price.interval) ?? 'month';
    const count = num(recurring.interval_count ?? price.interval_count) || 1;
    const unit =
      price.unit_amount_decimal !== undefined
        ? Number(price.unit_amount_decimal)
        : num(price.unit_amount ?? price.amount);
    const amount = unit * (num(item.quantity) || 1);
    const perMonth =
      interval === 'year'
        ? amount / 12
        : interval === 'week'
          ? (amount * 52) / 12
          : interval === 'day'
            ? (amount * 365) / 12
            : amount;
    total += perMonth / count;
  }
  const coupon = obj(obj(sub.discount).coupon);
  if (num(coupon.percent_off) > 0) total *= 1 - num(coupon.percent_off) / 100;
  return fromMinorUnits(total, str(sub.currency) ?? 'usd');
}

function productOf(lines: unknown): string | undefined {
  const first = ((obj(lines).data as Obj[] | undefined) ?? [])[0];
  if (!first) return undefined;
  const price = obj(first.price);
  return idOf(price.product) ?? str(first.description);
}

/**
 * Dataflare events for one Stripe event (none for types that carry no revenue). `customer` is what's
 * known about the object's customer; without it events go to `stripe:<customer id>`.
 */
export function stripeEvents(
  event: {
    id: string;
    type: string;
    created: number;
    data: { object: Obj; previous_attributes?: Obj };
  },
  customer: StripeCustomerLink | null,
  link: StripeLink = {},
): Omit<WireEvent, 'project'>[] {
  const o = event.data.object;
  const customerId =
    idOf(o.customer) ??
    (event.type.startsWith('customer.') && !event.type.startsWith('customer.subscription')
      ? str(o.id)
      : undefined);
  const person = customer?.person ?? null;
  const distinct = person ?? (customerId ? `stripe:${customerId}` : `stripe:${event.id}`);
  const groups =
    link.groupType && customerId ? { [link.groupType]: customer?.group ?? customerId } : undefined;
  // Payments are keyed on the Stripe object, so a webhook and an import of the same invoice
  // or charge are one event; subscription changes on the Stripe event.
  const base = (
    name: string,
    ts: number,
    props: Obj,
    key = event.id,
  ): Omit<WireEvent, 'project'> => ({
    id: `stripe_${key}`,
    event: name,
    ts: ts * 1000,
    distinct_id: distinct,
    user_id: person,
    props: {
      ...props,
      stripe_event: event.id,
      ...(customerId ? { stripe_customer: customerId } : {}),
      ...(groups ? { $groups: groups } : {}),
    },
  });
  const currency = (str(o.currency) ?? 'usd').toUpperCase();
  switch (event.type) {
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      if (event.type === 'invoice.payment_succeeded') return []; // invoice.paid covers it; listen to either
      const paidAt = num(obj(o.status_transitions).paid_at) || event.created;
      return [
        base(
          '$stripe_invoice_paid',
          paidAt,
          {
            invoice: str(o.id),
            subscription:
              idOf(o.subscription) ?? idOf(obj(obj(o.parent).subscription_details).subscription),
            billing_reason: str(o.billing_reason),
            $revenue_amount: fromMinorUnits(num(o.amount_paid), currency),
            $revenue_currency: currency,
            ...(productOf(o.lines) ? { $revenue_product: productOf(o.lines) } : {}),
          },
          str(o.id) ?? event.id,
        ),
      ];
    }
    case 'charge.succeeded': {
      // Charges for invoices are counted by invoice.paid.
      if (o.invoice) return [];
      return [
        base(
          '$stripe_charge',
          num(o.created) || event.created,
          {
            charge: str(o.id),
            description: str(o.description),
            $revenue_amount: fromMinorUnits(num(o.amount), currency),
            $revenue_currency: currency,
          },
          str(o.id) ?? event.id,
        ),
      ];
    }
    case 'charge.refunded': {
      const before = num(event.data.previous_attributes?.amount_refunded);
      const refunded = num(o.amount_refunded) - before;
      if (refunded <= 0) return [];
      return [
        base(
          '$stripe_refund',
          event.created,
          {
            charge: str(o.id),
            $revenue_amount: -fromMinorUnits(refunded, currency),
            $revenue_currency: currency,
          },
          `${str(o.id) ?? event.id}_refund_${num(o.amount_refunded)}`,
        ),
      ];
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const status =
        event.type === 'customer.subscription.deleted' ? 'canceled' : (str(o.status) ?? 'active');
      const items = (obj(o.items).data as Obj[] | undefined) ?? [];
      const price = obj(items[0]?.price ?? items[0]?.plan);
      return [
        base('$stripe_subscription', event.created, {
          subscription: str(o.id),
          change: event.type.split('.').pop(),
          plan: str(price.nickname) ?? idOf(price.product),
          interval: str(obj(price.recurring).interval) ?? str(price.interval),
          $subscription_id: str(o.id),
          $subscription_status: status,
          $mrr_amount: status === 'canceled' ? 0 : subscriptionMrr(o),
          $mrr_currency: currency,
          ...(idOf(price.product) ? { $revenue_product: idOf(price.product) } : {}),
        }),
      ];
    }
    default:
      return [];
  }
}

/** The Stripe event types the webhook should send. */
export const STRIPE_EVENT_TYPES = [
  'invoice.paid',
  'charge.succeeded',
  'charge.refunded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.created',
  'customer.updated',
] as const;
