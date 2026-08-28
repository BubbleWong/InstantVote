import test from "node:test";
import assert from "node:assert/strict";
import { resultBarTransitions } from "../public/results-animation.js";

const option = (id, percentage) => ({ id, percentage });

test("does not animate result bars whose percentages are unchanged", () => {
  const previous = { id: "session-1", options: [option("a", 60), option("b", 40)] };
  const current = { id: "session-1", options: [option("a", 60), option("b", 40)] };
  const transitions = resultBarTransitions(previous, current);

  assert.deepEqual(transitions.get("a"), { animate: false, startPercentage: 60 });
  assert.deepEqual(transitions.get("b"), { animate: false, startPercentage: 40 });
});

test("animates changed percentages from their previous values", () => {
  const previous = { id: "session-1", options: [option("a", 60), option("b", 40)] };
  const current = { id: "session-1", options: [option("a", 50), option("b", 50)] };
  const transitions = resultBarTransitions(previous, current);

  assert.deepEqual(transitions.get("a"), { animate: true, startPercentage: 60 });
  assert.deepEqual(transitions.get("b"), { animate: true, startPercentage: 40 });
});

test("animates initial results from zero", () => {
  const transitions = resultBarTransitions(null, { id: "session-1", options: [option("a", 75)] });
  assert.deepEqual(transitions.get("a"), { animate: true, startPercentage: 0 });
});
