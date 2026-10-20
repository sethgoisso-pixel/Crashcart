import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPage } from "../src/agent/shopper.ts";
import { evaluateOrder } from "../src/core/gate.ts";
import { judgeOrder } from "../src/core/judge.ts";
import { scenarios } from "../src/scenarios/index.ts";
import { scenariosL2 } from "../src/scenarios/level2.ts";

// docs/engine.js is generated (npm run build:site). This test fails if it is stale,
// i.e. if the demo site would run different code from the tests and the live runs.
// @ts-ignore generated JavaScript module without type declarations
const engine: any = await import("../docs/engine.js");

test("the site engine has the same scenarios as src/", () => {
  assert.deepEqual(engine.scenarios, scenarios);
  assert.deepEqual(engine.scenariosL2, scenariosL2);
});

test("the site engine judges, gates and renders exactly like src/", () => {
  for (const s of [...scenarios, ...scenariosL2]) {
    const orders = s.safeOrder ? [s.safeOrder, s.unsafeOrder] : [s.unsafeOrder];
    for (const o of orders) {
      assert.deepEqual(engine.judgeOrder(s.mandate, o, s.context), judgeOrder(s.mandate, o, s.context), s.id);
      for (const level of ["none", "basic", "strict"] as const) {
        assert.deepEqual(
          engine.evaluateOrder({ level }, s.mandate, o, s.context),
          evaluateOrder({ level }, s.mandate, o, s.context),
          `${s.id}/${level}`
        );
      }
    }
    assert.equal(engine.renderPage(s), renderPage(s), s.id);
  }
});
