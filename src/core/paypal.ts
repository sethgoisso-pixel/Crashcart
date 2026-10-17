import type { OrderSummary } from "./types.ts";

/**
 * Adapter from a PayPal Orders v2 payload (the body an agent sends to
 * POST /v2/checkout/orders) to Crashcart's OrderSummary.
 *
 * Field names follow the public Orders v2 schema as I understand it
 * (purchase_units[].amount / payee / items / shipping). Verify against the
 * current docs and a real sandbox response before relying on it.
 * PayPal sends amounts and quantities as STRINGS, hence Number().
 */
interface PayPalMoney {
  currency_code?: string;
  value?: string;
}
interface PayPalItem {
  name?: string;
  quantity?: string;
  unit_amount?: PayPalMoney;
}
interface PayPalPurchaseUnit {
  amount?: PayPalMoney;
  payee?: { email_address?: string; merchant_id?: string };
  items?: PayPalItem[];
  shipping?: { name?: { full_name?: string }; address?: Record<string, string> };
}
export interface PayPalOrderRequest {
  purchase_units?: PayPalPurchaseUnit[];
}

export interface AdapterOptions {
  /** Maps a raw shipping address to the label the user chose (e.g. "home"). */
  labelShipping?: (address: Record<string, string> | undefined) => string | undefined;
  recurring?: boolean;
}

export function fromPayPalOrder(
  body: PayPalOrderRequest,
  opts: AdapterOptions = {}
): OrderSummary {
  const units = body.purchase_units ?? [];
  if (units.length === 0) throw new Error("order has no purchase_units");
  // Several units = several payees or totals; refuse to guess.
  if (units.length > 1) throw new Error("multiple purchase_units are not supported yet");

  const u = units[0];
  const currency = u.amount?.currency_code;
  const total = Number(u.amount?.value);
  if (!currency || !Number.isFinite(total)) throw new Error("order amount is missing or invalid");

  return {
    currency,
    total,
    payee: u.payee?.merchant_id ?? u.payee?.email_address ?? "",
    items: (u.items ?? []).map((i) => ({
      name: i.name ?? "",
      unitPrice: Number(i.unit_amount?.value),
      quantity: Number(i.quantity ?? "1"),
    })),
    shipTo: opts.labelShipping?.(u.shipping?.address),
    recurring: opts.recurring ?? false,
  };
}
