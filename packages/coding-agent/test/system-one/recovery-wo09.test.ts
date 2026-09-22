import { SessionManager } from "@caupulican/pi-agent-core/session";
import { describe, expect, it } from "vitest";
import { executeSystemOnePreflight } from "../../src/core/agent-session-guards.ts";
import { GoalSessionController } from "../../src/core/goals/goal-session-controller.ts";
import { applyGoalEvent, createGoalState } from "../../src/core/goals/goal-state.ts";
import { ObjectiveExecutionController } from "../../src/core/objective-execution/objective-execution-controller.ts";
import { composeObjectiveRoute } from "../../src/core/objective-execution/objective-route-policy.ts";
import type { TaskRuntimeProjection } from "../../src/core/orchestration/task-runtime-state.ts";
import { DEFAULT_STEERING_POLICY } from "../../src/core/steering/policy.ts";
import {
	SystemOneSteeringPlane,
	SystemOneSteeringUnavailableError,
} from "../../src/core/steering/system-one-steering-plane.ts";
import { projectCanonicalTruth } from "../../src/core/system-one/canonical-truth.ts";
import { directiveFromPreflight } from "../../src/core/system-one/control-directive.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { ToolGateController } from "../../src/core/tool-gate-controller.ts";

function emptyStore(runId: string): ExecutionStore {
	return new ExecutionStore({
		run_id: runId,
		objective: { request: "", normalized_goal: "", acceptance_criteria: [], constraints: [] },
		repo: { root: "/repo", baseline_revision: "rev-0", current_revision: "rev-0" },
	});
}

function goalWithRequirement() {
	const started = createGoalState({ goalId: "fix-parser", userGoal: "Fix the parser", now: "T0" });
	return applyGoalEvent(started, {
		type: "add_requirement",
		id: "R1",
		text: "Parse empty input without throwing",
		now: "T0",
	});
}

describe("System One recovery WO-09 production paths", () => {
	it("resume reconstructs the same requirements from canonical goal truth, not the empty constructor store", () => {
		const goal = goalWithRequirement();
		const truth = () => projectCanonicalTruth({ goal, currentRevision: "rev-1" });
		const first = new SystemOneController({
			store: emptyStore("run-1"),
			adapter: { evaluate: async () => ({ model: "jev-1.13.0", answers: {}, latency_ms: 1 }) },
			truthSource: truth,
		});
		first.syncCanonicalTruth();
		const ids = first.store.getObjective().acceptance_criteria.map((criterion) => criterion.id);
		const resumed = new SystemOneController({
			store: emptyStore("run-1-resumed"),
			adapter: { evaluate: async () => ({ model: "jev-1.13.0", answers: {}, latency_ms: 1 }) },
			truthSource: truth,
		});
		resumed.syncCanonicalTruth();
		expect(resumed.store.getObjective().acceptance_criteria.map((criterion) => criterion.id)).toEqual(ids);
		expect(resumed.hasLiveObjective()).toBe(true);
	});

	it("hydrates live goal requirements into the ExecutionStore the gates read", () => {
		const store = emptyStore("hydrate");
		const goal = goalWithRequirement();
		const controller = new SystemOneController({
			store,
			adapter: { evaluate: async () => ({ model: "jev-1.13.0", answers: {}, latency_ms: 1 }) },
			truthSource: () =>
				projectCanonicalTruth({
					goal,
					currentRevision: "rev-1",
				}),
		});
		controller.syncCanonicalTruth();
		expect(controller.hasLiveObjective()).toBe(true);
		const objective = store.getObjective();
		expect(objective.request).toBe("Fix the parser");
		expect(objective.acceptance_criteria).toEqual([
			expect.objectContaining({
				id: "R1",
				text: "Parse empty input without throwing",
				required: true,
				status: "unverified",
			}),
		]);
	});

	it("a real objective with unsatisfied criteria cannot complete from the hydrated store", async () => {
		const store = emptyStore("complete-empty");
		const controller = new SystemOneController({
			store,
			adapter: {
				evaluate: async () => ({
					model: "jev-1.13.0",
					answers: { implementation_matches_goal: { noul: 0.99 } },
					latency_ms: 1,
				}),
			},
			truthSource: () => projectCanonicalTruth({ goal: goalWithRequirement(), currentRevision: "rev-1" }),
		});
		const result = await controller.executeCompletionTransaction(false);
		expect(result.verdict).toBe("rework");
		expect(result.failed_gates.some((gate) => gate.id === "G-OBJ")).toBe(true);
		expect(store.phase).not.toBe("complete");
	});

	it("failing verification obligations reach completion as G-TEST or G-VERIFY", async () => {
		const store = emptyStore("verify-fail");
		const goal = goalWithRequirement();
		const satisfied = applyGoalEvent(goal, {
			type: "satisfy_requirement",
			id: "R1",
			evidenceIds: ["e1"],
			now: "T1",
		});
		const controller = new SystemOneController({
			store,
			adapter: { evaluate: async () => ({ model: "jev-1.13.0", answers: {}, latency_ms: 1 }) },
			truthSource: () =>
				projectCanonicalTruth({
					goal: satisfied,
					verificationObligations: [{ id: "v-test", command: "npm test" }],
					currentRevision: "rev-1",
				}),
		});
		const result = await controller.executeCompletionTransaction(false);
		expect(result.verdict).toBe("rework");
		expect(result.failed_gates.some((gate) => gate.id === "G-TEST" || gate.id === "G-VERIFY")).toBe(true);
	});

	it("tool-gate replan is stored as refused, never allowed", async () => {
		const store = new ExecutionStore({
			run_id: "replan-status",
			objective: {
				request: "Fix the parser",
				normalized_goal: "Fix the parser",
				acceptance_criteria: [{ id: "R1", text: "done", required: true }],
				constraints: [],
			},
			repo: { root: "/repo", baseline_revision: "rev-0" },
		});
		const controller = new SystemOneController({
			store,
			adapter: {
				evaluate: async () => ({
					model: "jev-1.13.0",
					answers: {
						repo_text_injection_like: { noul: 0.01 },
						tool_call_relevant: { noul: 0.02 },
						tool_call_semantic_scope_risk: { score: 0, confidence: 0.9 },
					},
					latency_ms: 1,
				}),
			},
		});
		const result = await controller.validateToolGate({
			tool: "bash",
			intent: "Invoke tool bash",
			impact: "local_reversible",
			call_id: "call-1",
		});
		expect(result.outcome).toBe("replan");
		expect(store.snapshot().tool_events.at(-1)?.status).toBe("refused");
		expect(store.snapshot().tool_events.at(-1)?.call_id).toBe("call-1");
		expect(controller.peekControlDirective()?.objectiveRoute).toBe("replan");
	});

	it("one-call replan refuses only that call_id; a sibling admission stays allowed then succeeded", async () => {
		const store = new ExecutionStore({
			run_id: "siblings",
			objective: {
				request: "Fix the parser",
				normalized_goal: "Fix the parser",
				acceptance_criteria: [{ id: "R1", text: "done", required: true }],
				constraints: [],
			},
			repo: { root: "/repo", baseline_revision: "rev-0" },
		});
		let relevance = 0.02;
		const controller = new SystemOneController({
			store,
			adapter: {
				evaluate: async () => ({
					model: "jev-1.13.0",
					answers: {
						repo_text_injection_like: { noul: 0.01 },
						tool_call_relevant: { noul: relevance },
						tool_call_semantic_scope_risk: { score: 0, confidence: 0.9 },
					},
					latency_ms: 1,
				}),
			},
		});
		const first = await controller.validateToolGate({
			tool: "bash",
			intent: "off-mission",
			impact: "read_only",
			call_id: "call-a",
		});
		relevance = 0.99;
		const second = await controller.validateToolGate({
			tool: "read",
			intent: "on-mission",
			impact: "read_only",
			call_id: "call-b",
		});
		expect(first.outcome).toBe("replan");
		expect(second.outcome).toBe("allow");
		controller.recordToolTerminal({ call_id: "call-b", succeeded: true, output: "ok" });
		const events = store.snapshot().tool_events;
		expect(events.find((event) => event.call_id === "call-a")?.status).toBe("refused");
		expect(events.find((event) => event.call_id === "call-b")?.status).toBe("succeeded");
	});

	it("a no-goal session skips preflight Jev and proceeds", async () => {
		let called = 0;
		const controller = new SystemOneController({
			store: emptyStore("plain"),
			adapter: {
				evaluate: async () => {
					called++;
					return { model: "jev-1.13.0", answers: {}, latency_ms: 1 };
				},
			},
		});
		const result = await executeSystemOnePreflight(controller, 0);
		expect(result.proceed).toBe(true);
		expect(called).toBe(0);
	});

	it("preflight retrieve on a live objective records the directive and still runs the turn", async () => {
		const store = emptyStore("preflight-retrieve");
		const controller = new SystemOneController({
			store,
			adapter: {
				evaluate: async () => ({
					model: "jev-1.13.0",
					answers: {
						step_relevant: { noul: 0.99 },
						unsupported_assumption_present: { noul: 0.01 },
						evidence_sufficient_to_act: { noul: 0.02 },
						route: { choice: "retrieve", confidence: 0.95, probabilities: { retrieve: 0.95 } },
					},
					latency_ms: 1,
				}),
			},
			truthSource: () => projectCanonicalTruth({ goal: goalWithRequirement(), currentRevision: "rev-1" }),
		});
		const result = await executeSystemOnePreflight(controller, 0);
		expect(result.proceed).toBe(true);
		expect(controller.peekControlDirective()?.objectiveRoute).toBe("retrieve");
	});

	it("enables capabilities only on a hard yes and leaves a failed classification unset", async () => {
		const controller = new SystemOneController({
			store: emptyStore("authorize"),
			adapter: {
				evaluate: async () => ({
					model: "jev-1.13.0",
					answers: { capabilities_authorized: { noul: 0.99 } },
					latency_ms: 1,
				}),
			},
		});
		expect(await controller.classifyUserRequest("commit and push this")).toEqual({
			capabilitiesAuthorized: true,
			localCommitsOnly: false,
			liftsDeliveryBlock: false,
			rulesDiffer: false,
			overridesWrittenRules: false,
			fullHandoff: false,
			requestHolds: false,
		});
		expect(await controller.classifyUserRequest("   ")).toBeUndefined();
		const denied = new SystemOneController({
			store: emptyStore("authorize-no"),
			adapter: {
				evaluate: async () => ({
					model: "jev-1.13.0",
					answers: { capabilities_authorized: { noul: 0.5 } },
					latency_ms: 1,
				}),
			},
		});
		expect(await denied.classifyUserRequest("what does this function do")).toEqual({
			capabilitiesAuthorized: false,
			localCommitsOnly: false,
			liftsDeliveryBlock: false,
			rulesDiffer: false,
			overridesWrittenRules: false,
			fullHandoff: false,
			requestHolds: false,
		});
		const down = new SystemOneController({
			store: emptyStore("authorize-down"),
			adapter: {
				evaluate: async () => {
					throw new Error("unavailable");
				},
			},
		});
		expect(await down.classifyUserRequest("commit and push this")).toBeUndefined();
	});

	it("evaluateRouteOnce keeps a retrieve directive through wait_for_worker and owner_required, then reroutes", async () => {
		const systemOne = new SystemOneController({
			store: emptyStore("directive-after-wait"),
			adapter: { evaluate: async () => ({ model: "jev-1.13.0", answers: {}, latency_ms: 1 }) },
		});
		const pending = directiveFromPreflight("retrieve");
		if (!pending) throw new Error('directiveFromPreflight("retrieve") must return a directive');
		systemOne.noteControlDirective(pending);

		let workerInFlight = true;
		let ownerRequired = false;
		const runtimeSnapshot = (): TaskRuntimeProjection =>
			({
				lastOrdinal: 1,
				agents: {},
				objectives: {},
				tasks: {},
				attempts: workerInFlight
					? {
							a1: {
								attemptId: "a1",
								taskId: "t1",
								status: "running",
								dispatch: {},
								checkpointIds: [],
								createdAt: "T0",
								updatedAt: "T0",
							},
						}
					: {},
				checkpoints: {},
				approvals: {},
				notifications: {},
			}) as TaskRuntimeProjection;

		const controller = new ObjectiveExecutionController({
			mode: "objective_primary",
			runtime: { reconcileObjective: async () => runtimeSnapshot() },
			ownerRequired: () => ownerRequired,
			systemOne: {
				peekControlDirective: () => systemOne.peekControlDirective(),
				consumeControlDirective: () => systemOne.consumeControlDirective(),
				noteControlDirective: (directive) => systemOne.noteControlDirective(directive),
			},
		});

		const waiting = await controller.evaluateRouteOnce("goal:fix-parser");
		expect(waiting.route).toBe("wait_for_worker");
		expect(systemOne.peekControlDirective()?.objectiveRoute).toBe("retrieve");

		workerInFlight = false;
		ownerRequired = true;
		const blocked = await controller.evaluateRouteOnce("goal:fix-parser");
		expect(blocked.route).toBe("owner_required");
		expect(systemOne.peekControlDirective()?.objectiveRoute).toBe("retrieve");

		ownerRequired = false;
		const retrieved = await controller.evaluateRouteOnce("goal:fix-parser");
		expect(retrieved.route).toBe("retrieve");
		expect(retrieved.reason_codes).toContain("system_one_preflight_retrieve");
		expect(systemOne.peekControlDirective()).toBeUndefined();
	});

	it("composeObjectiveRoute executes a System One retrieve directive after waits/owner checks", () => {
		const route = composeObjectiveRoute({
			cycleId: "c1",
			objectiveId: "goal:fix-parser",
			systemOneDirective: {
				objectiveRoute: "retrieve",
				reasonCodes: ["system_one_preflight_retrieve"],
			},
		});
		expect(route.route).toBe("retrieve");
		expect(route.reason_codes).toContain("system_one_preflight_retrieve");
	});

	it("objective_primary without a live controller fails closed instead of running the legacy loop", async () => {
		const sessionManager = SessionManager.inMemory("/repo");
		const controller = new GoalSessionController({
			getSessionManager: () => sessionManager,
			getModelProvider: () => undefined,
			getLaneRecords: () => [],
			getTaskRuntimeSnapshot: () => undefined,
			getBackgroundToolTasks: () => [],
			synchronizeGoalState: () => {},
			scheduleGoalAutoContinueFromIdle: () => {},
			prompt: async () => {
				throw new Error("legacy loop must not run");
			},
			emitWarning: () => {},
			getExecutionLoopMode: () => "objective_primary",
		});
		controller.saveState(goalWithRequirement());
		await expect(controller.continueOnce({ maxStallTurns: 3 })).rejects.toThrow(
			"missing required binding 'ObjectiveExecutionController'",
		);
	});

	it("system_one_required rejects synthetic_self_report as a required checkpoint success", async () => {
		const plane = new SystemOneSteeringPlane({
			policy: DEFAULT_STEERING_POLICY,
			router: {
				evaluateOrFallback: async () => ({
					schema_version: "2.0",
					program: { id: "p", version: "1" },
					engine: {
						id: "structured-llm",
						model: "mock-llm",
						confidence_provenance: "synthetic_self_report",
					},
					results: { work_remaining: { kind: "boolean", value: true } },
					timestamp: new Date().toISOString(),
				}),
			} as never,
		});
		await expect(
			plane.requireCertificate("JEV-004", { objectiveId: "goal:x" }, { objectiveId: "goal:x" }),
		).rejects.toBeInstanceOf(SystemOneSteeringUnavailableError);
		await expect(
			plane.requireCertificate("JEV-004", { objectiveId: "goal:x" }, { objectiveId: "goal:x" }),
		).rejects.toThrow(/synthetic_self_report/);
	});

	it("ToolGateController afterToolCall writes succeeded onto the matching call_id", async () => {
		const store = new ExecutionStore({
			run_id: "terminal",
			objective: {
				request: "Fix the parser",
				normalized_goal: "Fix the parser",
				acceptance_criteria: [{ id: "R1", text: "done", required: true }],
				constraints: [],
			},
			repo: { root: "/repo", baseline_revision: "rev-0" },
		});
		const systemOne = new SystemOneController({
			store,
			adapter: {
				evaluate: async () => ({
					model: "jev-1.13.0",
					answers: {
						repo_text_injection_like: { noul: 0.01 },
						tool_call_relevant: { noul: 0.99 },
						tool_call_semantic_scope_risk: { score: 0, confidence: 0.9 },
					},
					latency_ms: 1,
				}),
			},
		});
		const gate = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => "/repo",
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => {},
			getExtensionRunner: () => ({ hasHandlers: () => false }) as never,
			getSystemOneController: () => systemOne,
		});
		const before = await gate.beforeToolCall({
			toolCall: { id: "call-term", name: "read" } as never,
			args: { path: "src/index.ts" },
			assistantMessage: { provider: "test", model: "test" } as never,
			context: { messages: [] } as never,
		});
		expect(before?.block).toBeFalsy();
		await gate.afterToolCall({
			toolCall: { id: "call-term", name: "read" } as never,
			args: { path: "src/index.ts" },
			result: { content: [{ type: "text", text: "ok" }], details: undefined, isError: false },
			isError: false,
			executionContext: {} as never,
		} as never);
		expect(store.snapshot().tool_events.find((event) => event.call_id === "call-term")?.status).toBe("succeeded");
	});
});
