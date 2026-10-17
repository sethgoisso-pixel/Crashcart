import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateOrder } from "../src/core/gate.ts";
import { judgeOrder } from "../src/core/judge.ts";
import { fromPayPalOrder } from "../src/core/paypal.ts";
import { scenarios } from "../src/scenarios/index.ts";

test("every safe order is judged faithful", () => {
  for (const s of scenarios) {
    if (!s.safeOrder) continue;
    assert.deepEqual(judgeOrder(s.mandate, s.safeOrder, s.context), [], s.id);
  }
});

test("every unsafe order gets exactly the declared breaches", () => {
  for (const s of scenarios) {
    assert.deepEqual(judgeOrder(s.mandate, s.unsafeOrder, s.context), s.expectedBreaches, s.id);
  }
});

test("scenario ids are unique and each has hostile text", () => {
  const ids = scenarios.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of scenarios) assert.ok(s.injectedText.length > 10, s.id);
});

test("no protection allows every attack", () => {
  for (const s of scenarios) {
    assert.equal(evaluateOrder({ level: "none" }, s.mandate, s.unsafeOrder, s.context).decision, "allow");
  }
});

test("basic gate stops money attacks but misses intent attacks", () => {
  const missed = scenarios
    .filter((s) => evaluateOrder({ level: "basic" }, s.mandate, s.unsafeOrder, s.context).decision === "allow")
    .map((s) => s.id)
    .sort();
  assert.deepEqual(missed, ["fake-approval-upsell", "lookalike-product", "shipping-redirect"]);
});

test("strict gate stops all but the look-alike product (documented gap)", () => {
  const missed = scenarios
    .filter((s) => evaluateOrder({ level: "strict" }, s.mandate, s.unsafeOrder, s.context).decision === "allow")
    .map((s) => s.id);
  assert.deepEqual(missed, ["lookalike-product"]);
});

test("gates never block a safe order", () => {
  for (const s of scenarios) {
    if (!s.safeOrder) continue;
    for (const level of ["basic", "strict"] as const) {
      assert.equal(evaluateOrder({ level }, s.mandate, s.safeOrder, s.context).decision, "allow", `${s.id}/${level}`);
    }
  }
});

test("approval threshold asks a human instead of blocking", () => {
  const s = scenarios[0];
  const safe = s.safeOrder!;
  assert.equal(evaluateOrder({ level: "strict", approvalAbove: 10 }, s.mandate, safe, s.context).decision, "needs_approval");
  assert.equal(evaluateOrder({ level: "strict", approvalAbove: 20 }, s.mandate, safe, s.context).decision, "allow");
});

test("block reasons are reported", () => {
  const s = scenarios.find((x) => x.id === "checkout-payee-swap")!;
  const r = evaluateOrder({ level: "basic" }, s.mandate, s.unsafeOrder, s.context);
  assert.equal(r.decision, "block");
  assert.deepEqual(r.reasons, ["WRONG_PAYEE"]);
});

test("PayPal adapter converts string amounts and quantities", () => {
  const order = fromPayPalOrder(
    {
      purchase_units: [
        {
          amount: { currency_code: "USD", value: "12.99" },
          payee: { merchant_id: "CABLECO-SANDBOX" },
          items: [{ name: "USB-C Cable 1m", quantity: "1", unit_amount: { currency_code: "USD", value: "12.99" } }],
          shipping: { address: { country_code: "US" } },
        },
      ],
    },
    { labelShipping: () => "home" }
  );
  assert.deepEqual(order, {
    currency: "USD",
    total: 12.99,
    payee: "CABLECO-SANDBOX",
    items: [{ name: "USB-C Cable 1m", unitPrice: 12.99, quantity: 1 }],
    shipTo: "home",
    recurring: false,
  });
});

test("PayPal adapter rejects ambiguous or broken orders", () => {
  assert.throws(() => fromPayPalOrder({}), /purchase_units/);
  assert.throws(() => fromPayPalOrder({ purchase_units: [{}, {}] }), /multiple/);
  assert.throws(() => fromPayPalOrder({ purchase_units: [{ amount: { currency_code: "USD", value: "abc" } }] }), /amount/);
});
