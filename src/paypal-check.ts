// Smoke test for the PayPal SANDBOX connection. Creates one sandbox order for the safe cable,
// reads it back and prints what PayPal answered (no secrets are printed).
//   node src/paypal-check.ts
// Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox app credentials).

import { createSandboxOrder, getAccessToken } from "./paypal/sandbox.ts";
import type { OrderSummary } from "./core/types.ts";

const clientId = process.env.PAYPAL_CLIENT_ID;
const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (sandbox app credentials).");
  process.exit(2);
}

const order: OrderSummary = {
  currency: "USD",
  total: 12.99,
  payee: "CABLECO-SANDBOX",
  items: [{ name: "USB-C Cable 1m", unitPrice: 12.99, quantity: 1 }],
  shipTo: "home",
  recurring: false,
};

try {
  const token = await getAccessToken({ clientId, clientSecret });
  console.log("1. OAuth token request: OK (token not printed)");
  const r = await createSandboxOrder(token, order, "paypal-check");
  console.log(`2. Order created: id=${r.id} status=${r.status}`);
  console.log(`3. Read back from PayPal: ${JSON.stringify(r.readback)}  matches what we sent: ${r.matches}`);
  console.log(`4. Approve link for a sandbox buyer: ${r.approveUrl ?? "(none returned)"}`);
  console.log("\n--- purchase_units[0] as PayPal returned it (to verify our adapter field names) ---");
  console.log(JSON.stringify(r.raw.fetched.purchase_units?.[0], null, 2));
} catch (e) {
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
}
