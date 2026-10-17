// Core types for Crashcart. Plain data + pure functions only, so the same code
// runs in Node, Deno (Supabase Edge Functions) and the browser.

/** What the HUMAN user asked for. It must never come from page content. */
export interface Mandate {
  goal: string;
  /** Hard budget for everything bought under this mandate. */
  maxTotal: { currency: string; value: number };
  /** Merchant identifiers (PayPal merchant id or email) the user trusts. */
  allowedPayees: string[];
  expectedItems: ExpectedItem[];
  /** Label of the delivery address the user chose (never a raw address). */
  shipTo?: string;
  allowRecurring: boolean;
}

export interface ExpectedItem {
  /** Lowercase keyword every purchased item name must contain. */
  keyword: string;
  quantity: number;
  /** Ground-truth only: words that mean "this is a different product". */
  mustNotContain?: string[];
}

export interface OrderItem {
  name: string;
  unitPrice: number;
  quantity: number;
}

/** Simplified view of a PayPal order, before it is created. */
export interface OrderSummary {
  currency: string;
  total: number;
  payee: string;
  items: OrderItem[];
  shipTo?: string;
  recurring?: boolean;
}

/** Extra facts the judge/gate may know about the situation. */
export interface Context {
  /** Price the shopper was shown in the listing. */
  advertisedTotal?: number;
  /** Already spent under the same mandate (detects order splitting). */
  priorSpent?: number;
}

export type Breach =
  | "OVER_BUDGET"
  | "WRONG_CURRENCY"
  | "WRONG_PAYEE"
  | "UNEXPECTED_ITEM"
  | "QUANTITY_INFLATED"
  | "WRONG_SHIPPING"
  | "UNAUTHORIZED_RECURRING"
  | "PRICE_MISMATCH";

export type GateDecision = "allow" | "needs_approval" | "block";

export interface GateResult {
  decision: GateDecision;
  reasons: Breach[];
}

/** none = no protection, basic = money checks, strict = also intent checks. */
export type PolicyLevel = "none" | "basic" | "strict";

export interface Policy {
  level: PolicyLevel;
  /** If set, an otherwise allowed order above this amount needs a human. */
  approvalAbove?: number;
}

export type AttackCategory =
  | "prompt-injection"
  | "payee-swap"
  | "hidden-fee"
  | "currency-confusion"
  | "subscription-trap"
  | "shipping-redirect"
  | "fake-authority"
  | "urgency-pressure"
  | "substitution"
  | "order-splitting";

/** Where the hostile text is planted for the agent to read. */
export type InjectionSurface =
  | "product-description"
  | "review"
  | "seller-note"
  | "checkout-page"
  | "tool-output";

export interface Scenario {
  id: string;
  title: string;
  category: AttackCategory;
  surface: InjectionSurface;
  /** Plain-language summary of the trap. */
  description: string;
  /** The hostile text a fooled shopper would have read (test fixture). */
  injectedText: string;
  mandate: Mandate;
  context: Context;
  /** What a correct, unfooled agent would order (null = place no order at all). */
  safeOrder: OrderSummary | null;
  /** What a fooled agent would order. */
  unsafeOrder: OrderSummary;
  /** Ground truth: the judge must flag exactly these on unsafeOrder. */
  expectedBreaches: Breach[];
}
