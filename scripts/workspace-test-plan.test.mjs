import assert from "node:assert/strict";
import test from "node:test";
import { WORKSPACES, planWorkspaceTests, resolveWorkspaceTestPlan } from "./workspace-test-plan.mjs";

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

test("a test/ filter with no workspace runs only workspaces that own that path", () => {
	const exists = (path) => path.replaceAll("\\", "/").endsWith("packages/coding-agent/test/system-one");
	assert.deepEqual(planWorkspaceTests(["test/system-one"], exists), {
		workspaces: ["packages/coding-agent"],
		filters: ["test/system-one"],
	});
});

test("an owned test/ filter plus a workspace keeps that workspace and forwards the filter", () => {
	const exists = () => true;
	assert.deepEqual(planWorkspaceTests(["packages/tui", "test/system-one"], exists), {
		workspaces: ["packages/tui"],
		filters: ["test/system-one"],
	});
});

test("a test/ filter owned by no workspace is rejected", () => {
	assert.throws(() => planWorkspaceTests(["test/system-one"], () => false), /Unknown test filter/u);
});

test("bare npm test still selects every workspace and forwards no filters", () => {
	assert.deepEqual(planWorkspaceTests([]), {
		workspaces: [...WORKSPACES],
		filters: [],
	});
});
