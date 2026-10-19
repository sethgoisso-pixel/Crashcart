import assert from "node:assert/strict";
import { test } from "node:test";
import { runScenarios } from "../src/agent/runner.ts";
import type { LlmClient } from "../src/agent/llm.ts";
import { createSandboxOrder, getAccessToken, SANDBOX_BASE, toPayPalOrderRequest } from "../src/paypal/sandbox.ts";
import { scenarios } from "../src/scenarios/index.ts";
import type { OrderSummary } from "../src/core/types.ts";

const cable: OrderSummary = {
  currency: "USD",
  total: 12.99,
  payee: "CABLECO-SANDBOX",
  items: [{ name: "USB-C Cable 1m", unitPrice: 12.99, quantity: 1 }],
  shipTo: "home",
  recurring: false,
};

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function fakeFetch(handler: (c: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const f = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const c = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(c);
    const r = handler(c);
    return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return { f, calls };
}

test("order request: exact strings, item_total, no payee, never live", () => {
  const body: any = toPayPalOrderRequest(cable, "scn#1");
  assert.equal(body.intent, "CAPTURE");
  const u = body.purchase_units[0];
  assert.equal(u.amount.value, "12.99");
  assert.deepEqual(u.amount.breakdown, { item_total: { currency_code: "USD", value: "12.99" } });
  assert.deepEqual(u.items[0], { name: "USB-C Cable 1m", quantity: "1", unit_amount: { currency_code: "USD", value: "12.99" } });
  assert.equal(u.payee, undefined);
  assert.ok(SANDBOX_BASE.includes("sandbox"));
});

test("order request: a hidden fee becomes a handling line, a discount stays a discount", () => {
  const fee: any = toPayPalOrderRequest({ ...cable, total: 62.99 }, "x");
  assert.deepEqual(fee.purchase_units[0].amount.breakdown.handling, { currency_code: "USD", value: "50.00" });
  const sub: any = toPayPalOrderRequest({ ...cable, total: 10 }, "x");
  assert.deepEqual(sub.purchase_units[0].amount.breakdown.discount, { currency_code: "USD", value: "2.99" });
});

test("order request: three units and long names", () => {
  const body: any = toPayPalOrderRequest(
    { ...cable, total: 38.97, items: [{ name: "A".repeat(300), unitPrice: 12.99, quantity: 3 }] },
    "x"
  );
  const u = body.purchase_units[0];
  assert.equal(u.items[0].quantity, "3");
  assert.equal(u.items[0].name.length, 127);
  assert.equal(u.amount.breakdown.item_total.value, "38.97");
});

test("token request uses basic auth against the sandbox only", async () => {
  const { f, calls } = fakeFetch(() => ({ status: 200, body: { access_token: "TOKEN" } }));
  assert.equal(await getAccessToken({ clientId: "id", clientSecret: "secret" }, f), "TOKEN");
  assert.equal(calls[0].url, `${SANDBOX_BASE}/v1/oauth2/token`);
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from("id:secret").toString("base64")}`);
  assert.equal(calls[0].body, "grant_type=client_credentials");
});

test("token failure does not leak credentials", async () => {
  const { f } = fakeFetch(() => ({ status: 401, body: { error: "invalid_client" } }));
  await assert.rejects(getAccessToken({ clientId: "id", clientSecret: "SECRET123" }, f), (e: Error) => {
    assert.ok(!e.message.includes("SECRET123"));
    return /401/.test(e.message);
  });
});

function paypalServer(storedTotal = "12.99") {
  return fakeFetch((c) => {
    if (c.method === "POST") {
      return { status: 201, body: { id: "ORDER1", status: "CREATED", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1" }] } };
    }
    return {
      status: 200,
      body: {
        id: "ORDER1",
        status: "CREATED",
        purchase_units: [
          {
            amount: { currency_code: "USD", value: storedTotal },
            payee: { merchant_id: "REALMERCHANT", email_address: "m@example.com" },
            items: [{ name: "USB-C Cable 1m", quantity: "1", unit_amount: { currency_code: "USD", value: "12.99" } }],
          },
        ],
      },
    };
  });
}

test("create + read back: matches, approve link found", async () => {
  const { f, calls } = paypalServer();
  const r = await createSandboxOrder("TOKEN", cable, "scn#1", f);
  assert.equal(r.id, "ORDER1");
  assert.equal(r.status, "CREATED");
  assert.equal(r.matches, true);
  assert.equal(r.approveUrl, "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1");
  assert.equal(calls[0].headers.authorization, "Bearer TOKEN");
  assert.ok(calls[1].url.endsWith("/v2/checkout/orders/ORDER1"));
});

test("create + read back: a different stored total is reported, not hidden", async () => {
  const { f } = paypalServer("99.00");
  const r = await createSandboxOrder("TOKEN", cable, "scn#1", f);
  assert.equal(r.matches, false);
});

test("create order failure is a readable error", async () => {
  const { f } = fakeFetch(() => ({ status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AMOUNT_MISMATCH" }] } }));
  await assert.rejects(createSandboxOrder("T", cable, "x", f), /422.*AMOUNT_MISMATCH/s);
});

test("runner: only orders the chosen gate allows reach PayPal", async () => {
  // A scripted model that is always fooled on the payee-swap scenario.
  const llm: LlmClient = {
    name: "scripted",
    complete: async () =>
      '{"action":"place_order","reason":"x","order":{"currency":"USD","total":12.99,"payee":"FAST-PAY-7731","items":[{"name":"USB-C Cable 1m","unitPrice":12.99,"quantity":1}],"shipTo":"home"}}',
  };
  const swap = scenarios.filter((s) => s.id === "checkout-payee-swap");
  const created: string[] = [];
  const hook = (gate: "none" | "basic" | "strict") => ({
    gate,
    create: async (_o: OrderSummary, ref: string) => {
      created.push(ref);
      return { id: "O", status: "CREATED", matches: true };
    },
  });
  await runScenarios(llm, swap, { runs: 2, variant: "plain", sleep: async () => {}, paypal: hook("strict") });
  assert.equal(created.length, 0);
  const r = await runScenarios(llm, swap, { runs: 2, variant: "plain", sleep: async () => {}, paypal: hook("none") });
  assert.equal(created.length, 2);
  assert.equal(r.records[0].paypal?.id, "O");
});

test("runner: a PayPal failure is recorded and does not stop the run", async () => {
  const llm: LlmClient = {
    name: "s",
    complete: async () =>
      '{"action":"place_order","reason":"x","order":{"currency":"USD","total":12.99,"payee":"CABLECO-SANDBOX","items":[{"name":"USB-C Cable 1m","unitPrice":12.99,"quantity":1}],"shipTo":"home"}}',
  };
  const r = await runScenarios(llm, scenarios.slice(0, 2), {
    runs: 1,
    variant: "plain",
    sleep: async () => {},
    paypal: { gate: "strict", create: async () => { throw new Error("boom"); } },
  });
  assert.equal(r.records.length, 2);
  assert.equal(r.records[0].paypal?.error, "boom");
});
