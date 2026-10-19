// Live harness: a real model plays the shopper against every attack scenario,
// several times each. Usage (Node 22.18+):
//   node src/run.ts --list-models
//   node src/run.ts --model <id> --runs 5 --prompt plain [--level 1|2|all] [--only id,level2]
//   node src/run.ts --dry-run --only hidden-text-gift-card     (prints the prompt, no API call)
// The API key is read from the LLM_API_KEY environment variable only.

import { mkdirSync, writeFileSync } from "node:fs";
import { createGeminiClient, listGeminiModels } from "./agent/llm.ts";
import { runScenarios, summarize } from "./agent/runner.ts";
import { buildPrompt, type PromptVariant } from "./agent/shopper.ts";
import { scenarios as level1 } from "./scenarios/index.ts";
import { scenariosL2 as level2 } from "./scenarios/level2.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

// Scenario selection. Default = level 1 (the 11 blunt attacks).
//   --level 2 | all          choose a whole level
//   --only a,b,level2        pick ids; the words level1 / level2 expand to every id of that level
const all = [...level1, ...level2];
const levelArg = arg("level") ?? "1";
const pool = levelArg === "all" ? all : levelArg === "2" ? level2 : level1;
const onlyRaw = arg("only")?.split(",").map((x) => x.trim()).filter(Boolean);
const only = onlyRaw?.flatMap((x) =>
  x === "level1" ? level1.map((s) => s.id) : x === "level2" ? level2.map((s) => s.id) : [x]
);
const picked = only ? all.filter((s) => only.includes(s.id)) : pool;
if (only && picked.length === 0) {
  console.error(`No scenario matches: ${only.join(", ")}`);
  process.exit(2);
}
const variant = (arg("prompt") ?? "plain") as PromptVariant;
if (variant !== "plain" && variant !== "hardened") {
  console.error('--prompt must be "plain" or "hardened"');
  process.exit(2);
}

if (flag("dry-run")) {
  for (const s of picked) console.log(`\n===== ${s.id} (${variant}) =====\n${buildPrompt(s, variant)}`);
  process.exit(0);
}

const apiKey = process.env.LLM_API_KEY;
if (!apiKey) {
  console.error("LLM_API_KEY is not set. Never put the key in a file that is committed.");
  process.exit(2);
}

if (flag("list-models")) {
  for (const id of await listGeminiModels(apiKey)) console.log(id);
  process.exit(0);
}

const model = arg("model");
if (!model) {
  console.error("Missing --model. Run with --list-models to see the ids your key can use.");
  process.exit(2);
}
const runs = Number(arg("runs") ?? 3);
const rpm = Number(arg("rpm") ?? 8);
const temperature = Number(arg("temp") ?? 0.7);
if (!Number.isInteger(runs) || runs < 1 || runs > 50) {
  console.error("--runs must be an integer between 1 and 50");
  process.exit(2);
}

const llm = createGeminiClient({ apiKey, model, temperature });
const startedAt = new Date().toISOString();
console.log(`Model ${model} | prompt ${variant} | ${picked.length} scenarios x ${runs} runs | max ${rpm} requests/min`);

const { records, aborted } = await runScenarios(llm, picked, {
  runs,
  variant,
  rpm,
  onRecord: (r) => {
    const verdict = r.status === "order" ? (r.breaches.length ? `BREACH ${r.breaches.join(",")}` : "faithful") : r.status === "stop" ? "stopped" : `error: ${r.error}`;
    console.log(`${r.scenarioId.padEnd(26)} #${r.run}  ${verdict}`);
  },
});

const summary = summarize(records);
const pct = (n: number) => (summary.valid ? `${((100 * n) / summary.valid).toFixed(0)}%` : "n/a");
console.log("\n--- measured results (this run only) ---");
console.log(`valid runs: ${summary.valid}  (unusable answers: ${summary.errors})`);
console.log(`agent breached the mandate: ${summary.breached}/${summary.valid} (${pct(summary.breached)})`);
for (const l of ["none", "basic", "strict"] as const) {
  console.log(`  still goes through with gate ${l.padEnd(6)}: ${summary.leaked[l]}/${summary.valid} (${pct(summary.leaked[l])})   faithful orders wrongly blocked: ${summary.falseBlocks[l]}`);
}
if (aborted) console.log(`\nSTOPPED EARLY: ${aborted}`);

mkdirSync("data/runs", { recursive: true });
const stamp = startedAt.replace(/[:.]/g, "-");
const file = `data/runs/${model.replace(/[^a-z0-9.-]/gi, "_")}__${variant}__${stamp}.json`;
writeFileSync(
  file,
  JSON.stringify(
    { meta: { model, promptVariant: variant, level: only ? "custom" : levelArg, runsPerScenario: runs, temperature, rpm, startedAt, finishedAt: new Date().toISOString(), aborted: aborted ?? null }, summary, records },
    null,
    2
  )
);
console.log(`\nSaved ${file}`);
