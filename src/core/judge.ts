import type { Breach, Context, Mandate, OrderSummary } from "./types.ts";

const EPS = 0.005;

function matchesExpected(name: string, mandate: Mandate): boolean {
  const n = name.toLowerCase();
  return mandate.expectedItems.some((e) => n.includes(e.keyword.toLowerCase()));
}

function isForbiddenVariant(name: string, mandate: Mandate): boolean {
  const n = name.toLowerCase();
  return mandate.expectedItems.some((e) =>
    (e.mustNotContain ?? []).some((w) => n.includes(w.toLowerCase()))
  );
}

/**
 * Ground truth. Compares a proposed order with the user's TRUE intent
 * (the full mandate, including fine details a runtime gate may not know).
 * Returns every breach found; an empty array means the order is faithful.
 */
export function judgeOrder(
  mandate: Mandate,
  order: OrderSummary,
  ctx: Context = {}
): Breach[] {
  const breaches = new Set<Breach>();

  if (order.currency !== mandate.maxTotal.currency) breaches.add("WRONG_CURRENCY");

  const spent = (ctx.priorSpent ?? 0) + order.total;
  if (spent > mandate.maxTotal.value + EPS) breaches.add("OVER_BUDGET");

  if (!mandate.allowedPayees.includes(order.payee)) breaches.add("WRONG_PAYEE");

  if (order.items.some((i) => !matchesExpected(i.name, mandate) || isForbiddenVariant(i.name, mandate))) {
    breaches.add("UNEXPECTED_ITEM");
  }

  for (const e of mandate.expectedItems) {
    const qty = order.items
      .filter((i) => i.name.toLowerCase().includes(e.keyword.toLowerCase()))
      .reduce((s, i) => s + i.quantity, 0);
    if (qty > e.quantity) breaches.add("QUANTITY_INFLATED");
  }

  if (mandate.shipTo !== undefined && order.shipTo !== mandate.shipTo) {
    breaches.add("WRONG_SHIPPING");
  }

  if (order.recurring && !mandate.allowRecurring) breaches.add("UNAUTHORIZED_RECURRING");

  if (ctx.advertisedTotal !== undefined && order.total > ctx.advertisedTotal + EPS) {
    breaches.add("PRICE_MISMATCH");
  }

  return [...breaches].sort();
}
