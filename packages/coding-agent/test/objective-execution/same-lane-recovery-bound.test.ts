// @isolated: canonical hydration regression uses a fake clock.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evidenceMarkerOf } from "../../src/core/objective-execution/ledger-route-checkpoints.ts";
import { ObjectiveExecutionController } from "../../src/core/objective-execution/objective-execution-controller.ts";
import type { RouteHistoryEntry } from "../../src/core/objective-execution/objective-route-projector.ts";
import { OrchestrationEventStore } from "../../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime } from "../../src/core/orchestration/task-runtime.ts";
import { projectCanonicalTruth } from "../../src/core/system-one/canonical-truth.ts";
import { sameLaneVerificationDirective } from "../../src/core/system-one/control-directive.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { tempDir } from "../temp-dir.ts";

async function fixture() {
	const objectiveId = "same-lane-bound";
	const store = new OrchestrationEventStore({ agentDir: tempDir("pi-recovery-bound-"), sessionId: randomUUID() });
	const runtime = new DurableTaskRuntime({ store });
	await runtime.createObjective({ objectiveId, title: "Verify", description: "Verify the actual requested outcome" });
	const history: RouteHistoryEntry[] = [];
	const rootRoutes: string[] = [];
	const execution = new ExecutionStore({
		run_id: "recovery",
		objective: { request: "verify", normalized_goal: "verify", acceptance_criteria: [], constraints: [] },
		repo: { root: "/test", baseline_revision: "1" },
	});
	let pending = sameLaneVerificationDirective(["unresolved evidence"]);
	let cancelled = false;
	const controller = new ObjectiveExecutionController({
		runtime: { reconcileObjective: async () => runtime.getSnapshot(), isCancelled: () => cancelled },
		checkpoints: {
			recordRoute: async (route) => {
				history.push({
					route: route.route,
					reasonCodes: route.reason_codes,
					evidenceMarker: evidenceMarkerOf(runtime.getSnapshot(), objectiveId),
				});
			},
			recordRouteOutcome: async (_route, executor) => {
				history[history.length - 1] = { ...history[history.length - 1], executor };
			},
			recentRoutes: async () => history.slice(-6),
		},
		systemOne: { peekControlDirective: () => pending, snapshot: () => execution.snapshot() },
		rootExecutor: {
			execute: async (route) => {
				rootRoutes.push(route.route);
			},
		},
	});
	return {
		controller,
		objectiveId,
		runtime,
		execution,
		rootRoutes,
		history,
		getPending: () => pending,
		cancel: () => {
			cancelled = true;
		},
		replaceFinding: () => {
			pending = sameLaneVerificationDirective(["different unresolved evidence"]);
		},
	};
}

describe("same-lane verification recovery bound", () => {
	afterEach(() => vi.useRealTimers());

	it("canonical hydration clock and revision churn cannot re-earn an unchanged finding's recovery", async () => {
		const f = await fixture();
		vi.useFakeTimers();
		let clock = Date.parse("2026-10-02T12:00:00Z");
		f.runtime.recordObjectiveEvidence(f.objectiveId, {
			evidenceId: "unchanged",
			kind: "observation",
			summary: "Same diagnostic",
			artifactIds: [],
			trusted: true,
			createdAt: "2026-10-02T11:00:00.000Z",
		});
		const hydrate = () => {
			clock += 1_000;
			vi.setSystemTime(clock);
			f.execution.hydrateFromCanonical(
				projectCanonicalTruth({
					runtime: f.runtime.getSnapshot(),
					lastRoute: { route: "replan", objective_id: f.objectiveId },
					currentRevision: String(clock),
					verificationObligations: [{ id: "failing-check", command: "vitest test/example.test.ts" }],
				}),
			);
		};
		hydrate();
		const initial = f.execution.snapshot();
		f.controller.bindSessionExecutors({
			systemOne: {
				peekControlDirective: f.getPending,
				snapshot: () => f.execution.snapshot(),
				validateObjectivePostflight: async () => hydrate(),
			},
		});
		const terminal = await f.controller.runCycles(f.objectiveId, 20);
		expect(f.execution.snapshot().verification[0].timestamp).not.toBe(initial.verification[0].timestamp);
		expect(f.execution.snapshot().observations[0].source.revision).not.toBe(initial.observations[0].source.revision);
		expect(terminal?.status).toBe("blocked");
		expect(f.rootRoutes).toEqual(["deterministic_test", "deterministic_test", "replan"]);
		f.execution.recordVerification({
			kind: "unit_test",
			status: "passed",
			command: "vitest test/example.test.ts",
			observation_ids: ["actual-recheck-receipt"],
		});
		await f.controller.runCycles(f.objectiveId, 1);
		expect(f.rootRoutes).toHaveLength(4);
		expect(f.getPending().reasonCodes).toContain("unresolved evidence");
	});

	it("holds unchanged findings after one recovery instead of submitting unlimited no-op turns", async () => {
		const f = await fixture();
		const terminal = await f.controller.runCycles(f.objectiveId, 20);
		expect(terminal?.status).toBe("blocked");
		expect(terminal?.reasonCodes).toContain("same_lane_verification_recovery_exhausted");
		expect(f.rootRoutes).toEqual(["deterministic_test", "deterministic_test", "replan"]);
		expect(f.getPending().reasonCodes).toContain("unresolved evidence");
		expect(f.runtime.getSnapshot().objectives[f.objectiveId].objective.status).not.toBe("completed");
		await f.controller.runCycles(f.objectiveId, 20);
		expect(f.rootRoutes).toHaveLength(3);
	});

	it("new diagnostic evidence permits receiving-lane verification again", async () => {
		const f = await fixture();
		await f.controller.runCycles(f.objectiveId, 4);
		f.runtime.recordObjectiveEvidence(f.objectiveId, {
			evidenceId: "diagnostic",
			kind: "observation",
			summary: "New diagnostic",
			artifactIds: [],
			trusted: true,
			createdAt: new Date().toISOString(),
		});
		await f.controller.runCycles(f.objectiveId, 1);
		expect(f.rootRoutes.at(-1)).toBe("deterministic_test");
		expect(f.rootRoutes).toHaveLength(4);
	});

	it("replacement findings get their own verification and cancellation outranks exhausted recovery", async () => {
		const f = await fixture();
		await f.controller.runCycles(f.objectiveId, 4);
		f.replaceFinding();
		await f.controller.runCycles(f.objectiveId, 1);
		expect(f.rootRoutes).toHaveLength(4);
		f.cancel();
		expect((await f.controller.runCycles(f.objectiveId, 1))?.status).toBe("cancelled");
		expect(f.rootRoutes).toHaveLength(4);
	});

	it("real check receipts reset recovery even when task and evidence counts stay unchanged", async () => {
		const f = await fixture();
		await f.controller.runCycles(f.objectiveId, 4);
		const before = evidenceMarkerOf(f.runtime.getSnapshot(), f.objectiveId);
		f.execution.recordVerification({
			kind: "unit_test",
			status: "failed",
			command: "targeted check",
			covers_acceptance_ids: [],
		});
		await f.controller.runCycles(f.objectiveId, 1);
		expect(evidenceMarkerOf(f.runtime.getSnapshot(), f.objectiveId)).toBe(before);
		expect(f.rootRoutes).toHaveLength(4);
		expect(f.getPending().reasonCodes).toContain("unresolved evidence");
	});

	it("interrupted recovery does not spend the allowance and explicit owner resume permits a fresh attempt", async () => {
		const f = await fixture();
		await f.controller.runCycles(f.objectiveId, 2);
		f.controller.bindSessionExecutors({
			rootExecutor: {
				execute: async () => {
					throw new Error("interrupted");
				},
			},
		});
		await expect(f.controller.runCycles(f.objectiveId, 1)).rejects.toThrow("interrupted");
		f.controller.bindSessionExecutors({
			rootExecutor: {
				execute: async (route) => {
					f.rootRoutes.push(route.route);
				},
			},
		});
		await f.controller.runCycles(f.objectiveId, 1);
		expect(f.rootRoutes).toHaveLength(3);
		expect((await f.controller.runCycles(f.objectiveId, 1))?.status).toBe("blocked");
		f.controller.resetVerificationRecovery(f.objectiveId);
		await f.controller.runCycles(f.objectiveId, 1);
		expect(f.rootRoutes).toHaveLength(4);
		expect(f.getPending().reasonCodes).toContain("unresolved evidence");
	});

	it("System One rerouting a root recovery leaves its allowance unspent", async () => {
		const f = await fixture();
		await f.controller.runCycles(f.objectiveId, 2);
		f.controller.bindSessionExecutors({ rootExecutor: { execute: async () => ({ outcome: "rerouted" }) } });
		await f.controller.runCycles(f.objectiveId, 1);
		f.controller.bindSessionExecutors({
			rootExecutor: {
				execute: async (route) => {
					f.rootRoutes.push(route.route);
				},
			},
		});
		await f.controller.runCycles(f.objectiveId, 1);
		expect(f.rootRoutes).toEqual(["deterministic_test", "deterministic_test", "replan"]);
	});
});
