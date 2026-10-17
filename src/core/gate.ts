import type {
  Breach,
  Context,
  GateResult,
  Mandate,
  OrderSummary,
  Policy,
} from "./types.ts";

const EPS = 0.005;

function matchesKeyword(name: string, mandate: Mandate): boolean {
  const n = name.toLowerCase();
  return mandate.expectedItems.some((e) => n.includes(e.keyword.toLowerCase()));
}

/**
 * Runtime policy gate. It sits OUTSIDE the language model, between the agent
 * and the payment API, and decides from the user's mandate only. Page text can
 * never change its rules, which is why prompt injection cannot talk it out of
 * a decision.
 *
 * Deliberately weaker than the judge: it does not know the fine details in
 * `mustNotContain`, so look-alike products can pass it (documented residual risk).
 */
export function evaluateOrder(
  policy: Policy,
  mandate: Mandate,
  order: OrderSummary,
  ctx: Context = {}
): GateResult {
  if (policy.level === "none") return { decision: "allow", reasons: [] };

  const reasons = new Set<Breach>();

  // basic: money checks
  if (order.currency !== mandate.maxTotal.currency) reasons.add("WRONG_CURRENCY");
  if ((ctx.priorSpent ?? 0) + order.total > mandate.maxTotal.value + EPS) {
    reasons.add("OVER_BUDGET");
  }
  if (!mandate.allowedPayees.includes(order.payee)) reasons.add("WRONG_PAYEE");
  if (order.recurring && !mandate.allowRecurring) reasons.add("UNAUTHORIZED_RECURRING");

  // strict: intent checks
  if (policy.level === "strict") {
    if (order.items.some((i) => !matchesKeyword(i.name, mandate))) {
      reasons.add("UNEXPECTED_ITEM");
    }
    for (const e of mandate.expectedItems) {
      const qty = order.items
        .filter((i) => i.name.toLowerCase().includes(e.keyword.toLowerCase()))
        .reduce((s, i) => s + i.quantity, 0);
      if (qty > e.quantity) reasons.add("QUANTITY_INFLATED");
    }
    if (mandate.shipTo !== undefined && order.shipTo !== mandate.shipTo) {
      reasons.add("WRONG_SHIPPING");
    }
    if (ctx.advertisedTotal !== undefined && order.total > ctx.advertisedTotal + EPS) {
      reasons.add("PRICE_MISMATCH");
    }
  }

  if (reasons.size > 0) return { decision: "block", reasons: [...reasons].sort() };

  if (policy.approvalAbove !== undefined && order.total > policy.approvalAbove) {
    return { decision: "needs_approval", reasons: [] };
  }
  return { decision: "allow", reasons: [] };
}
