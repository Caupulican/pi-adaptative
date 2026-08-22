import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildWorkerExecutionPlan,
	compileManagedProcessExecutionGrant,
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

	it("derives effective capabilities only from tools named by the profile", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "read-only",
			model: { provider: "test", id: "model" },
			capabilityCeiling: ["filesystem.read", "filesystem.write", "memory.query"],
			toolNames: ["read"],
		});

		const plan = buildWorkerExecutionPlan({
			profile,
			settings: settings({ writeEnabled: true }),
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

	it("materializes only the bounded memory_read adapter when the profile permits query access", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "bounded-memory",
			model: { provider: "test", id: "model" },
			capabilityCeiling: ["memory.query", "memory.mutate"],
			toolNames: ["memory_read"],
		});

		const plan = buildWorkerExecutionPlan({
			profile,
			settings: settings(),
			cwd: "/repo",
			deniedPaths: [],
			memoryEnabled: true,
		});

		expect(plan.toolManifests).toMatchObject([
			{ toolName: "memory_read", capabilities: ["memory.query"], enforcements: ["memory-broker"] },
		]);
		expect(plan.requiredCapabilities).toEqual(["memory.query"]);
		expect(plan.readMemory).toBe(true);
	});

	it("preserves the bounded memory_read adapter when narrowing an admitted plan", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "narrow-memory-read",
			model: { provider: "test", id: "model" },
			capabilityCeiling: ["filesystem.read", "memory.query"],
			toolNames: ["memory_read"],
		});
		const plan = buildWorkerExecutionPlan({
			profile,
			settings: settings(),
			cwd: "/repo",
			deniedPaths: [],
			memoryEnabled: true,
		});

		const narrowed = narrowWorkerExecutionPlan(workerExecutionAuthorityFromPlan(plan), plan);

		expect(narrowed.toolManifests.map((manifest) => manifest.toolName)).toEqual(["memory_read"]);
		expect(narrowed.readMemory).toBe(true);
	});

	it("rejects the root-only memory tool from managed worker grants", () => {
		const compiled = compileManagedProcessExecutionGrant({
			target: { objectiveId: "objective-1", taskId: "task-1", attemptId: "attempt-1" },
			laneId: "lane-1",
			authorizationId: "authorization-1",
			role: "implementer",
			allowedTools: ["memory"],
			writePaths: [],
			cwd: "/repo",
			deniedPaths: [],
			budget: {},
		});

		expect(compiled).toEqual({ ok: false, reasonCodes: ["unknown_tool:memory"] });
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
			settings: settings({ writeEnabled: false }),
			cwd: "/repo",
			deniedPaths: ["/repo/private"],
			memoryEnabled: false,
		});
		const widened = buildWorkerExecutionPlan({
			profile,
			settings: settings({ writeEnabled: true }),
			cwd: "/repo",
			deniedPaths: ["/repo/new-private"],
			memoryEnabled: true,
		});

		const effective = narrowWorkerExecutionPlan(workerExecutionAuthorityFromPlan(admitted), widened);

		expect(effective.toolManifests.map((manifest) => manifest.toolName)).toEqual(["read"]);
		expect(effective.requiredCapabilities).toEqual(["filesystem.read"]);
		expect(effective.writeEnabled).toBe(false);
		expect(effective.writePaths).toEqual([]);
		expect(effective.deniedPaths).toEqual([
			resolve("/repo/private"),
			resolve("/repo/.pi/settings.json"),
			resolve("/repo/new-private"),
		]);
	});

	it("does not invent readPaths or filesystem.read authority for process-only lanes", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "shell-only",
			model: { provider: "test", id: "model" },
			capabilityCeiling: ["process.exec"],
			toolNames: ["bash"],
		});
		const plan = buildWorkerExecutionPlan({
			profile,
			settings: settings(),
			cwd: "/repo",
			deniedPaths: [],
			memoryEnabled: false,
		});

		expect(plan.toolManifests.map((manifest) => manifest.toolName)).toEqual(["bash"]);
		expect(plan.requiredCapabilities).toEqual(["process.exec"]);
		expect(plan.processEnabled).toBe(true);
		expect(plan.readPaths).toEqual([]);
		expect(plan.writePaths).toEqual([]);

		const narrowed = narrowWorkerExecutionPlan(workerExecutionAuthorityFromPlan(plan), plan);
		expect(narrowed.readPaths).toEqual([]);
		expect(narrowed.writePaths).toEqual([]);

		const managed = compileManagedProcessExecutionGrant({
			target: { objectiveId: "objective-1", taskId: "task-1", attemptId: "attempt-1" },
			laneId: "lane-1",
			authorizationId: "auth-1",
			role: profile.role,
			allowedTools: ["bash"],
			writePaths: [],
			cwd: "/repo",
			deniedPaths: [],
			budget: {},
		});
		if (!managed.ok) throw new Error(`Expected a managed process grant: ${managed.reasonCodes.join(", ")}`);
		expect(managed.grant.readPaths).toEqual([]);
		expect(managed.grant.writePaths).toEqual([]);
	});

	it("includes run_toolkit_script only through an explicitly admitted worker adapter", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "toolkit-adapter",
			model: { provider: "test", id: "model" },
			capabilityCeiling: ["process.exec"],
			toolNames: ["run_toolkit_script"],
		});
		const withoutAdapter = buildWorkerExecutionPlan({
			profile,
			settings: settings(),
			cwd: "/repo",
			deniedPaths: [],
			memoryEnabled: false,
		});
		expect(withoutAdapter.toolManifests).toEqual([]);

		const withAdapter = buildWorkerExecutionPlan({
			profile,
			settings: settings(),
			cwd: "/repo",
			deniedPaths: [],
			memoryEnabled: false,
			workerToolAdapterNames: ["run_toolkit_script"],
		});
		expect(withAdapter.toolManifests).toMatchObject([
			{ toolName: "run_toolkit_script", capabilities: ["process.exec"] },
		]);
		expect(withAdapter.processEnabled).toBe(true);
	});

	it("uses machine scope by default and one profile workspace as cwd plus symmetric scope", () => {
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "root-read-boundary",
			model: { provider: "test", id: "model" },
			capabilityCeiling: ["filesystem.read"],
			toolNames: ["read"],
		});

		const machineWide = buildWorkerExecutionPlan({
			profile,
			settings: settings(),
			cwd: "/repo",
			deniedPaths: [],
			memoryEnabled: false,
		});
		const focused = buildWorkerExecutionPlan({
			profile: { ...profile, workspacePath: "/other/project" },
			settings: settings(),
			cwd: "/repo",
			deniedPaths: [],
			memoryEnabled: false,
		});

		expect(machineWide.cwd).toBe(resolve("/repo"));
		expect(machineWide.readPaths).toEqual([resolve("/")]);
		expect(focused.cwd).toBe(resolve("/other/project"));
		expect(focused.readPaths).toEqual([resolve("/other/project")]);
	});
});
