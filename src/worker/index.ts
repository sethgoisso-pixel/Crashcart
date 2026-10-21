// Live endpoint for the demo site. It runs ONE attack against the real model and the real
// PayPal sandbox, using the same code as the benchmark (src/agent, src/core, src/paypal).
// Runs on Cloudflare Workers (free plan) or any runtime with fetch. Secrets come from `env`.
//
//   POST /run   { "scenarioId": "...", "prompt": "plain|hardened", "gate": "none|basic|strict", "model": "..." }
//   GET  /health
//
// The caller can only choose among the built-in fictional attacks. There is no free-text input,
// so no personal data can reach the model provider through this endpoint.

import { evaluateOrder } from "../core/gate.ts";
import { judgeOrder } from "../core/judge.ts";
import type { GateResult, PolicyLevel } from "../core/types.ts";
import { QuotaExhaustedError, createGeminiClient } from "../agent/llm.ts";
import { buildPrompt, parseAgentReply } from "../agent/shopper.ts";
import { createSandboxOrder, getAccessToken } from "../paypal/sandbox.ts";
import { scenarios } from "../scenarios/index.ts";
import { scenariosL2 } from "../scenarios/level2.ts";

export interface Env {
  LLM_API_KEY?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  /** Origin allowed to call this endpoint from a browser. Default: the project's GitHub Pages site. */
  ALLOWED_ORIGIN?: string;
}

export const MODELS = ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"];
const LEVELS: PolicyLevel[] = ["none", "basic", "strict"];
const DEFAULT_ORIGIN = "https://sethgoisso-pixel.github.io";
const all = [...scenarios, ...scenariosL2];

// Best-effort abuse limits kept in memory (reset when the worker restarts). Google's own free
// quota is the hard cap; when it runs out the site falls back to the recorded runs.
const hits = new Map<string, number[]>();
const PER_IP = 10;
const WINDOW_MS = 10 * 60 * 1000;
function tooMany(ip: string, now: number): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= PER_IP) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return false;
}

function cors(origin: string | null, allowed: string): Record<string, string> {
  const h: Record<string, string> = { vary: "Origin" };
  if (origin && (origin === allowed || /^http:\/\/localhost(:\d+)?$/.test(origin))) {
    h["access-control-allow-origin"] = origin;
    h["access-control-allow-methods"] = "GET, POST, OPTIONS";
    h["access-control-allow-headers"] = "content-type, authorization, apikey, x-client-info";
    h["access-control-max-age"] = "86400";
  }
  return h;
}

function reply(status: number, body: unknown, extra: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
}

export async function handle(request: Request, env: Env, now: number = Date.now()): Promise<Response> {
  const allowed = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
  const extra = cors(request.headers.get("origin"), allowed);
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: extra });

  // Routes match on the last path segment so the same code works behind /run (Cloudflare)
  // and behind /functions/v1/<name>/... (Supabase / Lovable Cloud edge functions).
  const last = url.pathname.replace(/\/+$/, "").split("/").pop();
  if (request.method === "GET" && last === "health") {
    return reply(200, { ok: true, models: MODELS, scenarios: all.length, configured: { llm: !!env.LLM_API_KEY, paypal: !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) } }, extra);
  }
  if (request.method !== "POST") return reply(404, { ok: false, error: "not_found" }, extra);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return reply(400, { ok: false, error: "bad_json" }, extra);
  }
  const scenario = all.find((s) => s.id === body?.scenarioId);
  const variant = body?.prompt === "hardened" ? "hardened" : body?.prompt === "plain" ? "plain" : null;
  const gate = LEVELS.includes(body?.gate) ? (body.gate as PolicyLevel) : null;
  const model = body?.model === undefined ? MODELS[0] : MODELS.includes(body.model) ? body.model : null;
  if (!scenario || !variant || !gate || !model) return reply(400, { ok: false, error: "bad_request", message: "Choose a built-in attack, a prompt (plain or hardened), a seatbelt (none, basic, strict) and a listed model." }, extra);
  if (!env.LLM_API_KEY) return reply(503, { ok: false, error: "not_configured", message: "The live endpoint has no model key." }, extra);

  const ip = request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (tooMany(ip, now)) return reply(429, { ok: false, error: "rate_limited", message: "Too many live runs from this connection. Wait a few minutes, or use the recorded runs." }, extra);

  const t0 = Date.now();
  let usedModel = model;
  const rec: Record<string, unknown> = { scenarioId: scenario.id, status: "error", breaches: [] };
  try {
    // Try the chosen model first; if Google is overloaded or that model's daily quota is used up,
    // fall back to the other listed model (each has its own quota). The answer says which one ran.
    const order = [model, ...MODELS.filter((m) => m !== model)];
    let text: string | undefined;
    let lastError: unknown;
    let quotaOnly = true;
    for (let i = 0; i < order.length && text === undefined; i++) {
      try {
        const llm = createGeminiClient({ apiKey: env.LLM_API_KEY, model: order[i], temperature: 0.7, maxRetries: i === order.length - 1 ? 1 : 0 });
        text = await llm.complete(buildPrompt(scenario, variant));
        usedModel = order[i];
      } catch (e) {
        lastError = e;
        if (!(e instanceof QuotaExhaustedError)) quotaOnly = false;
      }
    }
    if (text === undefined) {
      if (quotaOnly) throw lastError;
      throw lastError instanceof Error ? lastError : new Error("model error");
    }
    const d = parseAgentReply(text, scenario.mandate);
    rec.reason = d.reason;
    if (d.action === "stop") {
      rec.status = "stop";
    } else {
      rec.status = "order";
      rec.order = d.order;
      rec.breaches = judgeOrder(scenario.mandate, d.order!, scenario.context);
      const gates = Object.fromEntries(LEVELS.map((level) => [level, evaluateOrder({ level }, scenario.mandate, d.order!, scenario.context)])) as Record<PolicyLevel, GateResult>;
      rec.gates = gates;
      if (gates[gate].decision === "allow") {
        if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
          rec.paypal = { error: "PayPal sandbox is not configured on this endpoint." };
        } else {
          try {
            const token = await getAccessToken({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET });
            const { id, status, approveUrl, readback, matches } = await createSandboxOrder(token, d.order!, `live-${scenario.id}`);
            rec.paypal = { id, status, approveUrl, readback, matches };
          } catch (e) {
            rec.paypal = { error: e instanceof Error ? e.message.slice(0, 200) : "PayPal error" };
          }
        }
      }
    }
  } catch (e) {
    if (e instanceof QuotaExhaustedError) return reply(503, { ok: false, error: "quota", message: "The free model quota for today is used up. Use the recorded runs, or try again tomorrow." }, extra);
    rec.error = e instanceof Error ? e.message.slice(0, 200) : "error";
  }
  rec.ms = Date.now() - t0;
  return reply(200, { ok: true, model: usedModel, prompt: variant, gate, record: rec }, extra);
}

export const worker = { fetch: (request: Request, env: Env) => handle(request, env) };
