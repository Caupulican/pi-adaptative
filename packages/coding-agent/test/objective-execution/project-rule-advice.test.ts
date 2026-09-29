// @isolated: durable orchestration fixture
import { describe, expect, it, vi } from "vitest";
import { MechanicalDecisionEngine } from "../../src/core/decision/index.ts";
import { ObjectiveExecutionController } from "../../src/core/objective-execution/objective-execution-controller.ts";
import { composeObjectiveRoute } from "../../src/core/objective-execution/objective-route-policy.ts";
import { OrchestrationEventStore } from "../../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime } from "../../src/core/orchestration/task-runtime.ts";
import { SemanticProjectRuleController } from "../../src/core/project-rules/semantic-project-rule-controller.ts";
import { SessionProjectRules } from "../../src/core/project-rules/session-project-rules.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { tempDir } from "../temp-dir.ts";

describe("postflight semantic outages", () => {
	it("executes an existing verification directive without asking another route judgment first", async () => {
		const agentDir = tempDir("verification-priority-");
		const runtime = new DurableTaskRuntime({
			store: new OrchestrationEventStore({ agentDir, sessionId: "priority" }),
		});
		await runtime.createObjective({ objectiveId: "goal", title: "Verify", description: "Verify" });
		const routeJudgment = vi.fn(async () => {
			throw new Error("unrelated route evaluator unavailable");
		});
		const execute = vi.fn(async () => undefined);
		const directive = {
			source: "postflight" as const,
			objectiveRoute: "deterministic_test" as const,
			reasonCodes: ["same_lane_verification_required", "finding"],
		};
		const controller = new ObjectiveExecutionController({
			mode: "objective_primary",
			runtime: { reconcileObjective: async () => runtime.getSnapshot() },
			systemOne: {
				evaluateObjectiveRoute: routeJudgment,
				peekControlDirective: () => directive,
				consumeControlDirective: () => directive,
			},
			rootExecutor: { execute },
		});
		await controller.runCycles("goal", 1);
		expect(routeJudgment).not.toHaveBeenCalled();
		expect(execute).toHaveBeenCalledOnce();
	});
	it("prioritizes verification in the receiving lane over a verifier dispatch request", () => {
		const directive = {
			objectiveRoute: "deterministic_test" as const,
			reasonCodes: ["same_lane_verification_required", "candidate"],
		};
		expect(
			composeObjectiveRoute({
				cycleId: "cycle",
				objectiveId: "goal",
				semantic: { missingWorkClass: "implement" },
				systemOneDirective: directive,
				supervisionRequest: { action: "request_verifier", reasonCodes: ["other_agent"] },
			}).route,
		).toBe("deterministic_test");
		expect(
			composeObjectiveRoute({
				cycleId: "cycle",
				objectiveId: "goal",
				systemOneDirective: directive,
				cancelled: true,
			}).route,
		).toBe("cancel");
	});

	it("verifies, revises and rechecks a finding in the same lane before ordinary work continues", async () => {
		const agentDir = tempDir("same-lane-rule-");
		const runtime = new DurableTaskRuntime({
			store: new OrchestrationEventStore({ agentDir, sessionId: "verification" }),
		});
		await runtime.createObjective({ objectiveId: "goal", title: "Fix", description: "Fix" });
		let defect = true;
		const checks: boolean[] = [];
		const rules = new SemanticProjectRuleController({
			initialRules: [
				{
					schema_version: "1.0",
					rule_id: "candidate",
					source: { path: "AGENTS.md" },
					text: "Verify results",
					phase: "task_postflight",
					consequence: "high",
					owner: "jev",
					enabled: true,
				},
			],
			decisionEngine: { evaluate: async () => ({ answers: { "violate::candidate": { value: defect } } }) },
		});
		const systemOne = new SystemOneController({
			store: new ExecutionStore({
				run_id: "verification",
				objective: { request: "Fix", normalized_goal: "Fix", acceptance_criteria: [] },
				repo: { root: agentDir, baseline_revision: "base" },
			}),
			adapter: { evaluate: async () => ({ model: "fixture", answers: {}, latency_ms: 1 }) },
		});
		const routes: string[] = [];
		const repair = vi.fn();
		const verifier = vi.fn();
		const dispatch = vi.fn();
		const controller = new ObjectiveExecutionController({
			mode: "objective_primary",
			runtime: { reconcileObjective: async () => runtime.getSnapshot(), ensureRepairTasks: repair },
			projectRules: rules,
			systemOne: {
				evaluateObjectiveRoute: async () => ({ missingWorkClass: "implement" }),
				peekControlDirective: () => systemOne.peekControlDirective(),
				consumeControlDirective: (expected) => systemOne.consumeControlDirective(expected),
				noteControlDirective: (directive) => systemOne.noteControlDirective(directive),
			},
			rootExecutor: {
				execute: async (route) => {
					routes.push(route.route);
					if (route.route === "deterministic_test") {
						expect(route.reason_codes.join(" ")).toContain("candidate");
						checks.push(defect);
						if (checks.length === 2) defect = false;
					}
				},
			},
			verifier: { execute: verifier },
			workerDispatcher: { dispatch, continueWorker: dispatch, dispatchEscalated: dispatch },
		});
		await controller.runCycles("goal", 4);
		expect(routes).toEqual(["implement", "deterministic_test", "deterministic_test", "implement"]);
		expect(checks).toEqual([true, true]);
		expect(defect).toBe(false);
		expect(systemOne.peekControlDirective()).toBeUndefined();
		expect(verifier).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
		expect(repair).not.toHaveBeenCalled();
	});

	it("keeps progressing through stall accounting without consuming repair capacity", async () => {
		const agentDir = tempDir("rule-advice-");
		const runtime = new DurableTaskRuntime({ store: new OrchestrationEventStore({ agentDir, sessionId: "advice" }) });
		await runtime.createObjective({
			objectiveId: "goal",
			title: "Fix the observed issue",
			description: "Fix the observed issue",
		});
		const repair = vi.fn(() => {
			throw new Error("semantic advice must not create repair work");
		});
		const emitAdvice = vi.fn();
		const rules = new SessionProjectRules({
			cwd: agentDir,
			getTrustedRuleSources: () => [
				{ path: "AGENTS.md", content: "# Task postflight\n- Never claim unverified results" },
			],
			getOwnerRulePolicies: () => [],
			getDecisionEngine: () => ({
				id: "offline",
				model: "offline",
				capabilities: () => new MechanicalDecisionEngine().capabilities(),
				evaluate: async () => {
					throw new Error("decision service unavailable");
				},
			}),
			recordRepairWork: repair,
			emitViolation: emitAdvice,
		});
		const evaluateStall = vi.fn(async () => ({
			stalled: false,
			stallTurns: 0,
			repeatedWithoutNewEvidence: false,
			fingerprint: "progress",
		}));
		const controller = new ObjectiveExecutionController({
			mode: "objective_primary",
			runtime: { reconcileObjective: async () => runtime.getSnapshot(), ensureRepairTasks: repair },
			rootExecutor: { execute: async () => undefined },
			projectRules: rules,
			stalls: { evaluate: evaluateStall },
		});
		vi.spyOn(controller, "evaluateRouteOnce").mockResolvedValue({
			schema_version: "1.0",
			cycle_id: "cycle",
			objective_id: "goal",
			route: "implement",
			reason_codes: [],
		});
		await controller.runCycles("goal", 4);
		expect(repair).not.toHaveBeenCalled();
		expect(evaluateStall).toHaveBeenCalledTimes(4);
		expect(emitAdvice).toHaveBeenCalledTimes(4);
		expect(emitAdvice.mock.calls[0]?.[0]).toMatchObject({
			advisory: true,
			summaryEvent: expect.stringContaining("decision service unavailable"),
		});
		expect(rules.getQueuedRepairWork()).toEqual([]);
		expect(Object.keys(runtime.getSnapshot().tasks)).toHaveLength(0);
	});
});
