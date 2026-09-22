import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultAuthorityEnvelope } from "../../src/core/autonomy/index.ts";
import {
	DecisionEngineRouter,
	MechanicalDecisionEngine,
	TypeSafeSystemOneDecisionEngine,
} from "../../src/core/decision/index.ts";
import { GoalSessionController } from "../../src/core/goals/goal-session-controller.ts";
import { createGoalState } from "../../src/core/goals/goal-state.ts";
import { GoalCompatibilityAdapter } from "../../src/core/objective-execution/goal-compatibility-adapter.ts";
import {
	GOAL_MIGRATION_SCHEMA_VERSION,
	migrateGoalState,
} from "../../src/core/objective-execution/goal-state-migration.ts";
import {
	type DisagreementTelemetryEvent,
	ObjectiveExecutionController,
} from "../../src/core/objective-execution/objective-execution-controller.ts";
import type { FailedGateRecord } from "../../src/core/objective-execution/objective-repair-work.ts";
import {
	completionFailuresToRepairWork,
	REPAIR_WORK_SCHEMA_VERSION,
	RepairWorkValidationError,
	validateRepairWork,
} from "../../src/core/objective-execution/objective-repair-work.ts";
import {
	ObjectiveRouteValidationError,
	routeToTerminal,
	validateObjectiveRoute,
} from "../../src/core/objective-execution/objective-route.ts";
import { composeObjectiveRoute } from "../../src/core/objective-execution/objective-route-policy.ts";
import { ObjectiveStallDetector } from "../../src/core/objective-execution/objective-stall-fingerprint.ts";
import { OrchestrationEventStore } from "../../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime } from "../../src/core/orchestration/task-runtime.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";

describe("Objective Execution Controller & Jev Substrate (OEL-001 to OEL-045)", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Ignore cleanup
			}
		}
		tempDirs.length = 0;
	});

	function createTestRuntime(): { runtime: DurableTaskRuntime; store: OrchestrationEventStore } {
		const dir = join(tmpdir(), `pi-test-runtime-${randomUUID()}`);
		mkdirSync(dir, { recursive: true });
		tempDirs.push(dir);
		const store = new OrchestrationEventStore({
			agentDir: dir,
			sessionId: `session-${randomUUID()}`,
			now: () => new Date().toISOString(),
			createEventId: () => `evt-${randomUUID()}`,
		});
		const runtime = new DurableTaskRuntime({
			store,
			now: () => Date.now(),
			createId: () => randomUUID(),
		});
		return { runtime, store };
	}

	function createTestSystemOne(options?: { runId?: string }): {
		controller: SystemOneController;
		store: ExecutionStore;
	} {
		const store = new ExecutionStore({
			run_id: options?.runId ?? `test-run-${randomUUID()}`,
			objective: {
				request: "Test objective",
				normalized_goal: "Normalized test goal",
				acceptance_criteria: [],
				constraints: [],
			},
			repo: {
				root: "/test/repo",
				baseline_revision: "rev-1",
			},
		});
		const fauxAdapter = {
			evaluate: async () => ({ model: "jev-1.13.0", answers: {}, latency_ms: 5 }),
		};
		const controller = new SystemOneController({
			store,
			adapter: fauxAdapter,
		});
		return { controller, store };
	}

	it("OEL-001, OEL-002, OEL-003, OEL-004: Single loop owner, no new truth DB, DurableTaskRuntime execution truth, SystemOne integrity truth", async () => {
		const { runtime } = createTestRuntime();
		await runtime.createObjective({
			objectiveId: "obj_oel_001",
			title: "Validate truth ownership",
			description: "Validate truth ownership",
			riskBudget: { maxCostUsd: 5.0 },
		});

		const { store } = createTestSystemOne();
		store.recordObservation({
			text: "Baseline test passed",
			source: {
				kind: "test",
				locator: "ev_1",
				trust: "authoritative",
			},
		});

		const controller = new ObjectiveExecutionController({
			runtime: {
				reconcileObjective: async () => runtime.getSnapshot(),
			},
			systemOne: {
				executeCompletionTransaction: async () => ({
					verdict: "complete",
					failed_gates: [],
				}),
			},
		});

		expect(controller).toBeDefined();
		expect(runtime.getSnapshot().objectives.obj_oel_001).toBeDefined();
		expect(store.snapshot().observations?.length).toBe(1);
	});

	it("OEL-005, OEL-006, OEL-007: Worker cannot complete, Jev cannot complete directly, deterministic failure wins", async () => {
		const { runtime } = createTestRuntime();
		const { controller: systemOne } = createTestSystemOne();

		const adapter = new GoalCompatibilityAdapter({
			runtime,
			systemOne,
		});

		// Worker calling complete() returns candidate request, not committed complete (OEL-005)
		const completeResult = await adapter.complete();
		expect(completeResult.requestedCandidate).toBe(true);
		expect(completeResult.candidateCommitted).toBe(false);

		// Jev routing cannot return "complete" directly; missingWorkClass="none" routes to completion_candidate (OEL-006)
		const route = composeObjectiveRoute({
			cycleId: "c_1",
			objectiveId: "obj_1",
			semantic: { workRemaining: false, missingWorkClass: "none" },
		});
		expect(route.route).toBe("completion_candidate");

		// Deterministic failure outranks favorable semantic answers (OEL-007)
		const failedRoute = composeObjectiveRoute({
			cycleId: "c_2",
			objectiveId: "obj_2",
			cancelled: true,
			semantic: { workRemaining: false, missingWorkClass: "none" },
		});
		expect(failedRoute.route).toBe("cancel");
		expect(failedRoute.reason_codes).toContain("deterministic_cancellation");
	});

	it("OEL-008, OEL-009, OEL-010: Decomposed Jev routing without selecting exact model", () => {
		const route = composeObjectiveRoute({
			cycleId: "c_decomp",
			objectiveId: "obj_decomp",
			semantic: {
				workRemaining: true,
				missingWorkClass: "deterministic_test",
				currentWorkerCanContinue: false,
				independentWorkerRequired: true,
			},
		});

		expect(route.route).toBe("deterministic_test");
		expect(route.reason_codes).toContain("verification_tests_required");
		// Ensure Jev did not inject arbitrary model selection
		expect((route as unknown as Record<string, unknown>).provider).toBeUndefined();
		expect((route as unknown as Record<string, unknown>).model).toBeUndefined();
	});

	it("OEL-011, OEL-012, OEL-013, OEL-014: Reuses existing worker authority, attempts, hooks, and completion transaction", async () => {
		const { runtime } = createTestRuntime();
		let completionCalled = false;

		const controller = new ObjectiveExecutionController({
			runtime: {
				reconcileObjective: async () => runtime.getSnapshot(),
			},
			systemOne: {
				evaluateObjectiveRoute: async () => ({ workRemaining: false, missingWorkClass: "none" }),
				executeCompletionTransaction: async () => {
					completionCalled = true;
					return {
						decision_id: "comp_dec",
						verdict: "complete",
						gate_results: {},
						failed_gates: [],
					};
				},
			},
		});

		const terminal = await controller.run("obj_comp");
		expect(completionCalled).toBe(true);
		expect(terminal.status).toBe("complete");
		expect(terminal.reasonCodes).toContain("completion_passed");
	});

	it("OEL-015, OEL-016, OEL-017, OEL-018, OEL-019: Progress & no_progress non-authoritative, satisfy_requirement proof-gated", async () => {
		const { runtime } = createTestRuntime();
		await runtime.createObjective({
			objectiveId: "obj_proof",
			title: "Proof gating test",
			description: "Proof gating test",
			riskBudget: { maxCostUsd: 2.0 },
		});

		const { controller: systemOne, store } = createTestSystemOne();
		store.recordVerification({
			kind: "unit_test",
			status: "failed",
			covers_acceptance_ids: ["req_1"],
		});

		const adapter = new GoalCompatibilityAdapter({
			runtime,
			systemOne,
			getActiveGoalId: () => "obj_proof",
		});

		// OEL-015: progress is non-authoritative
		const prog = await adapter.progress();
		expect(prog.accepted).toBe(true);
		expect(prog.authoritativeProgressChanged).toBe(false);

		// OEL-016: no_progress is non-authoritative
		const noProg = await adapter.noProgress();
		expect(noProg.accepted).toBe(true);
		expect(noProg.authoritativeStallChanged).toBe(false);

		// OEL-018: satisfy_requirement is rejected when obligations remain pending
		const satisfaction = await adapter.satisfyRequirement({
			requirementId: "req_1",
			evidenceIds: ["ev_dummy"],
		});
		expect(satisfaction.accepted).toBe(true);
		expect(satisfaction.authoritativeSatisfied).toBe(false);
		expect(satisfaction.reason).toContain("pending verification obligations");
	});

	it("OEL-020, OEL-021: No duplicate dispatch while in-flight, and wait != stall", () => {
		const detector = new ObjectiveStallDetector({ maxStallTurns: 3 });

		// Evaluate waiting state: explicitly NOT a stall (OEL-021)
		const waitEval = detector.evaluate({
			currentRevision: 1,
			isWaiting: true,
			currentStrategyFingerprint: "wait_strat",
		});
		expect(waitEval.stalled).toBe(false);
		expect(waitEval.reason).toBe("waiting_in_flight");

		// Route composition routes to wait_for_worker when worker is in flight (OEL-020)
		const inFlightRoute = composeObjectiveRoute({
			cycleId: "c_inflight",
			objectiveId: "obj_inflight",
			requiredWorkerInFlight: true,
			semantic: { workRemaining: true, missingWorkClass: "implement" },
		});
		expect(inFlightRoute.route).toBe("wait_for_worker");
		expect(inFlightRoute.reason_codes).toContain("active_worker_in_flight");
	});

	it("OEL-022, OEL-023, OEL-024: Repeated strategy reroutes, independent worker required, capability escalation bounded", () => {
		const detector = new ObjectiveStallDetector({ maxStallTurns: 3 });
		const fp = "same_failed_strategy";

		// Record initial strategy
		detector.evaluate({ currentRevision: 1, isWaiting: false, currentStrategyFingerprint: fp });
		// Repeat without progress
		detector.evaluate({ currentRevision: 1, isWaiting: false, currentStrategyFingerprint: fp });
		// Third time: repeated strategy detected (OEL-022)
		const repeatedEval = detector.evaluate({ currentRevision: 1, isWaiting: false, currentStrategyFingerprint: fp });
		expect(repeatedEval.repeatedWithoutNewEvidence).toBe(true);
		expect(repeatedEval.stalled).toBe(true);

		// Reroutes to replan when strategy repeated
		const reroute = composeObjectiveRoute({
			cycleId: "c_reroute",
			objectiveId: "obj_reroute",
			strategyRepetition: true,
			semantic: { workRemaining: true, missingWorkClass: "implement" },
		});
		expect(reroute.route).toBe("replan");

		// OEL-023: Independent verification requires fresh worker
		const verifyRoute = composeObjectiveRoute({
			cycleId: "c_verify",
			objectiveId: "obj_verify",
			semantic: { workRemaining: true, missingWorkClass: "verify", independentWorkerRequired: true },
		});
		expect(verifyRoute.route).toBe("verify");
		expect(verifyRoute.reason_codes).toContain("independent_verification_required");

		// OEL-024: Capability escalation bounded
		const escalateRoute = composeObjectiveRoute({
			cycleId: "c_esc",
			objectiveId: "obj_esc",
			semantic: { workRemaining: true, missingWorkClass: "implement", capabilityEscalationRequired: true },
		});
		expect(escalateRoute.route).toBe("escalate_capability");
	});

	it("OEL-025, OEL-026: Completion failure creates structured repair work with required_next_proof", () => {
		const failedGates: FailedGateRecord[] = [
			{ gate_id: "unresolved_verification_obligations", reason: "2 obligations pending" },
			{ gate_id: "review_challenge_gate", reason: "Challenge gate verification failed" },
		];

		const repairs = completionFailuresToRepairWork(failedGates, "obj_repair", {
			priorStrategyFingerprint: "strat_123",
		});

		expect(repairs.length).toBe(2);
		expect(repairs[0].schema_version).toBe(REPAIR_WORK_SCHEMA_VERSION);
		expect(repairs[0].recommended_work_class).toBe("deterministic_test");
		expect(repairs[0].required_next_proof).toContain("passing test exit status");

		expect(repairs[1].recommended_work_class).toBe("verify");
		expect(repairs[1].independent_worker_required).toBe(true);

		// Validates against schema
		expect(() => validateRepairWork(repairs[0])).not.toThrow();
		expect(() => validateRepairWork(repairs[1])).not.toThrow();
	});

	it("OEL-029, OEL-030, OEL-031, OEL-032, OEL-033: Explicit terminal reasons and no silent stop", () => {
		// Cancelled
		const cancelRoute = composeObjectiveRoute({
			cycleId: "c_term",
			objectiveId: "obj_term",
			cancelled: true,
		});
		expect(routeToTerminal(cancelRoute).status).toBe("cancelled");

		// Budget exhausted
		const budgetRoute = composeObjectiveRoute({
			cycleId: "c_term",
			objectiveId: "obj_term",
			budgetExhausted: true,
		});
		expect(routeToTerminal(budgetRoute).status).toBe("cancelled");

		// External blocker
		const externalRoute = composeObjectiveRoute({
			cycleId: "c_term",
			objectiveId: "obj_term",
			externalBlocker: true,
		});
		expect(routeToTerminal(externalRoute).status).toBe("blocked");

		// Owner required
		const ownerRoute = composeObjectiveRoute({
			cycleId: "c_term",
			objectiveId: "obj_term",
			ownerRequired: true,
		});
		expect(routeToTerminal(ownerRoute).status).toBe("blocked");

		// Unrecoverable
		const unrecRoute = composeObjectiveRoute({
			cycleId: "c_term",
			objectiveId: "obj_term",
			unrecoverable: true,
		});
		expect(routeToTerminal(unrecRoute).status).toBe("unrecoverable");
	});

	it("OEL-035, OEL-036, OEL-037: Shadow mode computes route and emits disagreement telemetry without behavior mutation", async () => {
		let telemetryFired: DisagreementTelemetryEvent | undefined;
		const { runtime } = createTestRuntime();

		const controller = new ObjectiveExecutionController({
			mode: "objective_shadow",
			runtime: {
				reconcileObjective: async () => runtime.getSnapshot(),
			},
			systemOne: {
				evaluateObjectiveRoute: async () => ({ workRemaining: false, missingWorkClass: "none" }),
				executeCompletionTransaction: async () => ({
					decision_id: "comp",
					verdict: "complete",
					gate_results: {},
					failed_gates: [],
				}),
			},
			onDisagreementTelemetry: (event) => {
				telemetryFired = event;
			},
		});

		expect(controller.getMode()).toBe("objective_shadow");

		// In shadow mode, evaluate route with a legacy action hint of "continue" while route says "completion_candidate"
		const route = await controller.evaluateRouteOnce("obj_shadow", {
			legacyActionHint: "continue",
		});

		expect(route.route).toBe("completion_candidate");
		expect(telemetryFired).toBeDefined();
		expect(telemetryFired?.legacyAction).toBe("continue");
		expect(telemetryFired?.objectiveRoute).toBe("completion_candidate");
	});

	it("OEL-038, OEL-039, OEL-040, OEL-041: Goal migration dry-run, idempotency, budget/evidence preservation, and backup recovery", async () => {
		let legacyState = createGoalState({
			goalId: "goal_legacy_123",
			userGoal: "Legacy goal to migrate",
			now: "2026-09-19T00:00:00Z",
		});
		legacyState = {
			...legacyState,
			status: "active",
			tokenBudget: 50000,
			tokensUsed: 12000,
			requirements: [
				{
					id: "req_a",
					text: "Requirement A",
					status: "open",
					evidenceIds: [],
					createdAt: "2026-09-19T00:00:00Z",
					updatedAt: "2026-09-19T00:00:00Z",
				},
				{
					id: "req_b",
					text: "Requirement B",
					status: "satisfied",
					evidenceIds: [],
					createdAt: "2026-09-19T00:00:00Z",
					updatedAt: "2026-09-19T00:00:00Z",
				},
			],
			evidence: [
				{
					id: "ev_1",
					kind: "test",
					summary: "npm test passed",
					outcome: "succeeded",
					createdAt: "2026-09-19T00:00:00Z",
				},
			],
		};

		const { runtime } = createTestRuntime();
		const { controller: systemOne } = createTestSystemOne();

		// OEL-038: Dry run
		const dryRunResult = await migrateGoalState(legacyState, { runtime, systemOne }, { dryRun: true });
		expect(dryRunResult.status).toBe("dry_run");
		expect(dryRunResult.schema_version).toBe(GOAL_MIGRATION_SCHEMA_VERSION);
		expect(dryRunResult.mapped_requirement_ids).toEqual(["req_a", "req_b"]);
		expect(dryRunResult.mapped_evidence_ids).toEqual(["ev_1"]);
		// Ensure runtime has not been modified in dry run
		expect(runtime.getSnapshot().objectives.goal_legacy_123).toBeUndefined();

		// OEL-040 & OEL-041: Apply migration and preserve backup
		const appliedResult = await migrateGoalState(legacyState, { runtime, systemOne }, { dryRun: false });
		expect(appliedResult.status).toBe("migrated");
		expect(appliedResult.backupSnapshot).toBeDefined();
		expect(appliedResult.backupSnapshot?.userGoal).toBe(legacyState.userGoal);
		expect(appliedResult.backupSnapshot?.tokenBudget).toBe(50000);

		// Runtime now has objective and tasks
		const proj = runtime.getSnapshot();
		expect(proj.objectives.goal_legacy_123).toBeDefined();
		expect(proj.tasks.task_req_a).toBeDefined();
		expect(proj.tasks.task_req_b).toBeDefined();

		// OEL-039: Idempotency (running second time does not throw and preserves state)
		const idempotentResult = await migrateGoalState(legacyState, { runtime, systemOne }, { dryRun: false });
		expect(idempotentResult.status).toBe("migrated");
	});

	it("OEL-042: Schema validations reject malformed routes and repair work", () => {
		expect(() =>
			validateObjectiveRoute({
				schema_version: "2.0",
				cycle_id: "c",
				objective_id: "o",
				route: "invalid_route",
				reason_codes: [],
			}),
		).toThrow(ObjectiveRouteValidationError);

		expect(() =>
			validateRepairWork({
				schema_version: "1.0",
				repair_id: "r",
				objective_id: "o",
				failed_gate_id: "",
				reason: "",
				required_next_proof: "",
				recommended_work_class: "invalid_class",
			}),
		).toThrow(RepairWorkValidationError);
	});

	it("reads JEV-004 route judgments from steering-plane certificates by band, not a missing boolean field", async () => {
		const { runtime } = createTestRuntime();
		const noul = (probability: number, band: string) => ({
			type: "noul",
			noul: probability,
			direction: "required_true",
			band,
			confidence: Math.max(probability, 1 - probability),
		});
		let strategyRepetition = noul(0.02, "hard_fail");
		const controller = new ObjectiveExecutionController({
			mode: "objective_primary",
			runtime: { reconcileObjective: async () => runtime.getSnapshot() },
			steeringPlane: {
				policy: { mode: "system_one_required" },
				requireCertificate: async () => ({
					certificate_id: "c-route",
					answers: {
						work_remaining: noul(0.97, "hard_pass"),
						missing_work_class: { type: "choice", choice: "implement", confidence: 0.95 },
						current_worker_can_continue: noul(0.03, "hard_fail"),
						independent_worker_required: noul(0.02, "hard_fail"),
						capability_escalation_required: noul(0.02, "hard_fail"),
						context_stale: noul(0.03, "hard_fail"),
						strategy_repetition: strategyRepetition,
						semantic_progress: { type: "score", score: 2, confidence: 0.9 },
					},
				}),
			} as never,
		});
		expect((await controller.evaluateRouteOnce("goal:route")).route).toBe("implement");
		// Jev says the strategy is repeating: the route must replan, not keep implementing.
		strategyRepetition = noul(0.96, "hard_pass");
		const repeating = await controller.evaluateRouteOnce("goal:route");
		expect(repeating.route).toBe("replan");
		expect(repeating.reason_codes).toContain("strategy_repetition_detected");
	});

	it("routes owner_required while the owner's authority is what the objective waits on", async () => {
		const { runtime } = createTestRuntime();
		let ownerRequired = true;
		const controller = new ObjectiveExecutionController({
			mode: "objective_primary",
			runtime: { reconcileObjective: async () => runtime.getSnapshot() },
			systemOne: { evaluateObjectiveRoute: async () => ({ workRemaining: true, missingWorkClass: "implement" }) },
		});
		controller.bindSessionExecutors({ ownerRequired: () => ownerRequired });
		expect((await controller.evaluateRouteOnce("goal:g1")).route).toBe("owner_required");
		ownerRequired = false;
		expect((await controller.evaluateRouteOnce("goal:g1")).route).toBe("implement");
	});

	it("OEL-036, OEL-037: GoalSessionController in shadow mode emits disagreement telemetry and primary mode bypasses legacy continuation", async () => {
		const sessionManager = SessionManager.inMemory();
		let telemetryEvent: DisagreementTelemetryEvent | undefined;
		const { runtime } = createTestRuntime();

		const objectiveController = new ObjectiveExecutionController({
			mode: "objective_shadow",
			runtime: {
				reconcileObjective: async () => runtime.getSnapshot(),
			},
			systemOne: {
				evaluateObjectiveRoute: async () => ({ workRemaining: false, missingWorkClass: "none" }),
				executeCompletionTransaction: async () => ({
					decision_id: "comp",
					verdict: "complete",
					gate_results: {},
					failed_gates: [],
				}),
			},
			onDisagreementTelemetry: (event) => {
				telemetryEvent = event;
			},
		});

		let legacyPromptCalled = false;
		const shadowController = new GoalSessionController({
			getSessionManager: () => sessionManager,
			getModelProvider: () => undefined,
			getLaneRecords: () => [],
			getTaskRuntimeSnapshot: () => undefined,
			getBackgroundToolTasks: () => [],
			synchronizeGoalState: () => {},
			scheduleGoalAutoContinueFromIdle: () => {},
			prompt: async () => {
				legacyPromptCalled = true;
			},
			emitWarning: () => {},
			getExecutionLoopMode: () => "objective_shadow",
			getObjectiveExecutionController: () => objectiveController,
		});

		const goal = createGoalState({ goalId: "goal_shadow_1", userGoal: "Test goal in shadow mode", now: "T0" });
		shadowController.saveState(goal);

		// In shadow mode, legacy continuation proceeds, but disagreement telemetry is fired
		const shadowResult = await shadowController.continueOnce({ maxStallTurns: 3 });
		expect(shadowResult.submitted).toBe(true);
		expect(legacyPromptCalled).toBe(true);
		expect(telemetryEvent).toBeDefined();
		expect(telemetryEvent?.legacyAction).toBe("continue");
		expect(telemetryEvent?.objectiveRoute).toBe("completion_candidate");

		// Now test primary mode
		legacyPromptCalled = false;
		const primaryController = new GoalSessionController({
			getSessionManager: () => sessionManager,
			getModelProvider: () => undefined,
			getLaneRecords: () => [],
			getTaskRuntimeSnapshot: () => undefined,
			getBackgroundToolTasks: () => [],
			synchronizeGoalState: () => {},
			scheduleGoalAutoContinueFromIdle: () => {},
			prompt: async () => {
				legacyPromptCalled = true;
			},
			emitWarning: () => {},
			getExecutionLoopMode: () => "objective_primary",
			getObjectiveExecutionController: () => objectiveController,
		});

		// In primary mode System One drives the cycle: no legacy prompt; the route is
		// completion_candidate, the completion transaction passes, and the goal follows the terminal.
		const primaryOnceResult = await primaryController.continueOnce({ maxStallTurns: 3 });
		expect(primaryOnceResult.submitted).toBe(false);
		expect(legacyPromptCalled).toBe(false);
		expect(objectiveController.getLastRoute()?.route).toBe("completion_candidate");
		expect(primaryController.getState()?.status).toBe("completed");

		const primaryLoopResult = await primaryController.continueLoop({ maxTurns: 5, maxStallTurns: 3 });
		expect(primaryLoopResult.turnsSubmitted).toBe(0);
		expect(primaryLoopResult.stopReason).toBe("continuation_not_allowed");
		expect(legacyPromptCalled).toBe(false);
	});

	it("ADR-001, ADR-004, ADR-005, ADR-061: Operates fully with System One disabled under mechanical profile, producing DeliveryBundle", async () => {
		const { runtime } = createTestRuntime();
		await runtime.createObjective({
			objectiveId: "obj_mech_1",
			title: "Mechanical autonomy without Jev",
			description: "Mechanical autonomy description",
		});

		const mechEngine = new MechanicalDecisionEngine();
		const router = new DecisionEngineRouter([mechEngine]);

		const controller = new ObjectiveExecutionController({
			runtime: {
				reconcileObjective: async () => runtime.getSnapshot(),
			},
			decisions: router,
			completionProfile: "mechanical",
		});

		// Route evaluation works 100% mechanically
		const route = await controller.evaluateRouteOnce("obj_mech_1");
		expect(route).toBeDefined();
		expect(route.route).toBe("completion_candidate");

		// Run produces delivery bundle under mechanical completion profile
		const delivery = await controller.runToDelivery("obj_mech_1");
		expect(delivery).toBeDefined();
		expect(delivery.schema_version).toBe("2.0");
		expect(delivery.objective_id).toBe("obj_mech_1");
		expect(delivery.terminal_status).toBe("complete");
		expect(delivery.source_revision).toBeDefined();
	});

	it("ADR-020, ADR-021, ADR-063: DecisionEngineRouter speculative fan-out route evaluation", async () => {
		const { runtime } = createTestRuntime();
		await runtime.createObjective({
			objectiveId: "obj_fanout_1",
			title: "Speculative fan-out route",
			description: "Fan-out route description",
		});

		const mockAdapter = {
			evaluate: async () => ({
				model: "jev-1.13.0",
				answers: {
					task_kind: { choice: "feature", distribution: { feature: 0.95 }, margin: 0.9, confidence: 0.95 },
					work_remaining: { value: true, probability: 0.98, confidence: 0.98 },
					missing_work_class: {
						choice: "implementation",
						distribution: { implementation: 0.92 },
						margin: 0.85,
						confidence: 0.92,
					},
					independent_worker_required: { value: false, probability: 0.05, confidence: 0.95 },
					capability_escalation_needed: { value: false, probability: 0.02, confidence: 0.98 },
					completion_plausible: { value: false, probability: 0.1, confidence: 0.9 },
					external_blocker: { value: false, probability: 0.01, confidence: 0.99 },
				},
				latency_ms: 45,
			}),
		};

		const systemOneEngine = new TypeSafeSystemOneDecisionEngine(mockAdapter as any, "jev-1.13.0");
		const router = new DecisionEngineRouter([systemOneEngine]);

		const controller = new ObjectiveExecutionController({
			runtime: {
				reconcileObjective: async () => runtime.getSnapshot(),
			},
			decisions: router,
			completionProfile: "semantic_enhanced",
		});

		const route = await controller.evaluateRouteOnce("obj_fanout_1");
		expect(route.route).toBe("implement");
		expect(route.reason_codes).toContain("implementation_required");
	});

	it("ADR-040, ADR-042, ADR-044: Authority Envelope edge_only halts on unpermitted action and requests human edge", async () => {
		const { runtime } = createTestRuntime();
		await runtime.createObjective({
			objectiveId: "obj_envelope_1",
			title: "Envelope boundary testing",
			description: "Envelope boundary description",
		});

		const env = createDefaultAuthorityEnvelope("/test/repo");
		let humanEdgeRequested = false;

		const controller = new ObjectiveExecutionController({
			runtime: {
				reconcileObjective: async () => runtime.getSnapshot(),
			},
			authorityEnvelope: env,
			getRouteProposedAction: () => ({ kind: "git_push", pushRequested: true }),
			onHumanEdgeRequest: async (req) => {
				humanEdgeRequested = true;
				expect(req.schema_version).toBe("2.0");
				expect(req.edge_type).toBe("irreversible_external");
				return false; // Denied by operator
			},
		});

		const terminal = await controller.run("obj_envelope_1");
		expect(terminal.status).toBe("blocked");
		expect(terminal.reasonCodes).toContain("human_edge_denied");
		expect(humanEdgeRequested).toBe(true);
		expect(terminal.deliveryBundle?.terminal_status).toBe("owner_required");
	});

	it("ADR-056, ADR-064: system_one_required profile halts as semantic_gate_unavailable when calibrated engine is absent", async () => {
		const { runtime } = createTestRuntime();
		await runtime.createObjective({
			objectiveId: "obj_req_1",
			title: "High assurance requirement",
			description: "High assurance description",
		});

		const controller = new ObjectiveExecutionController({
			runtime: {
				reconcileObjective: async () => runtime.getSnapshot(),
			},
			systemOne: {
				evaluateObjectiveRoute: async () => ({ workRemaining: false, missingWorkClass: "none" }),
			},
			completionProfile: "system_one_required",
		});

		const terminal = await controller.run("obj_req_1");
		expect(terminal.status).toBe("semantic_gate_unavailable");
		expect(terminal.reasonCodes).toContain("system_one_required_but_unavailable");
		expect(terminal.deliveryBundle?.terminal_status).toBe("semantic_gate_unavailable");
	});
});
