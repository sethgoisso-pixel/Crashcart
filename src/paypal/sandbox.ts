// PayPal SANDBOX client (Orders v2). The base URL is fixed to the sandbox on purpose:
// this project never talks to the live PayPal API and never moves real money.
// Credentials come from the caller (environment variables on the server), never from a file.

import { fromPayPalOrder } from "../core/paypal.ts";
import type { OrderSummary } from "../core/types.ts";

export const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface PayPalCreds {
  clientId: string;
  clientSecret: string;
}

export interface PayPalResult {
  id: string;
  status: string;
  /** Link where a sandbox buyer approves the order on PayPal's own page (we never imitate it). */
  approveUrl?: string;
  /** The order as PayPal returned it when read back, converted to our simplified shape. */
  readback?: { currency: string; total: number; items: number };
  /** Did PayPal's stored order match what we sent (currency, total, item count)? */
  matches: boolean;
}

const realFetch: FetchLike = (url, init) => fetch(url, init);
const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export async function getAccessToken(creds: PayPalCreds, fetchImpl: FetchLike = realFetch): Promise<string> {
  const basic = btoa(`${creds.clientId}:${creds.clientSecret}`); // btoa also exists in Cloudflare Workers (Buffer does not)
  const res = await fetchImpl(`${SANDBOX_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PayPal token request failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  const token = JSON.parse(text).access_token;
  if (typeof token !== "string" || !token) throw new Error("PayPal token response has no access_token");
  return token;
}

/**
 * Builds an Orders v2 request body from a simplified order. The payee is left out on purpose:
 * PayPal then pays the sandbox business account that owns the REST app, which stands in for
 * the fictional merchant. A difference between the item sum and the total (for example a
 * "mandatory fee") is sent as a handling or discount line so that PayPal accepts the order
 * and the amount stays exactly what the agent asked for.
 */
export function toPayPalOrderRequest(order: OrderSummary, referenceId: string): Record<string, unknown> {
  const cur = order.currency;
  const itemSum = order.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  const diff = Math.round((order.total - itemSum) * 100) / 100;

  const breakdown: Record<string, unknown> = {};
  if (order.items.length > 0) {
    breakdown.item_total = { currency_code: cur, value: money(itemSum) };
    if (diff > 0) breakdown.handling = { currency_code: cur, value: money(diff) };
    if (diff < 0) breakdown.discount = { currency_code: cur, value: money(-diff) };
  }

  const unit: Record<string, unknown> = {
    reference_id: referenceId.slice(0, 256),
    description: "Crashcart sandbox test order",
    amount: {
      currency_code: cur,
      value: money(order.total),
      ...(order.items.length > 0 ? { breakdown } : {}),
    },
  };
  if (order.items.length > 0) {
    unit.items = order.items.map((i) => ({
      name: i.name.slice(0, 127),
      quantity: String(Math.max(1, Math.round(i.quantity))),
      unit_amount: { currency_code: cur, value: money(i.unitPrice) },
    }));
  }
  return { intent: "CAPTURE", purchase_units: [unit] };
}

function approveLink(body: any): string | undefined {
  const links: any[] = Array.isArray(body?.links) ? body.links : [];
  return links.find((l) => l?.rel === "payer-action" || l?.rel === "approve")?.href;
}

export async function getSandboxOrder(token: string, id: string, fetchImpl: FetchLike = realFetch): Promise<any> {
  const res = await fetchImpl(`${SANDBOX_BASE}/v2/checkout/orders/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PayPal get order failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** Creates a sandbox order, then reads it back from PayPal and checks it matches. Capture is NOT done here. */
export async function createSandboxOrder(
  token: string,
  order: OrderSummary,
  referenceId: string,
  fetchImpl: FetchLike = realFetch
): Promise<PayPalResult & { raw: { created: any; fetched: any } }> {
  const res = await fetchImpl(`${SANDBOX_BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "paypal-request-id": `crashcart-${referenceId}-${Date.now()}`.slice(0, 100),
    },
    body: JSON.stringify(toPayPalOrderRequest(order, referenceId)),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PayPal create order failed (HTTP ${res.status}): ${text.slice(0, 400)}`);
  const created = JSON.parse(text);
  if (typeof created.id !== "string") throw new Error("PayPal create order response has no id");

  const fetched = await getSandboxOrder(token, created.id, fetchImpl);
  const back = fromPayPalOrder(fetched);
  const matches =
    back.currency === order.currency &&
    Math.abs(back.total - order.total) < 0.005 &&
    back.items.length === order.items.length;

  return {
    id: created.id,
    status: String(fetched.status ?? created.status ?? ""),
    approveUrl: approveLink(created) ?? approveLink(fetched),
    readback: { currency: back.currency, total: back.total, items: back.items.length },
    matches,
    raw: { created, fetched },
  };
}
