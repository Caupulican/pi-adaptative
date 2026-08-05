import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildWorkerExecutionPlan,
	narrowWorkerExecutionPlan,
	workerExecutionAuthorityFromPlan,
} from "../src/core/delegation/worker-execution-policy.ts";
import type { ResolvedWorkerDelegationSettings } from "../src/core/settings-manager.ts";
import { createTestWorkerOrchestrationProfile } from "./orchestration-profile-fixture.ts";

function settings(overrides: Partial<ResolvedWorkerDelegationSettings> = {}): ResolvedWorkerDelegationSettings {
	return {
		enabled: true,
		maxUsd: 1,
		maxWallClockMs: 120_000,
		writeEnabled: false,
		writePaths: [],
		maxConcurrent: 1,
		...overrides,
	};
}

describe("buildWorkerExecutionPlan", () => {
	it("does not add recursive orchestration when the task profile omits delegation", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "recursive-by-default",
			model: { provider: "test", id: "model" },
			capabilityCeiling: ["filesystem.read"],
			toolNames: ["read"],
		});

		const plan = buildWorkerExecutionPlan({
			profile,
			settings: settings(),
			cwd: "/repo",
			deniedPaths: [],
			memoryEnabled: false,
		});

		expect(plan.toolManifests.map((manifest) => manifest.toolName)).toEqual(["read"]);
		expect(plan.requiredCapabilities).toEqual(["filesystem.read"]);
		expect(workerExecutionAuthorityFromPlan(plan)).toMatchObject({
			toolNames: ["read"],
			capabilities: ["filesystem.read"],
		});
	});

	it("derives effective capabilities from materialized profile tools, not the broader ceiling", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "read-only",
			model: { provider: "test", id: "model" },
			capabilityCeiling: ["filesystem.read", "filesystem.write", "memory.query"],
			toolNames: ["read"],
		});

		const plan = buildWorkerExecutionPlan({
			profile,
			settings: settings({ writeEnabled: true, writePaths: ["src"] }),
			cwd: "/repo",
			deniedPaths: [],
			memoryEnabled: true,
		});

		expect(plan.toolManifests.map((manifest) => manifest.toolName)).toEqual(["read"]);
		expect(plan.requiredCapabilities).toEqual(["filesystem.read"]);
		expect(plan.writeEnabled).toBe(false);
		expect(plan.writePaths).toEqual([]);
		expect(plan.readMemory).toBe(false);
	});

	it("treats the global zero wall-clock setting as disabled without creating an infinite budget value", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "no-wall-clock",
			model: { provider: "test", id: "model" },
		});
		const withoutProfileWallClock = { ...profile, budget: { maxCostUsd: 1, maxToolCalls: 4 } };

		const plan = buildWorkerExecutionPlan({
			profile: withoutProfileWallClock,
			settings: settings({ maxWallClockMs: 0 }),
			cwd: "/repo",
			deniedPaths: [],
			memoryEnabled: false,
		});

		expect(plan.budget.maxWallClockMs).toBeUndefined();
		expect(Object.values(plan.budget).every(Number.isFinite)).toBe(true);
	});

	it("preserves an absent owner tool-call budget instead of inventing a worker ceiling", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "no-tool-budget",
			model: { provider: "test", id: "model" },
		});
		const plan = buildWorkerExecutionPlan({
			profile: { ...profile, budget: { maxCostUsd: 1 } },
			settings: settings(),
			cwd: "/repo",
			deniedPaths: [],
			memoryEnabled: false,
		});

		expect(plan.budget.maxToolCalls).toBeUndefined();
		expect("maxToolCalls" in plan.budget).toBe(false);
	});

	it("treats a zero global cost setting as disabled but preserves an explicit zero-cost profile", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "cost-sentinel",
			model: { provider: "test", id: "model" },
		});
		const withoutProfileCost = { ...profile, budget: { maxToolCalls: 4 } };
		const globalDisabled = buildWorkerExecutionPlan({
			profile: withoutProfileCost,
			settings: settings({ maxUsd: 0 }),
			cwd: "/repo",
			deniedPaths: [],
			memoryEnabled: false,
		});
		const profileZero = buildWorkerExecutionPlan({
			profile: { ...profile, budget: { maxCostUsd: 0, maxToolCalls: 4 } },
			settings: settings({ maxUsd: 0 }),
			cwd: "/repo",
			deniedPaths: [],
			memoryEnabled: false,
		});

		expect(globalDisabled.budget.maxCostUsd).toBeUndefined();
		expect(profileZero.budget.maxCostUsd).toBe(0);
	});

	it("allows live settings to narrow admitted authority but never widen it", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "immutable-authority",
			model: { provider: "test", id: "model" },
			capabilityCeiling: ["filesystem.read", "filesystem.write"],
			toolNames: ["read", "write"],
		});
		const admitted = buildWorkerExecutionPlan({
			profile,
			settings: settings({ writeEnabled: false, writePaths: [] }),
			cwd: "/repo",
			deniedPaths: ["/repo/private"],
			memoryEnabled: false,
		});
		const widened = buildWorkerExecutionPlan({
			profile,
			settings: settings({ writeEnabled: true, writePaths: ["/repo"] }),
			cwd: "/repo",
			deniedPaths: ["/repo/new-private"],
			memoryEnabled: true,
		});

		const effective = narrowWorkerExecutionPlan(workerExecutionAuthorityFromPlan(admitted), widened);

		expect(effective.toolManifests.map((manifest) => manifest.toolName)).toEqual(["read"]);
		expect(effective.requiredCapabilities).toEqual(["filesystem.read"]);
		expect(effective.writeEnabled).toBe(false);
		expect(effective.writePaths).toEqual([]);
		expect(effective.deniedPaths).toEqual([resolve("/repo/private"), resolve("/repo/new-private")]);
	});
});
