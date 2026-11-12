import assert from "node:assert/strict";
import { test } from "node:test";
import { selectLiveScenarios } from "./live-args.mjs";

const scenarios = [{ id: "s0" }, { id: "s1" }, { id: "s2" }];

test("default selection includes the complete declared gate", () => {
	assert.deepEqual(selectLiveScenarios(scenarios, []), scenarios);
});

test("an explicit scope preserves declaration order and does not run duplicates", () => {
	assert.deepEqual(selectLiveScenarios(scenarios, ["s2", "s0", "s2"]), [scenarios[0], scenarios[2]]);
});

test("unknown IDs refuse both an otherwise empty gate and a partly valid scope", () => {
	assert.throws(() => selectLiveScenarios(scenarios, ["s99"]), /Unknown live scenario IDs: s99/);
	assert.throws(() => selectLiveScenarios(scenarios, ["s1", "s99"]), /Unknown live scenario IDs: s99/);
});
