import { evaluateOrder } from "../core/gate.ts";
import { judgeOrder } from "../core/judge.ts";
import type { Breach, GateResult, OrderSummary, PolicyLevel, Scenario } from "../core/types.ts";
import type { PayPalResult } from "../paypal/sandbox.ts";
import { QuotaExhaustedError, type LlmClient } from "./llm.ts";
import { buildPrompt, parseAgentReply, type PromptVariant } from "./shopper.ts";

export const LEVELS: PolicyLevel[] = ["none", "basic", "strict"];

export interface RunRecord {
  scenarioId: string;
  run: number;
  status: "order" | "stop" | "error";
  reason?: string;
  order?: OrderSummary;
  /** Ground-truth breaches in the order the agent proposed (empty = faithful). */
  breaches: Breach[];
  gates?: Record<PolicyLevel, GateResult>;
  /** Sandbox order created in PayPal because the chosen gate allowed this order. */
  paypal?: Partial<PayPalResult> & { error?: string };
  error?: string;
  /** First 1500 characters of the model's answer, kept for audit. */
  raw?: string;
  ms: number;
}

/** When set, every order the chosen gate level allows is also created in the PayPal sandbox. */
export interface PayPalHook {
  gate: PolicyLevel;
  create(order: OrderSummary, referenceId: string): Promise<PayPalResult>;
}

export interface RunOptions {
  runs: number;
  variant: PromptVariant;
  /** Requests per minute to stay under the provider's limit (default 8). */
  rpm?: number;
  sleep?: (ms: number) => Promise<void>;
  onRecord?: (r: RunRecord) => void;
  paypal?: PayPalHook;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runScenarios(
  llm: LlmClient,
  scenarios: Scenario[],
  opts: RunOptions
): Promise<{ records: RunRecord[]; aborted?: string }> {
  const sleep = opts.sleep ?? realSleep;
  const gap = opts.rpm && opts.rpm > 0 ? Math.ceil(60000 / opts.rpm) : 0;
  const records: RunRecord[] = [];
  let lastCall = 0;

  for (const s of scenarios) {
    for (let run = 1; run <= opts.runs; run++) {
      const wait = lastCall + gap - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();

      const t0 = Date.now();
      const rec: RunRecord = { scenarioId: s.id, run, status: "error", breaches: [], ms: 0 };
      try {
        const text = await llm.complete(buildPrompt(s, opts.variant));
        rec.raw = text.slice(0, 1500);
        const d = parseAgentReply(text, s.mandate);
        rec.reason = d.reason;
        if (d.action === "stop") {
          rec.status = "stop";
        } else {
          rec.status = "order";
          rec.order = d.order!;
          rec.breaches = judgeOrder(s.mandate, d.order!, s.context);
          rec.gates = Object.fromEntries(
            LEVELS.map((level) => [level, evaluateOrder({ level }, s.mandate, d.order!, s.context)])
          ) as Record<PolicyLevel, GateResult>;
          if (opts.paypal && rec.gates[opts.paypal.gate].decision === "allow") {
            try {
              const { id, status, approveUrl, readback, matches } = await opts.paypal.create(d.order!, `${s.id}#${run}`);
              rec.paypal = { id, status, approveUrl, readback, matches };
            } catch (e) {
              rec.paypal = { error: e instanceof Error ? e.message : String(e) };
            }
          }
        }
      } catch (e) {
        if (e instanceof QuotaExhaustedError) {
          return { records, aborted: e.message };
        }
        rec.error = e instanceof Error ? e.message : String(e);
      }
      rec.ms = Date.now() - t0;
      records.push(rec);
      opts.onRecord?.(rec);
    }
  }
  return { records };
}

export interface ScenarioSummary {
  scenarioId: string;
  runs: number;
  errors: number;
  stops: number;
  orders: number;
  /** Orders with at least one ground-truth breach. */
  breached: number;
  /** Breached orders that still go through, per protection level. */
  leaked: Record<PolicyLevel, number>;
  /** Faithful orders wrongly stopped, per protection level. */
  falseBlocks: Record<PolicyLevel, number>;
}

export interface Summary {
  valid: number;
  errors: number;
  breached: number;
  leaked: Record<PolicyLevel, number>;
  falseBlocks: Record<PolicyLevel, number>;
  perScenario: ScenarioSummary[];
}

const zero = (): Record<PolicyLevel, number> => ({ none: 0, basic: 0, strict: 0 });

export function summarize(records: RunRecord[]): Summary {
  const by = new Map<string, ScenarioSummary>();
  for (const r of records) {
    let s = by.get(r.scenarioId);
    if (!s) {
      s = { scenarioId: r.scenarioId, runs: 0, errors: 0, stops: 0, orders: 0, breached: 0, leaked: zero(), falseBlocks: zero() };
      by.set(r.scenarioId, s);
    }
    s.runs++;
    if (r.status === "error") s.errors++;
    else if (r.status === "stop") s.stops++;
    else {
      s.orders++;
      const bad = r.breaches.length > 0;
      if (bad) s.breached++;
      for (const level of LEVELS) {
        const allowed = r.gates![level].decision === "allow";
        if (bad && allowed) s.leaked[level]++;
        if (!bad && !allowed) s.falseBlocks[level]++;
      }
    }
  }
  const perScenario = [...by.values()];
  const total: Summary = { valid: 0, errors: 0, breached: 0, leaked: zero(), falseBlocks: zero(), perScenario };
  for (const s of perScenario) {
    total.valid += s.runs - s.errors;
    total.errors += s.errors;
    total.breached += s.breached;
    for (const l of LEVELS) {
      total.leaked[l] += s.leaked[l];
      total.falseBlocks[l] += s.falseBlocks[l];
    }
  }
  return total;
}
