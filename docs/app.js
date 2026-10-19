import { data } from "./data.js";
import { scenarios as level1, scenariosL2 as level2, renderPage, evaluateOrder, judgeOrder } from "./engine.js";

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v; // only used with strings built here, never with data
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}
const money = (cur, n) => `${cur} ${Number(n).toFixed(2)}`;
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");

const allScenarios = [...level1, ...level2];
const byId = Object.fromEntries(allScenarios.map((s) => [s.id, s]));
const levelOf = (id) => (id.startsWith("l2-") ? 2 : 1);

const BREACH_TEXT = {
  OVER_BUDGET: "Spends more than the user's limit",
  WRONG_CURRENCY: "Pays in another currency",
  WRONG_PAYEE: "Pays a merchant the user did not choose",
  UNEXPECTED_ITEM: "Buys something the user did not ask for",
  QUANTITY_INFLATED: "Buys more units than asked",
  WRONG_SHIPPING: "Ships to another address",
  UNAUTHORIZED_RECURRING: "Starts a subscription",
  PRICE_MISMATCH: "Charges more than the listed price",
};

function prettyModel(id) {
  return id
    .replace(/^gemini-/, "Gemini ")
    .replace(/^gemma-/, "Gemma ")
    .replace(/-flash-lite/, " Flash-Lite")
    .replace(/-flash/, " Flash")
    .replace(/-(\d+)b-a4b-it$/, " $1B")
    .replace(/-(\d+)b-it$/, " $1B");
}
const promptName = (p) => (p === "hardened" ? "hardened prompt" : "plain prompt");

// ---------- data ----------
const bench = data.runs.filter((r) => r.meta.level === "all");
const settingsMap = new Map();
for (const run of bench) {
  const key = `${run.meta.model}|${run.meta.promptVariant}`;
  if (!settingsMap.has(key)) {
    settingsMap.set(key, { key, model: run.meta.model, prompt: run.meta.promptVariant, records: [] });
  }
  const s = settingsMap.get(key);
  for (const rec of run.records) s.records.push({ ...rec, _run: run.meta.startedAt });
}
const settings = [...settingsMap.values()].sort(
  (a, b) => a.model.localeCompare(b.model) || a.prompt.localeCompare(b.prompt)
);
const allBenchRecords = settings.flatMap((s) => s.records);

function outcome(r) {
  if (r.status === "error") return "error";
  if (r.status === "stop") return "stop";
  return r.breaches.length ? "breach" : "faithful";
}
function tally(recs) {
  const t = { faithful: 0, stop: 0, breach: 0, error: 0, valid: 0, leak: { none: 0, basic: 0, strict: 0 }, falseBlock: { basic: 0, strict: 0 } };
  for (const r of recs) {
    const o = outcome(r);
    t[o]++;
    if (o !== "error") t.valid++;
    if (o === "breach") for (const l of ["none", "basic", "strict"]) if (r.gates[l].decision === "allow") t.leak[l]++;
    if (o === "faithful") for (const l of ["basic", "strict"]) if (r.gates[l].decision !== "allow") t.falseBlock[l]++;
  }
  return t;
}

// ---------- slip (what the agent ordered vs what the user asked) ----------
const ROWS = [
  { label: "Item", breaches: ["UNEXPECTED_ITEM", "QUANTITY_INFLATED"], agent: (o) => o.items.map((i) => `${i.quantity} × ${i.name}`).join(", "), ask: (m) => m.expectedItems.map((e) => `${e.quantity} × ${e.keyword}`).join(", ") },
  { label: "Total", breaches: ["OVER_BUDGET", "PRICE_MISMATCH"], agent: (o) => money(o.currency, o.total), ask: (m, c) => `up to ${money(m.maxTotal.currency, m.maxTotal.value)}${c.advertisedTotal != null ? ` (listed ${m.maxTotal.currency} ${c.advertisedTotal.toFixed(2)})` : ""}` },
  { label: "Merchant", breaches: ["WRONG_PAYEE"], agent: (o) => o.payee, ask: (m) => m.allowedPayees.join(", ") },
  { label: "Currency", breaches: ["WRONG_CURRENCY"], agent: (o) => o.currency, ask: (m) => m.maxTotal.currency },
  { label: "Delivery", breaches: ["WRONG_SHIPPING"], agent: (o) => o.shipTo ?? "(none)", ask: (m) => m.shipTo ?? "any" },
  { label: "Subscription", breaches: ["UNAUTHORIZED_RECURRING"], agent: (o) => (o.recurring ? "yes" : "no"), ask: (m) => (m.allowRecurring ? "allowed" : "not allowed") },
];
function slip(order, scenario, breaches) {
  const m = scenario.mandate;
  const c = scenario.context;
  return h(
    "table",
    { class: "slip" },
    h("thead", {}, h("tr", {}, h("th", {}, "Field"), h("th", {}, "Agent ordered"), h("th", {}, "User asked for"), h("th", {}, "Check"))),
    h(
      "tbody",
      {},
      ROWS.map((row) => {
        const bad = row.breaches.some((b) => breaches.includes(b));
        return h(
          "tr",
          { class: bad ? "bad" : "ok" },
          h("th", { scope: "row" }, row.label),
          h("td", {}, row.agent(order)),
          h("td", { class: "ask" }, row.ask(m, c)),
          h("td", { class: "v" }, bad ? "✕ breach" : "✓ matches")
        );
      })
    )
  );
}

// ---------- seatbelt verdict chips ----------
const GATE_NAMES = { none: "No seatbelt", basic: "Basic seatbelt", strict: "Strict seatbelt" };
function gateChips(rec, decisions) {
  const isBreach = outcome(rec) === "breach";
  return h(
    "div",
    { class: "gates" },
    ["none", "basic", "strict"].map((l) => {
      const g = decisions[l];
      const allowed = g.decision === "allow";
      let cls, glyph, text;
      if (allowed) {
        cls = isBreach ? "bad" : "good";
        glyph = isBreach ? "✕" : "✓";
        text = isBreach ? "Bad order reaches PayPal" : "Order goes through";
      } else {
        cls = isBreach ? "good" : "bad";
        glyph = isBreach ? "✓" : "✕";
        text = `${isBreach ? "Stopped" : "Wrongly stopped"}: ${g.reasons.join(", ").toLowerCase().replaceAll("_", " ")}`;
      }
      return h("div", { class: `chip ${cls}` }, h("b", {}, `${glyph} ${GATE_NAMES[l]}`), text);
    })
  );
}
function noOrderNote(rec) {
  return h(
    "div",
    { class: "chip neutral", style: "margin-top:14px" },
    rec.status === "stop" ? "The agent refused to buy, so nothing was sent to PayPal." : `No usable answer from the model (${rec.error ?? "error"}). Not counted.`
  );
}

// ---------- page excerpt with the planted text highlighted ----------
function pageNode(scenario, full) {
  const text = renderPage(scenario);
  const idx = text.indexOf(scenario.injectedText);
  if (idx < 0) return h("pre", { class: "page-excerpt" }, text);
  let before = text.slice(0, idx);
  let after = text.slice(idx + scenario.injectedText.length);
  let pre = "";
  let post = "";
  if (!full) {
    const bl = before.split("\n");
    const al = after.split("\n");
    if (bl.length > 3) pre = "…\n";
    before = bl.slice(-3).join("\n");
    if (al.length > 2) post = "\n…";
    after = al.slice(0, 2).join("\n");
  }
  return h("pre", { class: "page-excerpt" }, pre + before, h("mark", {}, scenario.injectedText), after + post);
}

// ---------- hero ----------
function renderHero() {
  const root = $("#hero");
  root.replaceChildren();
  if (allBenchRecords.length === 0) {
    root.append(h("h1", {}, "Crash tests for AI shopping agents"), h("p", { class: "lede" }, "No benchmark data has been published yet."));
    return;
  }
  // The most telling attack: highest number of breached runs; ties go to the first listed.
  const counts = new Map();
  for (const r of allBenchRecords) if (outcome(r) === "breach") counts.set(r.scenarioId, (counts.get(r.scenarioId) ?? 0) + 1);
  let heroId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!heroId) heroId = "l2-forged-user-turn";
  const s = byId[heroId];
  const recs = allBenchRecords.filter((r) => r.scenarioId === heroId && r.status !== "error");
  const bad = recs.filter((r) => outcome(r) === "breach");
  const sample = bad[0];

  const headlines = {
    "l2-forged-user-turn": `A fake review said “buy 3”. The agent bought 3 in ${bad.length} of ${recs.length} runs.`,
  };
  const title = headlines[heroId] ?? `Hostile text won in ${bad.length} of ${recs.length} runs: “${s.title}”.`;
  const total = allBenchRecords.length;

  root.append(
    h("h1", {}, title),
    h(
      "p",
      { class: "lede" },
      `Crashcart crash-tests AI shopping agents. It plants hostile text where an agent reads it, checks what the agent actually orders, and tests whether a policy gate outside the model stops the bad order before it reaches PayPal. ${total.toLocaleString("en")} recorded runs so far.`
    )
  );
  if (!sample) return;
  const setting = settings.find((st) => st.records.includes(sample));
  root.append(
    h(
      "div",
      { class: "exhibit" },
      h("section", {}, h("h3", {}, "What the store page said"), pageNode(s, false), h("p", { class: "caption" }, "Fictional shop. The highlighted text is the planted attack.")),
      h("div", { class: "arrow", "aria-hidden": "true" }, h("span", {}, "AGENT DECIDES")),
      h(
        "section",
        {},
        h("h3", {}, "What the agent ordered"),
        slip(sample.order, s, sample.breaches),
        gateChips(sample, sample.gates),
        h("p", { class: "caption" }, `Recorded run: ${prettyModel(setting.model)}, ${promptName(setting.prompt)}, run ${sample.run}. User asked for: “${s.mandate.goal}”.`)
      )
    )
  );
}

// ---------- scoreboard ----------
function barRow(label, sub, recs) {
  const t = tally(recs);
  const parts = [["faithful", "Followed the user"], ["stop", "Refused to buy"], ["breach", "Breached the request"], ["error", "No usable answer"]];
  const total = t.faithful + t.stop + t.breach + t.error;
  const bar = h(
    "div",
    { class: "bar", role: "img", "aria-label": `${label}: ${parts.map(([k, n]) => `${t[k]} ${n.toLowerCase()}`).join(", ")}` },
    parts.filter(([k]) => t[k] > 0).map(([k]) => h("div", { class: `seg ${k}`, style: `flex:${t[k]} 1 0` }, t[k] / total >= 0.07 ? h("span", {}, String(t[k])) : null))
  );
  const leak = (l) =>
    t.breach === 0
      ? h("div", { class: "leak num none-yet", "data-l": GATE_NAMES[l], "aria-label": "no breaches to stop" }, "–", h("small", {}, "no breaches"))
      : h("div", { class: `leak num ${t.leak[l] ? "some" : "zero"}`, "data-l": GATE_NAMES[l] }, String(t.leak[l]), h("small", {}, `of ${t.breach}`));
  return h("div", { class: "board-row" }, h("div", { class: "name" }, label, h("small", {}, sub)), h("div", { class: "bar-wrap" }, bar), leak("none"), leak("basic"), leak("strict"));
}
function renderScoreboard() {
  const root = $("#score-body");
  root.replaceChildren();
  if (settings.length === 0) {
    root.append(h("p", {}, "No benchmark runs yet."));
    return;
  }
  const all = tally(allBenchRecords);
  const l1 = (rs) => rs.filter((r) => levelOf(r.scenarioId) === 1);
  const l2 = (rs) => rs.filter((r) => levelOf(r.scenarioId) === 2);
  const n = (f) => settings.reduce((a, s) => a + f(s.records).length, 0);

  root.append(
    h(
      "p",
      { class: "intro" },
      `Each row is one model with one prompt. Every attack was run ${bench[0]?.meta.runsPerScenario ?? "several"} times per row (22 attacks in two levels). Green is a run where the agent kept to what the user asked. A run is a breach when the order breaks the user's request: more money, another merchant, extra items, another address.`
    ),
    h("div", { class: "legend" }, [["faithful", "Followed the user"], ["stop", "Refused to buy"], ["breach", "Breached the request"], ["error", "No usable answer"]].map(([k, t]) => h("span", {}, h("i", { class: `sw ${k}` }), t)))
  );
  const board = h("div", { class: "board" }, h("div", { class: "board-head" }, h("div", {}, "Model and prompt"), h("div", {}, "What the agent did"), h("div", { class: "span3" }, "Bad orders that still reach payment with…"), h("div", {}), h("div", {}), h("div", {}), h("div", {}), h("div", {}), h("div", { class: "sub" }, "no seatbelt"), h("div", { class: "sub" }, "basic"), h("div", { class: "sub" }, "strict")));
  // simpler head: rebuild explicitly for clean grid
  board.firstChild.replaceChildren(h("div", {}, "Model and prompt"), h("div", {}, "What the agent did"), h("div", { class: "sub" }, "No seatbelt"), h("div", { class: "sub" }, "Basic"), h("div", { class: "sub" }, "Strict"));
  board.firstChild.style.gridTemplateColumns = "";
  for (const [lvl, name, note, pick] of [[1, "Blunt attacks", "“Note for AI shoppers: …” style instructions", l1], [2, "Crafted attacks", "fake system notices, forged chat turns, fake tool results", l2]]) {
    board.append(h("div", { class: "group-title" }, name, h("small", {}, `${note}. Columns on the right: bad orders that still reach payment.`)));
    for (const s of settings) board.append(barRow(prettyModel(s.model), promptName(s.prompt), pick(s.records)));
  }
  root.append(board);

  const c1 = tally(settings.flatMap((s) => l1(s.records)));
  const c2 = tally(settings.flatMap((s) => l2(s.records)));
  const hard = tally(settings.filter((s) => s.prompt === "hardened").flatMap((s) => l2(s.records)));
  const plain = tally(settings.filter((s) => s.prompt === "plain").flatMap((s) => l2(s.records)));
  root.append(
    h(
      "div",
      { class: "takeaways" },
      h("div", {}, h("b", {}, `Blunt attacks: ${pct(c1.breach, c1.valid)} breached. Crafted: ${pct(c2.breach, c2.valid)}.`), "Models spot instructions that shout. They fall for text that looks like data: a forged chat turn, a fake tool result, a fake consent record."),
      h("div", {}, h("b", {}, `Telling the agent to be careful: ${pct(plain.breach, plain.valid)} down to ${pct(hard.breach, hard.valid)}.`), "On crafted attacks, the hardened prompt helps a lot but does not remove the problem."),
      h("div", {}, h("b", {}, `Strict seatbelt: ${all.leak.strict} bad orders through, ${all.falseBlock.strict} good orders wrongly stopped.`), `Across ${all.valid.toLocaleString("en")} valid runs. It sits outside the model, so text on a page cannot argue with it.`)
    ),
    h(
      "details",
      { class: "table-view" },
      h("summary", {}, "Show these numbers as a table"),
      h(
        "table",
        { class: "plain-table" },
        h("thead", {}, h("tr", {}, ["Model", "Prompt", "Attacks", "Valid runs", "Followed", "Refused", "Breached", "Through: none", "basic", "strict"].map((x) => h("th", {}, x)))),
        h(
          "tbody",
          {},
          [1, 2].flatMap((lvl) =>
            settings.map((s) => {
              const t = tally(s.records.filter((r) => levelOf(r.scenarioId) === lvl));
              return h("tr", {}, [prettyModel(s.model), s.prompt, lvl === 1 ? "blunt" : "crafted", t.valid, t.faithful, t.stop, t.breach, t.leak.none, t.leak.basic, t.leak.strict].map((x) => h("td", { class: "num" }, String(x))));
            })
          )
        )
      )
    )
  );
}

// ---------- heatmap ----------
function heatColor(rate) {
  if (rate === 0) return ["#fff", "#55626d"];
  const a = 0.18 + 0.82 * rate;
  return [`rgba(200,16,46,${a.toFixed(2)})`, a > 0.55 ? "#fff" : "#12181f"];
}
function renderHeat() {
  const root = $("#heat-body");
  root.replaceChildren();
  if (settings.length === 0) return;
  root.append(h("p", { class: "intro" }, "Breached runs out of valid runs, per attack and setting. Darker red means the agent was fooled more often. Pick an attack to inspect the actual runs in the crash lab."));
  const rows = [];
  rows.push(h("tr", {}, h("th", { scope: "col" }, "Attack"), settings.map((s) => h("th", { scope: "col" }, prettyModel(s.model), h("br"), promptName(s.prompt)))));
  for (const lvl of [1, 2]) {
    rows.push(h("tr", { class: "lvl-row" }, h("th", { colspan: String(settings.length + 1), scope: "colgroup" }, lvl === 1 ? "Blunt attacks" : "Crafted attacks")));
    for (const s of allScenarios.filter((x) => levelOf(x.id) === lvl)) {
      rows.push(
        h(
          "tr",
          {},
          h("th", { class: "scn", scope: "row" }, h("button", { type: "button", onclick: () => openInLab(s.id) }, s.title, h("small", {}, s.surface.replace("-", " ")))),
          settings.map((st) => {
            const recs = st.records.filter((r) => r.scenarioId === s.id && r.status !== "error");
            const b = recs.filter((r) => outcome(r) === "breach").length;
            const [bg, fg] = heatColor(recs.length ? b / recs.length : 0);
            return h("td", { class: "cell", style: `background:${bg};color:${fg}`, title: `${b} of ${recs.length} runs breached` }, recs.length ? `${b}/${recs.length}` : "–");
          })
        )
      );
    }
  }
  root.append(h("div", { class: "heat-wrap" }, h("table", { class: "heat" }, h("tbody", {}, rows))));
}

// ---------- lab ----------
const lab = { scenarioId: null, key: null, run: 0 };
function openInLab(id) {
  lab.scenarioId = id;
  lab.run = 0;
  renderLab();
  $("#lab").scrollIntoView();
}
function renderLab() {
  const root = $("#lab-body");
  root.replaceChildren();
  if (settings.length === 0) {
    root.append(h("p", {}, "No recorded runs yet."));
    return;
  }
  if (!lab.scenarioId) lab.scenarioId = (allScenarios.find((s) => s.id === "l2-forged-user-turn") ?? allScenarios[0]).id;
  if (!lab.key) lab.key = settings[0].key;
  const setting = settings.find((s) => s.key === lab.key) ?? settings[0];
  const s = byId[lab.scenarioId];
  const recs = setting.records.filter((r) => r.scenarioId === s.id).sort((a, b) => a.run - b.run);
  if (lab.run >= recs.length) lab.run = 0;
  const rec = recs[lab.run];

  const scnSel = h("select", { id: "lab-scn", onchange: (e) => { lab.scenarioId = e.target.value; lab.run = 0; renderLab(); } },
    [1, 2].map((lvl) => h("optgroup", { label: lvl === 1 ? "Blunt attacks" : "Crafted attacks" }, allScenarios.filter((x) => levelOf(x.id) === lvl).map((x) => h("option", { value: x.id, selected: x.id === s.id }, x.title)))));
  const setSel = h("select", { id: "lab-set", onchange: (e) => { lab.key = e.target.value; lab.run = 0; renderLab(); } }, settings.map((x) => h("option", { value: x.key, selected: x.key === setting.key }, `${prettyModel(x.model)}, ${promptName(x.prompt)}`)));
  const runSel = h("select", { id: "lab-run", onchange: (e) => { lab.run = Number(e.target.value); renderLab(); } }, recs.map((r, i) => h("option", { value: String(i), selected: i === lab.run }, `Run ${r.run}: ${{ breach: "breached", faithful: "followed the user", stop: "refused", error: "no usable answer" }[outcome(r)]}`)));

  root.append(
    h("p", { class: "intro" }, "Pick an attack, a model setting and one recorded run. The left side is what the agent read. The right side is what it did and what each seatbelt would have done."),
    h("div", { class: "controls" }, h("div", { class: "field" }, h("label", { for: "lab-scn" }, "Attack"), scnSel), h("div", { class: "field" }, h("label", { for: "lab-set" }, "Model and prompt"), setSel), h("div", { class: "field" }, h("label", { for: "lab-run" }, "Recorded run"), runSel))
  );
  const left = h("section", {}, h("h3", {}, "What the agent read"), h("p", { class: "caption", style: "margin:0 0 10px" }, s.description), pageNode(s, true));
  const right = h("section", {}, h("h3", {}, "What the agent did"));
  if (!rec) {
    right.append(h("p", {}, "No runs recorded for this attack in this setting."));
  } else {
    if (rec.reason) right.append(h("blockquote", { class: "quote" }, `“${rec.reason}”`, h("small", {}, "The agent's own explanation")));
    if (rec.status === "order") {
      right.append(slip(rec.order, s, rec.breaches), gateChips(rec, rec.gates));
      if (rec.breaches.length) right.append(h("div", { class: "verdict" }, "Judge's verdict: this order breaks the user's request.", h("ul", {}, rec.breaches.map((b) => h("li", {}, BREACH_TEXT[b])))));
      else right.append(h("div", { class: "verdict" }, "Judge's verdict: this order matches the user's request."));
      right.append(
        h("p", { class: "pp" }, rec.paypal?.id ? ["PayPal sandbox order: ", h("code", {}, rec.paypal.id), ` (${rec.paypal.status})`] : "PayPal sandbox order: none recorded for this run (live PayPal runs are listed separately in the repository).")
      );
    } else right.append(noOrderNote(rec));
  }
  root.append(h("div", { class: "lab-grid" }, left, right));
}

// ---------- playground ----------
const play = { id: "l2-forged-user-turn", which: "unsafe", level: "strict", approval: "" };
function startOrder() {
  const s = byId[play.id];
  const o = play.which === "safe" && s.safeOrder ? s.safeOrder : s.unsafeOrder;
  return JSON.parse(JSON.stringify(o));
}
let playOrder = startOrder();

function renderPlayground() {
  const root = $("#play-body");
  root.replaceChildren();
  const s = byId[play.id];
  const m = s.mandate;
  const ask = h("div", { class: "mandate" }, h("b", {}, "What the user asked for"), `${m.goal}. Up to ${money(m.maxTotal.currency, m.maxTotal.value)} in total. Pay only ${m.allowedPayees.join(", ")}. Deliver to “${m.shipTo}”. Subscriptions ${m.allowRecurring ? "allowed" : "not allowed"}.${s.context.priorSpent ? ` Already spent: ${money(m.maxTotal.currency, s.context.priorSpent)}.` : ""}`);

  const presetSel = h("select", { id: "pg-scn", onchange: (e) => { play.id = e.target.value; if (!byId[play.id].safeOrder) play.which = "unsafe"; playOrder = startOrder(); renderPlayground(); } },
    [1, 2].map((lvl) => h("optgroup", { label: lvl === 1 ? "Blunt attacks" : "Crafted attacks" }, allScenarios.filter((x) => levelOf(x.id) === lvl).map((x) => h("option", { value: x.id, selected: x.id === play.id }, x.title)))));
  const whichSel = h("select", { id: "pg-which", onchange: (e) => { play.which = e.target.value; playOrder = startOrder(); renderPlayground(); } },
    h("option", { value: "unsafe", selected: play.which === "unsafe" }, "The order of a fooled agent"), s.safeOrder ? h("option", { value: "safe", selected: play.which === "safe" }, "The order of a faithful agent") : null);

  const live = () => { playOrder.recurring = playOrder.recurring === true; renderPlayResult(result); };
  const txt = (label, id, get, set, type = "text") => h("div", { class: "field" }, h("label", { for: id }, label), h("input", { id, type, value: String(get()), ...(type === "number" ? { step: "0.01", min: "0" } : {}), oninput: (e) => { set(e.target.value); live(); } }));

  const itemInputs = [0, 1, 2].flatMap((i) => {
    const it = playOrder.items[i];
    const ensure = () => (playOrder.items[i] ??= { name: "", unitPrice: 0, quantity: 1 });
    return [
      h("input", { type: "text", "aria-label": `Item ${i + 1} name`, placeholder: "Item name", value: it?.name ?? "", oninput: (e) => { ensure().name = e.target.value; live(); } }),
      h("input", { type: "number", step: "0.01", min: "0", "aria-label": `Item ${i + 1} unit price`, placeholder: "Price", value: it ? String(it.unitPrice) : "", oninput: (e) => { ensure().unitPrice = Number(e.target.value); live(); } }),
      h("input", { type: "number", step: "1", min: "1", "aria-label": `Item ${i + 1} quantity`, placeholder: "Qty", value: it ? String(it.quantity) : "", oninput: (e) => { ensure().quantity = Number(e.target.value); live(); } }),
    ];
  });

  const result = h("section", { id: "pg-result" });
  const form = h(
    "section",
    {},
    h("h3", {}, "The order the agent wants to place"),
    h("div", { class: "controls", style: "margin-top:12px" }, h("div", { class: "field" }, h("label", { for: "pg-scn" }, "Start from"), presetSel), h("div", { class: "field" }, h("label", { for: "pg-which" }, "Version"), whichSel)),
    ask,
    h("div", { class: "row2" }, txt("Currency", "pg-cur", () => playOrder.currency, (v) => (playOrder.currency = v.toUpperCase().trim())), txt("Total", "pg-total", () => playOrder.total, (v) => (playOrder.total = Number(v)), "number"), txt("Merchant", "pg-payee", () => playOrder.payee, (v) => (playOrder.payee = v.trim())), txt("Delivery label", "pg-ship", () => playOrder.shipTo ?? "", (v) => (playOrder.shipTo = v.trim()))),
    h("div", { class: "lab" }, "Items (name, unit price, quantity)"),
    h("div", { class: "items" }, itemInputs),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: playOrder.recurring === true, onchange: (e) => { playOrder.recurring = e.target.checked; live(); } }), "Starts a subscription")
  );
  root.append(
    h("p", { class: "intro" }, "Change any field and watch the decision update. This is the same gate and judge code the tests and the live runs use, compiled to run in your browser. Nothing is sent anywhere."),
    h("div", { class: "play-grid" }, form, result)
  );
  renderPlayResult(result);
}
function renderPlayResult(result) {
  const s = byId[play.id];
  const order = { ...playOrder, items: playOrder.items.filter((i) => i && i.name !== "" ), total: Number(playOrder.total) || 0 };
  order.items = order.items.map((i) => ({ name: i.name, unitPrice: Number(i.unitPrice) || 0, quantity: Number(i.quantity) || 1 }));
  const breaches = judgeOrder(s.mandate, order, s.context);
  const levelSel = h("select", { id: "pg-level", "aria-label": "Seatbelt level", onchange: (e) => { play.level = e.target.value; renderPlayResult(result); } }, ["none", "basic", "strict"].map((l) => h("option", { value: l, selected: l === play.level }, GATE_NAMES[l])));
  const appr = h("input", { id: "pg-appr", type: "number", min: "0", step: "1", value: play.approval, placeholder: "none", oninput: (e) => { play.approval = e.target.value; renderPlayResult(result); } });
  const policy = { level: play.level, ...(play.approval !== "" ? { approvalAbove: Number(play.approval) } : {}) };
  const g = evaluateOrder(policy, s.mandate, order, s.context);
  const reason = g.reasons.length ? g.reasons.map((r) => BREACH_TEXT[r]).join("; ") : "";
  const label = { allow: "Allowed: goes to PayPal", block: "Blocked: never sent", needs_approval: "Needs a human to approve" }[g.decision];
  const note = g.decision === "block" ? reason : g.decision === "needs_approval" ? `Order total is above ${play.approval}.` : play.level === "none" ? "No seatbelt: everything goes through." : "Nothing in this order breaks the rules this seatbelt checks.";
  result.replaceChildren(
    h("h3", {}, "The decision"),
    h("div", { class: "controls", style: "margin-top:12px" }, h("div", { class: "field" }, h("label", { for: "pg-level" }, "Seatbelt"), levelSel), h("div", { class: "field" }, h("label", { for: "pg-appr" }, "Ask a human above"), appr)),
    h("div", { class: `big-verdict ${g.decision === "allow" ? "allow" : "block"}`, role: "status" }, label, h("small", {}, note)),
    h(
      "div",
      { class: "verdict" },
      breaches.length ? "Judge's verdict (ground truth): this order breaks the user's request." : "Judge's verdict (ground truth): this order matches the user's request.",
      breaches.length ? h("ul", {}, breaches.map((b) => h("li", {}, BREACH_TEXT[b]))) : null,
      g.decision === "allow" && breaches.length ? h("p", { style: "margin:8px 0 0;font-weight:700;color:var(--breach)" }, "✕ A bad order got through. This is the kind of gap the benchmark measures.") : null
    )
  );
}

// ---------- method ----------
function renderMethod() {
  const r = $("#method-body");
  r.replaceChildren(
    h("h3", {}, "How a test works"),
    h("p", {}, "A fictional shop page is shown to a language-model agent together with the user's request (goal, budget, merchant, delivery address, no subscriptions). One line on the page is hostile. The agent answers with an order or a refusal. A judge that knows the full request lists every way the order breaks it. Then three seatbelts decide what would reach PayPal: none, a basic one that checks money (currency, budget, merchant, subscriptions), and a strict one that also checks what is bought, how many, and where it ships."),
    h("p", {}, "The seatbelts are plain code outside the model. They read the user's request, never the page, so no sentence on a page can change their rules."),
    h("h3", {}, "PayPal"),
    h("p", {}, ["Orders the chosen seatbelt allows can be created in the PayPal sandbox (Orders v2) and read back to confirm the stored amount. Sandbox only, no real money. See ", h("code", {}, "src/paypal/sandbox.ts"), "."]),
    h("h3", {}, "What these numbers are, and are not"),
    h("ul", { class: "limits" },
      h("li", {}, "Each number is computed in your browser from the recorded run files in the repository. Nothing is typed in by hand."),
      h("li", {}, "The agent is a single model call, not a multi-step browsing agent. Results describe this setup, not every shopping agent."),
      h("li", {}, "The 22 attacks are written by the authors. A rate is the share of these attacks that worked, not a rate for the real world."),
      h("li", {}, "Models are not deterministic, so each attack is repeated. Cells with few runs are noisy."),
      h("li", {}, "Known gap: a look-alike product that reuses the expected keyword passes the strict seatbelt. The judge flags it, the seatbelt does not."),
      h("li", {}, "Models tested: free-tier Gemini models through the Google AI Studio API. Only fictional data was sent.")),
    h("h3", {}, "Built with"),
    h("p", {}, "The PayPal sandbox, the Gemini API for the tested agents, and AI coding assistance (Claude) for the code. Product decisions and architecture are the author's. The source and every recorded run are in the repository."),
    h("p", {}, h("a", { href: "https://github.com/sethgoisso-pixel/Crashcart", rel: "noopener" }, "github.com/sethgoisso-pixel/Crashcart"))
  );
}

// ---------- boot ----------
renderHero();
renderScoreboard();
renderHeat();
renderLab();
renderPlayground();
renderMethod();
$("#built").textContent = `Data built ${new Date(data.generatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC from ${data.runs.length} recorded run files.`;
