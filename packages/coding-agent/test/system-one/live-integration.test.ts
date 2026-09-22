import { describe, expect, it, vi } from "vitest";
import { executeSystemOneResumeRevalidation } from "../../src/core/agent-session-guards.ts";
import { createGoalState } from "../../src/core/goals/goal-state.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { ToolGateController } from "../../src/core/tool-gate-controller.ts";
import { createGoalToolDefinition } from "../../src/core/tools/goal.ts";

describe("System One Live Integration", () => {
	function createMockSystemOne(
		overrides: {
			toolGateOutcome?: "allow" | "block";
			toolGateReason?: string;
			completionOutcome?: "approve" | "reject";
			completionReason?: string;
		} = {},
	): SystemOneController {
		const store = new ExecutionStore({
			run_id: "live-int-test",
			objective: {
				request: "Test integration",
				normalized_goal: "Verify System One wiring",
				acceptance_criteria: [{ id: "AC-1", text: "Passes", required: true }],
				constraints: [],
			},
			repo: { root: "/workspace", baseline_revision: "base-rev-1" },
		});
		const adapter = {
			evaluate: vi.fn(async () => ({
				model: "jev-1.13.0",
				answers: {},
				latency_ms: 10,
			})),
		};
		const controller = new SystemOneController({ store, adapter });
		if (overrides.toolGateOutcome) {
			controller.validateToolGate = vi.fn(async () => ({
				outcome: overrides.toolGateOutcome!,
				reason: overrides.toolGateReason,
			}));
		}
		if (overrides.completionOutcome) {
			controller.executeCompletionTransaction = vi.fn(async () => {
				if (overrides.completionOutcome === "reject") {
					return {
						verdict: "rework" as const,
						failed_gates: [
							{
								id: "gate-1",
								reason: overrides.completionReason ?? "Completion criteria not satisfied",
								required_next_proof: "proof",
							},
						],
					};
				}
				return {
					verdict: "complete" as const,
					failed_gates: [],
				};
			});
		}
		return controller;
	}

	it("does not ask Jev about a single tool call, even one the old gate would have classified prohibited", async () => {
		const systemOne = createMockSystemOne({
			toolGateOutcome: "block",
			toolGateReason: "Prohibited repository mutation during discovery phase",
		});

		const gate = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => "/workspace",
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => {},
			getExtensionRunner: () => ({ hasHandlers: () => false }) as any,
			getSystemOneController: () => systemOne,
		});

		const result = await gate.beforeToolCall(
			{
				toolCall: { id: "call-1", name: "edit" },
				args: { path: "critical.ts" },
				assistantMessage: { provider: "mock", model: "mock" } as any,
			} as any,
			undefined,
		);

		expect(result?.block).toBeUndefined();
		expect(systemOne.validateToolGate).not.toHaveBeenCalled();
	});

	it("records an allowed tool call without a Jev evaluation", async () => {
		const systemOne = createMockSystemOne({
			toolGateOutcome: "allow",
		});

		const gate = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => "/workspace",
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => {},
			getExtensionRunner: () => ({ hasHandlers: () => false }) as any,
			getSystemOneController: () => systemOne,
		});

		const result = await gate.beforeToolCall(
			{
				toolCall: { id: "call-2", name: "read" },
				args: { path: "safe.ts" },
				assistantMessage: { provider: "mock", model: "mock" } as any,
			} as any,
			undefined,
		);

		expect(result).toBeUndefined();
		expect(systemOne.validateToolGate).not.toHaveBeenCalled();
		expect(systemOne.store.snapshot().tool_events.at(-1)).toMatchObject({ tool: "read", call_id: "call-2" });
	});

	it("gates goal complete transition on System One completion validation", async () => {
		const systemOne = createMockSystemOne({
			completionOutcome: "reject",
			completionReason: "Unsatisfied acceptance criteria: AC-1 has no passing verification",
		});

		const goalState = createGoalState({
			goalId: "goal-test-1",
			userGoal: "Ship feature",
			now: "2026-01-01T00:00:00.000Z",
		});
		goalState.requirements = [
			{
				id: "req-1",
				text: "Working code",
				status: "satisfied",
				evidenceIds: ["ev-1"],
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		];
		goalState.evidence = [
			{
				id: "ev-1",
				kind: "test",
				summary: "All unit tests pass",
				verified: true,
				outcome: "succeeded",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		];

		let currentState = goalState;
		const goalTool = createGoalToolDefinition({
			getGoalState: () => currentState,
			saveGoalState: (s) => {
				currentState = s;
				return "rev-1";
			},
			getSystemOneController: () => systemOne,
		});

		const result = await goalTool.execute(
			"call-goal-1",
			{ action: "complete" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.isError).toBe(true);
		expect((result.details as any)?.applied).toBe(false);
		expect(JSON.stringify(result.content)).toContain("System One semantic completion gate rejected");
		expect(JSON.stringify(result.content)).toContain("Unsatisfied acceptance criteria: AC-1");
		expect(currentState.status).toBe("active");
	});

	it("allows goal complete transition when System One approves", async () => {
		const systemOne = createMockSystemOne({
			completionOutcome: "approve",
		});

		const goalState = createGoalState({
			goalId: "goal-test-2",
			userGoal: "Ship feature",
			now: "2026-01-01T00:00:00.000Z",
		});
		goalState.requirements = [
			{
				id: "req-1",
				text: "Working code",
				status: "satisfied",
				evidenceIds: ["ev-1"],
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		];
		goalState.evidence = [
			{
				id: "ev-1",
				kind: "test",
				summary: "All unit tests pass",
				verified: true,
				outcome: "succeeded",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		];

		let currentState = goalState;
		const goalTool = createGoalToolDefinition({
			getGoalState: () => currentState,
			saveGoalState: (s) => {
				currentState = s;
				return "rev-1";
			},
			getSystemOneController: () => systemOne,
		});

		const result = await goalTool.execute(
			"call-goal-2",
			{ action: "complete" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.isError).toBeFalsy();
		expect((result.details as any)?.applied).toBe(true);
		expect(currentState.status).toBe("completed");
	});

	it("revalidates repository revision and invalidates stale evidence upon session resume (R-062)", () => {
		const store = new ExecutionStore({
			run_id: "resume-test-run",
			objective: {
				request: "Fix bug",
				normalized_goal: "Fix checkout bug",
				acceptance_criteria: [],
				constraints: [],
			},
			repo: {
				root: "/workspace",
				baseline_revision: "git-rev-100",
				current_revision: "git-rev-100",
			},
		});

		const obs = store.recordObservation({
			text: "Observed checkout retry logic",
			source: {
				kind: "file",
				locator: "src/checkout.ts",
				content_hash: "hash123",
				revision: "git-rev-100",
				trust: "repository_untrusted_text",
			},
		});

		const claim = store.recordClaim({
			text: "Checkout has idempotent retry",
			materiality: "completion_critical",
			evidence_ids: [obs.id],
		});
		store.updateClaimStatus(claim.id, "supported");

		const controller = new SystemOneController({
			store,
			adapter: { evaluate: vi.fn() as any },
		});

		// First, resume with unchanged revision
		const unchanged = executeSystemOneResumeRevalidation(controller, "/workspace", "git-rev-100");
		expect(unchanged?.revisionChanged).toBe(false);
		expect(unchanged?.invalidatedObservations).toBe(0);
		expect(unchanged?.invalidatedClaims).toBe(0);

		// Now resume with changed revision (e.g. user or other branch updated HEAD)
		const changed = executeSystemOneResumeRevalidation(controller, "/workspace", "git-rev-200");
		expect(changed?.revisionChanged).toBe(true);
		expect(changed?.invalidatedObservations).toBe(1);
		expect(changed?.invalidatedClaims).toBe(1);

		const snapshot = store.snapshot();
		expect(snapshot.repo.current_revision).toBe("git-rev-200");
		expect(snapshot.observations.find((o) => o.id === obs.id)?.freshness).toBe("invalidated");
		expect(snapshot.claims.find((c) => c.id === claim.id)?.status).toBe("unverified");
	});

	it("handles undefined controller gracefully in executeSystemOneResumeRevalidation", () => {
		const result = executeSystemOneResumeRevalidation(undefined, "/workspace", "rev-1");
		expect(result).toBeUndefined();
	});
});
