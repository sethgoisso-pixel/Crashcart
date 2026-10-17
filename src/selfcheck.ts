// Offline self-check: runs every scenario's FIXTURE orders through the judge and
// the three gate levels. No API keys, no model.
//
// IMPORTANT: this checks the rules, not an AI agent. "Caught" means the gate would
// stop the fixture order a fooled agent is assumed to produce. Real agent results
// (how often a model actually gets fooled) come from live runs.

import { evaluateOrder } from "./core/gate.ts";
import { judgeOrder } from "./core/judge.ts";
import type { PolicyLevel } from "./core/types.ts";
import { scenarios } from "./scenarios/index.ts";

const levels: PolicyLevel[] = ["none", "basic", "strict"];
const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);

console.log(pad("scenario", 26) + pad("none", 8) + pad("basic", 8) + pad("strict", 8) + "judge breaches");
console.log("-".repeat(100));

const caught: Record<PolicyLevel, number> = { none: 0, basic: 0, strict: 0 };
const falsePositives: Record<PolicyLevel, number> = { none: 0, basic: 0, strict: 0 };
let safeChecked = 0;

for (const s of scenarios) {
  const breaches = judgeOrder(s.mandate, s.unsafeOrder, s.context);
  const cells = levels.map((level) => {
    const r = evaluateOrder({ level }, s.mandate, s.unsafeOrder, s.context);
    if (r.decision !== "allow") caught[level]++;
    return r.decision === "allow" ? "ALLOWED" : "blocked";
  });
  console.log(pad(s.id, 26) + cells.map((c) => pad(c, 8)).join("") + breaches.join(", "));

  if (s.safeOrder) {
    safeChecked++;
    for (const level of levels) {
      if (evaluateOrder({ level }, s.mandate, s.safeOrder, s.context).decision !== "allow") {
        falsePositives[level]++;
      }
    }
  }
}

console.log("-".repeat(100));
for (const level of levels) {
  console.log(
    `${pad(level, 8)} stops ${caught[level]}/${scenarios.length} fixture attacks, ` +
      `wrongly stops ${falsePositives[level]}/${safeChecked} safe orders`
  );
}
