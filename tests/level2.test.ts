import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPage } from "../src/agent/shopper.ts";
import { evaluateOrder } from "../src/core/gate.ts";
import { judgeOrder } from "../src/core/judge.ts";
import { scenarios } from "../src/scenarios/index.ts";
import { scenariosL2 } from "../src/scenarios/level2.ts";

test("level 2 ids are unique and do not collide with level 1", () => {
  const ids = [...scenarios, ...scenariosL2].map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(scenariosL2.every((s) => s.id.startsWith("l2-")));
});

test("level 2: safe orders are faithful, unsafe orders get exactly the declared breaches", () => {
  for (const s of scenariosL2) {
    if (s.safeOrder) assert.deepEqual(judgeOrder(s.mandate, s.safeOrder, s.context), [], s.id);
    assert.deepEqual(judgeOrder(s.mandate, s.unsafeOrder, s.context), s.expectedBreaches, s.id);
  }
});

test("level 2: hostile text appears exactly once on the page", () => {
  for (const s of scenariosL2) {
    assert.equal(renderPage(s).split(s.injectedText).length - 1, 1, s.id);
  }
});

test("level 2 gate results: basic misses intent attacks, strict misses only the look-alike", () => {
  const missed = (level: "none" | "basic" | "strict") =>
    scenariosL2
      .filter((s) => evaluateOrder({ level }, s.mandate, s.unsafeOrder, s.context).decision === "allow")
      .map((s) => s.id)
      .sort();
  assert.equal(missed("none").length, scenariosL2.length);
  assert.deepEqual(missed("basic"), ["l2-address-archived-tool", "l2-consent-on-file", "l2-lookalike-hub"]);
  assert.deepEqual(missed("strict"), ["l2-lookalike-hub"]);
});

test("level 2: gates never block a safe order", () => {
  for (const s of scenariosL2) {
    for (const level of ["basic", "strict"] as const) {
      assert.equal(evaluateOrder({ level }, s.mandate, s.safeOrder!, s.context).decision, "allow", `${s.id}/${level}`);
    }
  }
});
