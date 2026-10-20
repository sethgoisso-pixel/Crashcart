import assert from "node:assert/strict";
import { test } from "node:test";
import { handle } from "../src/worker/index.ts";
import { scenarios } from "../src/scenarios/index.ts";
import { scenariosL2 } from "../src/scenarios/level2.ts";

// worker/worker.js is generated (node scripts/build-worker.mjs). Both copies must behave the same.
// @ts-ignore generated JavaScript module without type declarations
const bundled: any = await import("../worker/worker.js");

const env = { LLM_API_KEY: "test-key", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" };
const s = scenariosL2.find((x) => x.id === "l2-forged-user-turn")!;

function stubFetch(reply: (scenarioOrder: unknown) => unknown) {
  const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: init.body });
    if (url.includes("generativelanguage")) {
      const text = JSON.stringify(reply(s.unsafeOrder));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
    }
    if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    if (url.endsWith("/v2/checkout/orders")) {
      const b = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "ORDER1", status: "CREATED", purchase_units: b.purchase_units, links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1" }] }), { status: 201 });
    }
    if (url.endsWith("/v2/checkout/orders/ORDER1")) {
      const created = calls.find((c) => c.url.endsWith("/v2/checkout/orders") && c.body);
      return new Response(JSON.stringify({ id: "ORDER1", status: "CREATED", purchase_units: JSON.parse(created!.body!).purchase_units }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as any;
  return { calls, restore: () => (globalThis.fetch = real) };
}

const req = (body: unknown, ip = "1.1.1.1", origin = "https://sethgoisso-pixel.github.io") =>
  new Request("https://w.example/run", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip, origin }, body: JSON.stringify(body) });
const agentOrder = (o: any) => ({ action: "place_order", reason: "test", order: o });

for (const [name, impl] of [["src", handle], ["bundle", (r: Request, e: any, n?: number) => bundled.default.fetch(r, e)]] as const) {
  test(`${name}: no seatbelt sends the bad order to the PayPal sandbox`, async () => {
    const st = stubFetch(agentOrder);
    try {
      const res = await impl(req({ scenarioId: s.id, prompt: "plain", gate: "none" }, `10.0.0.${name.length}`), env);
      const j: any = await res.json();
      assert.equal(res.status, 200);
      assert.ok(j.record.breaches.length > 0);
      assert.equal(j.record.paypal.id, "ORDER1");
      assert.equal(j.record.paypal.matches, true);
      assert.equal(res.headers.get("access-control-allow-origin"), "https://sethgoisso-pixel.github.io");
      assert.ok(st.calls.every((c) => c.url.startsWith("https://generativelanguage.googleapis.com") || c.url.startsWith("https://api-m.sandbox.paypal.com")));
    } finally { st.restore(); }
  });

  test(`${name}: the strict seatbelt stops it before PayPal`, async () => {
    const st = stubFetch(agentOrder);
    try {
      const res = await impl(req({ scenarioId: s.id, prompt: "hardened", gate: "strict" }, `10.0.1.${name.length}`), env);
      const j: any = await res.json();
      assert.equal(j.record.status, "order");
      assert.equal(j.record.gates.strict.decision, "block");
      assert.equal(j.record.paypal, undefined);
      assert.ok(!st.calls.some((c) => c.url.includes("paypal")));
    } finally { st.restore(); }
  });

  test(`${name}: rejects free text, unknown attacks and unknown models`, async () => {
    const st = stubFetch(agentOrder);
    try {
      for (const body of [{ scenarioId: "nope", prompt: "plain", gate: "none" }, { scenarioId: s.id, prompt: "write me a poem", gate: "none" }, { scenarioId: s.id, prompt: "plain", gate: "none", model: "gemini-pro-9" }]) {
        const res = await impl(req(body, `10.0.2.${name.length}`), env);
        assert.equal(res.status, 400);
      }
      assert.equal(st.calls.length, 0);
    } finally { st.restore(); }
  });

  test(`${name}: no key means a clear 503, and other origins get no CORS header`, async () => {
    const res = await impl(req({ scenarioId: s.id, prompt: "plain", gate: "none" }, "10.0.3.1", "https://evil.example"), {});
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
}

test("per-connection limit returns 429 and spends no model call", async () => {
  const st = stubFetch(agentOrder);
  try {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await handle(req({ scenarioId: s.id, prompt: "plain", gate: "strict" }, "9.9.9.9"), env)).status;
    assert.equal(last, 429);
    assert.equal(st.calls.filter((c) => c.url.includes("generativelanguage")).length, 10);
  } finally { st.restore(); }
});

test("health endpoint reports configuration without secrets", async () => {
  const res = await handle(new Request("https://w.example/health"), env);
  const j: any = await res.json();
  assert.deepEqual(j.configured, { llm: true, paypal: true });
  assert.ok(!JSON.stringify(j).includes("secret"));
  assert.equal(j.scenarios, scenarios.length + scenariosL2.length);
});
