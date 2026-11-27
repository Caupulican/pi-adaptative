import { expect, it, vi } from "vitest";
import { createGoalState } from "../src/core/goals/goal-state.ts";
import { projectRunnableRequirements } from "../src/core/goals/requirement-dependencies.ts";
import { assertCurrentGoalObjective } from "../src/core/objective-execution/current-objective-execution.ts";
import { LedgerRouteCheckpoints } from "../src/core/objective-execution/ledger-route-checkpoints.ts";
import {
	dispatchObjectiveRoute,
	executeObjectiveRetrieval,
	executeWithRouteAdmission,
} from "../src/core/objective-execution/objective-route-execution.ts";
import { composeObjectiveRoute } from "../src/core/objective-execution/objective-route-policy.ts";
import { repeatedRouteCount } from "../src/core/objective-execution/objective-route-projector.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import { emptyProjection } from "../src/core/orchestration/task-runtime-projection.ts";
import { SessionCacheController, type SessionCacheControllerDeps } from "../src/core/session-cache-controller.ts";
import { readObjectiveWorkClass } from "../src/core/steering/programs.ts";
import { SystemOneSteeringPlane } from "../src/core/steering/system-one-steering-plane.ts";

const noul = (probability: number) => ({ type: "noul", noul: probability });
const grounded = {
	missing_work_class: { choice: "investigate", probabilities: { investigate: 0.55, implement: 0.45 } },
	work_remaining: noul(0.98),
	evidence_sufficient: noul(0.98),
	independent_worker_required: noul(0.02),
	capability_escalation_required: noul(0.02),
};

it("targets the runnable requirement and holds the watch's dependent work", () => {
	const at = "2026-11-26T12:00:00.000Z";
	const requirements = [
		{ id: "watch", dependencies: [] },
		{ id: "report", dependencies: ["watch"] },
		{ id: "cleanup", dependencies: ["report"] },
		{ id: "inspect", dependencies: [] },
	].map((item) => ({
		...item,
		text: item.id,
		evidenceIds: [],
		status: "open" as const,
		createdAt: at,
		updatedAt: at,
	}));
	const readiness = projectRunnableRequirements(requirements, new Set(["watch"]), () => false);
	expect([...readiness.waitingOnWatch]).toEqual(["watch", "report", "cleanup"]);
	const input = { cycleId: "C1", objectiveId: "goal:validation", semantic: { missingWorkClass: "retrieve" as const } };
	expect(composeObjectiveRoute({ ...input, targetRequirementIds: readiness.runnable })).toMatchObject({
		route: "retrieve",
		target_requirement_ids: ["inspect"],
	});
	expect(composeObjectiveRoute({ ...input, targetRequirementIds: [] }).route).toBe("replan");
});

it("compares repeated work and accepted evidence independently from diagnostics", () => {
	const first = { route: "retrieve", reasonCodes: ["uncovered"], evidenceMarker: 1, workKey: "req-a" };
	const second = { ...first, reasonCodes: ["partial_result"] };
	expect(repeatedRouteCount([first, second], 1)).toBe(2);
	expect(repeatedRouteCount([first, second], 2)).toBe(0);
	expect(repeatedRouteCount([first, { ...second, evidenceMarker: 2 }], 2)).toBe(1);
	expect(repeatedRouteCount([first, { ...second, workKey: "req-b" }], 1)).toBe(1);
});

it.each(["root", "retrieval"] as const)(
	"records only actual submissions, including execution failures (%s)",
	async (kind) => {
		const route = composeObjectiveRoute({
			cycleId: "C",
			objectiveId: "session:work",
			semantic: { missingWorkClass: "retrieve" },
		});
		for (const started of [false, true]) {
			const receipts: string[] = [];
			const note = async (executor: string) => {
				receipts.push(executor);
			};
			const run =
				kind === "root"
					? executeWithRouteAdmission(
							{
								reportsAdmission: true,
								execute: async (_route, _signal, submitted) => {
									if (started) submitted?.();
									throw new Error("stopped");
								},
							},
							route,
							undefined,
							() => note("root"),
						)
					: executeObjectiveRetrieval(
							{
								reportsAdmission: true,
								execute: async (_route, _signal, submitted) => {
									if (started) submitted?.("worker");
									throw new Error("stopped");
								},
							},
							route,
							undefined,
							note,
						);
			await expect(run).rejects.toThrow("stopped");
			expect(receipts).toEqual(started ? [kind === "root" ? "root" : "worker"] : []);
		}
	},
);

it.each([false, true])(
	"readmits a worker refusal only when the route permits root execution (%s)",
	async (independent) => {
		const runtime = emptyProjection();
		const route = composeObjectiveRoute({
			cycleId: "C1",
			objectiveId: "goal:validation",
			semantic: { missingWorkClass: independent ? "review" : "investigate" },
		});
		const events: string[] = [];
		const run = dispatchObjectiveRoute(
			{
				cycle: 1,
				deps: {
					runtime: { reconcileObjective: async () => runtime },
					chooseExecutor: () => "worker",
					rootExecutor: {
						execute: async () => {
							events.push("executed root");
						},
					},
					workerDispatcher: {
						dispatch: async () => {
							events.push("admitted worker");
							return { started: false, reason: "quota" };
						},
						continueWorker: async () => {},
						dispatchEscalated: async () => {},
					},
				},
				assertCurrent: () => {},
				noteBinding: () => {},
				noteExecutor: async (executor) => {
					events.push(executor);
				},
				refuse: async (reasons) => {
					throw new Error(reasons.join(","));
				},
			},
			route.objective_id,
			route,
			runtime,
			false,
		);
		if (independent) await expect(run).rejects.toThrow("worker_admission_refused,quota");
		else await expect(run).resolves.toBeUndefined();
		expect(events).toEqual(independent ? ["admitted worker"] : ["admitted worker", "root", "executed root"]);
	},
);

it("leaves a grounded, unsettled method to the current agent within the objective's existing controls", () => {
	const missingWorkClass = readObjectiveWorkClass(grounded);
	const input = { cycleId: "cycle", objectiveId: "task", semantic: { missingWorkClass } };
	expect(missingWorkClass).toBe("continue_current_work");
	expect(composeObjectiveRoute(input).reason_codes).toEqual(["work_method_unsettled"]);
	expect(composeObjectiveRoute({ ...input, ownerRequired: true }).route).toBe("owner_required");
	expect(composeObjectiveRoute({ ...input, budgetExhausted: true }).route).toBe("cancel");
});

it.each([
	{ work_remaining: { noul: 0.5 } },
	{ evidence_sufficient: undefined },
	{ evidence_sufficient: { noul: 0.5 } },
	{ independent_worker_required: { noul: 0.98 } },
	{ independent_worker_required: { noul: 0.5 } },
	{ capability_escalation_required: { noul: 0.5 } },
	{ capability_escalation_required: { noul: 0.98 } },
	{ missing_work_class: { choice: "implement" } },
	{ missing_work_class: { choice: "unknown_method", probabilities: { unknown_method: 0.98 } } },
	{ missing_work_class: { choice: "completion_candidate", probabilities: { completion_candidate: 0.55 } } },
	{ missing_work_class: { choice: "resolve_capability", probabilities: { resolve_capability: 0.55 } } },
])("preserves retrieval when the evidence or a consequential decision remains open", (open) => {
	expect(readObjectiveWorkClass({ ...grounded, ...open })).toBe("insufficient_evidence");
});

it.each([0.5, 0.98])(
	"applies all recorded uncertainties on the first route with progress confidence %s",
	async (progress) => {
		const plane = new SystemOneSteeringPlane({
			adapter: {
				evaluate: async () => ({
					model: "fixture",
					latency_ms: 1,
					answers: {
						...grounded,
						// 0.72 clears the reversible Choice floor but the route checkpoint still records a doubt.
						missing_work_class: {
							type: "choice",
							choice: "investigate",
							confidence: 0.72,
							probabilities: { investigate: 0.72, implement: 0.28 },
						},
						semantic_progress: {
							type: "score",
							score: 1 + progress,
							confidence: progress,
							probabilities: { "1": 1 - progress, "2": progress },
						},
						strategy_repetition: noul(0.02),
						context_stale: noul(0.02),
						completion_plausible: noul(0.02),
						capability_gap_suspected: noul(0.02),
					},
				}),
			},
		});
		const state = { objective: "Investigate the retry count" };
		const options = { consequence: "medium" } as const;
		const evaluated = await plane.evaluate("JEV-004", state, options);
		expect(evaluated.directive.action).toBe("continue_current_work");
		const firstRoute = plane.requireCertificate("JEV-004", state, options);
		if (progress === 0.5) {
			expect(evaluated.certificate.unsure_semantic_predicates).toEqual(["missing_work_class", "semantic_progress"]);
			await expect(firstRoute).rejects.toMatchObject({ outcome: "gather_more" });
		} else {
			expect(evaluated.certificate.unsure_semantic_predicates).toEqual(["missing_work_class"]);
			await expect(firstRoute).resolves.toEqual(evaluated.certificate);
			expect(evaluated.certificate.semantic_outcome).toBe("gather_more");
		}
	},
);

it("bases repetition on executed work even when previews push both actual routes beyond the history limit", async () => {
	const ledger = new DecisionLedgerStore({ databasePath: ":memory:" });
	try {
		const checkpoints = new LedgerRouteCheckpoints({
			getLedger: () => ledger,
			getSnapshot: emptyProjection,
			cwd: ".",
			sessionId: "session",
		});
		for (let i = 0; i < 12; i++) {
			const route = composeObjectiveRoute({
				cycleId: String(i),
				objectiveId: "session:work",
				semantic: { missingWorkClass: "retrieve" },
			});
			await checkpoints.recordRoute(route);
			if (i < 2) await checkpoints.recordRouteOutcome(route, "root");
			else if (i < 11) {
				const wait = composeObjectiveRoute({
					cycleId: `wait-${i}`,
					objectiveId: "session:work",
					requiredWorkerInFlight: true,
				});
				await checkpoints.recordRoute(wait);
				await checkpoints.recordRouteOutcome(wait, wait.route);
			}
		}
		expect((await checkpoints.recentRoutes("session:work", 2)).map((row) => row.executor)).toEqual(["root", "root"]);
		expect((await checkpoints.evaluate("session:work")).repeatedWithoutNewEvidence).toBe(true);
		expect(ledger.recentRoutes("session", "session:work", 1)[0]?.executor).toBeUndefined();
	} finally {
		ledger.close();
	}
});

it.each(["refused", "queued", "partial", "aborted"] as const)(
	"attributes retrieval on a separate session objective to its actual executor (%s)",
	async (outcome) => {
		const foreground = createGoalState({
			goalId: "foreground",
			userGoal: "Unrelated goal",
			now: "2026-11-26T12:00:00Z",
		});
		expect(assertCurrentGoalObjective("session:work", foreground)).toBeUndefined();
		expect(() => assertCurrentGoalObjective("goal:other", foreground)).toThrow();
		const run = new AbortController();
		const events: string[] = [];
		let startHeld: (() => void) | undefined;
		const ledger = new DecisionLedgerStore({ databasePath: ":memory:" });
		try {
			vi.spyOn(ledger, "noteRouteExecutor").mockImplementation((_session, _cycle, executor) => {
				events.push(executor);
			});
			const controller = new SessionCacheController({
				getGoalState: () => foreground,
				getObjective: () => ({ description: "Collect the receipt", acceptanceCriteria: [] }),
				getSessionId: () => "session",
				getDecisionLedger: () => ledger,
				runWorkerDelegationOnce: async (request, admit) => {
					expect(request.objectiveRouteOrigin).toEqual({
						sessionId: "session",
						objectiveId: "session:work",
						cycleId: "cycle",
						executor: "worker",
					});
					expect(request.instructions).toContain("Collect the receipt");
					expect(request.instructions).not.toContain(foreground.userGoal);
					if (outcome === "refused") return { started: false, skipReason: "capacity" };
					if (outcome === "queued") {
						const record = { status: "queued", laneId: "Q1", type: "worker" } as const;
						admit(record);
						startHeld = () => admit({ ...record, status: "running", firstStartedAt: "2026-11-26T12:00:00Z" });
						return { started: true, record };
					}
					admit({ laneId: "W1", status: "running", type: "worker", firstStartedAt: "2026-11-26T12:00:00Z" });
					if (outcome === "aborted") run.abort();
					return { started: true };
				},
				sendNextTurnCustomMessage: async (_message, assertCurrent) => {
					assertCurrent();
					events.push("delivered");
				},
				executeObjectiveRootRoute: async (_route, _signal, submitted) => {
					submitted();
					events.push("ran root");
				},
			} as Partial<SessionCacheControllerDeps> as SessionCacheControllerDeps);
			vi.spyOn(controller, "chooseRetrieveExecutor").mockReturnValue("worker");
			const route = composeObjectiveRoute({
				cycleId: "cycle",
				objectiveId: "session:work",
				semantic: { missingWorkClass: "retrieve" },
			});
			const result = controller.retrieveForObjective(route, run.signal);
			if (outcome === "aborted") {
				await expect(result).rejects.toThrow();
				expect(events).toEqual(["worker"]);
			} else if (outcome === "queued") {
				await expect(result).resolves.toBe("worker:pending");
				expect(events).toEqual([]);
				startHeld?.();
				expect(events).toEqual(["worker"]);
			} else {
				await expect(result).resolves.toBe(outcome === "refused" ? "root" : "worker");
				expect(events).toEqual(outcome === "refused" ? ["root", "ran root"] : ["worker", "delivered"]);
			}
		} finally {
			ledger.close();
		}
	},
);
