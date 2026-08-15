import assert from "node:assert/strict";
import test from "node:test";
import { WORKSPACES, resolveWorkspaceTestPlan } from "./workspace-test-plan.mjs";

test("the default plan retains every workspace in dependency order", () => {
	assert.deepEqual(resolveWorkspaceTestPlan([]), WORKSPACES);
});

test("a selected plan keeps canonical order and excludes unrequested workspaces", () => {
	assert.deepEqual(
		resolveWorkspaceTestPlan(["packages/agent", "packages/tui", "packages/ai"]),
		["packages/tui", "packages/ai", "packages/agent"],
	);
});

test("a selected plan rejects unknown or duplicate workspaces", () => {
	assert.throws(() => resolveWorkspaceTestPlan(["packages/unknown"]), /Unknown test workspace/u);
	assert.throws(
		() => resolveWorkspaceTestPlan(["packages/tui", "packages/tui"]),
		/Duplicate test workspace/u,
	);
});
