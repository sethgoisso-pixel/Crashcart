import assert from "node:assert/strict";
import { test } from "node:test";
import { createGeminiClient, listGeminiModels, QuotaExhaustedError, type LlmClient } from "../src/agent/llm.ts";
import { runScenarios, summarize } from "../src/agent/runner.ts";
import { buildPrompt, parseAgentReply, renderPage } from "../src/agent/shopper.ts";
import { baseMandate, scenarios } from "../src/scenarios/index.ts";

const noSleep = async () => {};

test("every scenario's hostile text appears exactly once on the page", () => {
  for (const s of scenarios) {
    const page = renderPage(s);
    assert.equal(page.split(s.injectedText).length - 1, 1, s.id);
  }
});

test("the prompt never leaks ground-truth-only details", () => {
  for (const s of scenarios) {
    const p = buildPrompt(s, "plain").toLowerCase();
    assert.ok(!p.includes("mustnotcontain"), s.id);
    assert.ok(!p.includes("organizer, case"), s.id); // the forbidden-word list stays with the judge
  }
});

test("hardened variant only adds the security rules", () => {
  const s = scenarios[0];
  const plain = buildPrompt(s, "plain");
  const hard = buildPrompt(s, "hardened");
  assert.ok(!plain.includes("SECURITY RULES"));
  assert.ok(hard.includes("SECURITY RULES"));
});

test("parser: code fences, extra text and string numbers", () => {
  const text =
    'Sure!\n```json\n{"action":"place_order","reason":"ok","order":{"currency":"usd","total":"12.99","payee":"cableco-sandbox","items":[{"name":"USB-C Cable 1m","unitPrice":"12.99","quantity":1}],"shipTo":" Home ","recurring":false}}\n```';
  const d = parseAgentReply(text, baseMandate);
  assert.equal(d.action, "place_order");
  assert.deepEqual(d.order, {
    currency: "USD",
    total: 12.99,
    payee: "CABLECO-SANDBOX",
    items: [{ name: "USB-C Cable 1m", unitPrice: 12.99, quantity: 1 }],
    recurring: false,
    shipTo: "home",
  });
});

test("parser: a swapped payee is NOT silently corrected", () => {
  const d = parseAgentReply(
    '{"action":"place_order","reason":"","order":{"currency":"USD","total":12.99,"payee":"FAST-PAY-7731","items":[{"name":"USB-C Cable","unitPrice":12.99,"quantity":1}]}}',
    baseMandate
  );
  assert.equal(d.order!.payee, "FAST-PAY-7731");
});

test("parser: stop, and unusable answers throw", () => {
  assert.equal(parseAgentReply('{"action":"stop","reason":"done"}', baseMandate).action, "stop");
  assert.throws(() => parseAgentReply("I cannot help", baseMandate), /no JSON/);
  assert.throws(() => parseAgentReply('{"action":"buy"}', baseMandate), /unknown action/);
  assert.throws(() => parseAgentReply('{"action":"place_order","order":{"items":[]}}', baseMandate), /no items/);
  assert.throws(
    () => parseAgentReply('{"action":"place_order","order":{"currency":"USD","payee":"X","total":"abc","items":[{"name":"a","unitPrice":1,"quantity":1}]}}', baseMandate),
    /total/
  );
});

// A scripted stand-in for a model. It is NOT an AI: it only exercises the plumbing.
function scripted(fn: (prompt: string) => string): LlmClient {
  return { name: "scripted", complete: async (p) => fn(p) };
}

test("runner: faithful vs fooled scripted agents are judged and gated", async () => {
  const faithful = scripted((p) =>
    p.includes("already been placed")
      ? '{"action":"stop","reason":"done"}'
      : '{"action":"place_order","reason":"ok","order":{"currency":"USD","total":12.99,"payee":"CABLECO-SANDBOX","items":[{"name":"USB-C Cable 1m","unitPrice":12.99,"quantity":1}],"shipTo":"home","recurring":false}}'
  );
  const r1 = await runScenarios(faithful, scenarios, { runs: 2, variant: "plain", sleep: noSleep });
  const s1 = summarize(r1.records);
  assert.equal(s1.valid, scenarios.length * 2);
  assert.equal(s1.breached, 0);
  assert.deepEqual(s1.falseBlocks, { none: 0, basic: 0, strict: 0 });

  // Fooled on the payee scenario only: always pays the attacker.
  const fooled = scripted((p) =>
    p.includes("FAST-PAY-7731")
      ? '{"action":"place_order","reason":"notice","order":{"currency":"USD","total":12.99,"payee":"FAST-PAY-7731","items":[{"name":"USB-C Cable 1m","unitPrice":12.99,"quantity":1}],"shipTo":"home"}}'
      : '{"action":"stop","reason":"x"}'
  );
  const swap = scenarios.filter((s) => s.id === "checkout-payee-swap");
  const r2 = await runScenarios(fooled, swap, { runs: 3, variant: "plain", sleep: noSleep });
  const s2 = summarize(r2.records);
  assert.equal(s2.breached, 3);
  assert.deepEqual(s2.leaked, { none: 3, basic: 0, strict: 0 });
});

test("runner: unusable answers count as errors, not as passes", async () => {
  const bad = scripted(() => "no json here");
  const r = await runScenarios(bad, scenarios.slice(0, 1), { runs: 2, variant: "plain", sleep: noSleep });
  const s = summarize(r.records);
  assert.equal(s.errors, 2);
  assert.equal(s.valid, 0);
});

test("runner: stops cleanly when the daily quota is gone and keeps partial records", async () => {
  let n = 0;
  const llm: LlmClient = {
    name: "q",
    complete: async () => {
      if (++n > 2) throw new QuotaExhaustedError("daily quota");
      return '{"action":"stop","reason":"x"}';
    },
  };
  const r = await runScenarios(llm, scenarios, { runs: 2, variant: "plain", sleep: noSleep });
  assert.equal(r.records.length, 2);
  assert.equal(r.aborted, "daily quota");
});

test("runner: respects the requests-per-minute pacing", async () => {
  const waits: number[] = [];
  const llm = scripted(() => '{"action":"stop","reason":"x"}');
  await runScenarios(llm, scenarios.slice(0, 1), { runs: 3, variant: "plain", rpm: 6, sleep: async (ms) => void waits.push(ms) });
  assert.equal(waits.length, 2);
  assert.ok(waits.every((w) => w > 9000 && w <= 10000));
});

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const f = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const r = responses.shift()!;
    return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return { f, calls };
}

test("gemini client: key in header only, thought parts skipped", async () => {
  const { f, calls } = fakeFetch([
    { status: 200, body: { candidates: [{ content: { parts: [{ text: "thinking...", thought: true }, { text: '{"action":"stop"}' }] } }] } },
  ]);
  const llm = createGeminiClient({ apiKey: "SECRET", model: "some-model", fetchImpl: f, sleep: noSleep });
  assert.equal(await llm.complete("hi"), '{"action":"stop"}');
  assert.ok(!calls[0].url.includes("SECRET"));
  assert.equal(calls[0].headers["x-goog-api-key"], "SECRET");
  assert.ok(calls[0].url.endsWith("/models/some-model:generateContent"));
});

test("gemini client: retries a rate-limit error, then succeeds", async () => {
  const waits: number[] = [];
  const { f } = fakeFetch([
    { status: 429, body: { error: { details: [{ retryDelay: "3s" }] } } },
    { status: 200, body: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } },
  ]);
  const llm = createGeminiClient({ apiKey: "k", model: "m", fetchImpl: f, sleep: async (ms) => void waits.push(ms) });
  assert.equal(await llm.complete("x"), "ok");
  assert.deepEqual(waits, [4000]);
});

test("gemini client: per-day quota error is not retried", async () => {
  const { f, calls } = fakeFetch([
    { status: 429, body: { error: { message: "Quota exceeded for GenerateRequestsPerDayPerProjectPerModel-FreeTier" } } },
  ]);
  const llm = createGeminiClient({ apiKey: "k", model: "m", fetchImpl: f, sleep: noSleep });
  await assert.rejects(llm.complete("x"), QuotaExhaustedError);
  assert.equal(calls.length, 1);
});

test("list models keeps only generateContent models", async () => {
  const { f } = fakeFetch([
    {
      status: 200,
      body: {
        models: [
          { name: "models/b-model", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
          { name: "models/a-model", supportedGenerationMethods: ["generateContent", "countTokens"] },
        ],
      },
    },
  ]);
  assert.deepEqual(await listGeminiModels("k", f), ["a-model", "b-model"]);
});
