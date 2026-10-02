import { describe, expect, it } from "vitest";
import { compileExecutionCharter } from "../../src/core/autonomy/execution-charter.ts";
import { ObjectiveExecutionController } from "../../src/core/objective-execution/objective-execution-controller.ts";
import { composeObjectiveRoute } from "../../src/core/objective-execution/objective-route-policy.ts";
import type { TaskRuntimeProjection } from "../../src/core/orchestration/task-runtime.ts";
import { accountRequestDirective } from "../../src/core/system-one/control-directive.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { committedRepo } from "../git-fixture.ts";

const PATCH = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n";

function runtime(): TaskRuntimeProjection {
	return {
		lastOrdinal: 1,
		agents: {},
		checkpoints: {},
		approvals: {},
		notifications: {},
		objectives: {
			"obj-1": {
				objective: {
					schemaVersion: 1 as const,
					objectiveId: "obj-1",
					title: "t",
					description: "t",
					acceptanceCriteria: [{ id: "c1", description: "c1", required: true }],
					status: "active",
					constraints: [],
					riskBudget: {},
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
				taskIds: [],
				evidence: [
					{
						evidenceId: "e1",
						criterionId: "c1",
						kind: "test",
						summary: "ok",
						artifactIds: [],
						trusted: true,
						createdAt: new Date().toISOString(),
					},
				],
			},
		},
		tasks: {},
		attempts: {},
	};
}

const adapter = {
	provenance: "native_calibrated" as const,
	evaluate: async (input: { questions?: Record<string, unknown> }) => {
		const keys = Object.keys(input.questions ?? {});
		if (keys.some((key) => key.startsWith("shows_true_")))
			return {
				model: "jev-1.13.0",
				latency_ms: 1,
				answers: Object.fromEntries(
					keys.map((key) => [key, { noul: key.startsWith("shows_true_") ? 0.97 : 0.02 }]),
				),
			};
		return {
			model: "jev-1.13.0",
			latency_ms: 1,
			answers: Object.hasOwn(input.questions ?? {}, "missing_requirement")
				? { missing_requirement: { noul: 0.01 } }
				: {
						outcomes_achieved: { noul: 0.99 },
						required_behavior_unverified: { noul: 0.01 },
						material_claim_unsupported: { noul: 0.01 },
					},
		};
	},
};

function loop() {
	const store = new ExecutionStore({
		run_id: "loop-account",
		objective: {
			request: "do it",
			normalized_goal: "do it",
			acceptance_criteria: [{ id: "c1", text: "c1", required: true }],
		},
		repo: { root: "/workspace", baseline_revision: "r0" },
	});
	store.recordVerification({ kind: "unit_test", status: "passed", covers_acceptance_ids: ["c1"] });
	const systemOne = new SystemOneController({ store, adapter });
	systemOne.setWorkDiffSource(() => ({ base: "base", patch: PATCH, omittedChars: 0, untracked: [] }));
	const controller = new ObjectiveExecutionController({
		mode: "objective_primary",
		completionProfile: "system_one_required",
		runtime: { reconcileObjective: async () => runtime() },
		executionCharter: compileExecutionCharter({
			objectiveId: "obj-1",
			prompt: "ship",
			initialGrants: { git: { commit: true, push: true, push_remote: "origin", push_ref: "refs/heads/main" } },
		}),
		gitExecutor: {
			inspectCandidate: async () => ({ parent: "parent-approved", tree: "tree-approved", digest: "unused" }),
			commit: async () => ({ sha: "abc1234deadbeef" }),
			push: async () => ({ ref: "refs/heads/main", remote: "origin" }),
			proveDelivery: async () => ({
				head: "abc1234deadbeef",
				parent: "parent-approved",
				tree: "tree-approved",
				remote: "origin",
				ref: "refs/heads/main",
				observedSha: "abc1234deadbeef",
				attributableResidue: [] as string[],
			}),
		},
		systemOne: {
			adapter,
			snapshot: () => store.snapshot(),
			evaluateObjectiveRoute: async () => ({ workRemaining: false, missingWorkClass: "none" }),
			executeCompletionTransaction: (isBugFix, options) => systemOne.executeCompletionTransaction(isBugFix, options),
			noteControlDirective: (directive) => systemOne.noteControlDirective(directive),
			peekControlDirective: () => systemOne.peekControlDirective(),
			consumeControlDirective: (expected) => systemOne.consumeControlDirective(expected),
			completionView: () => systemOne.completionView(),
		},
		steeringPlane: {
			policy: { mode: "system_one_required" },
			requireCertificate: async (checkpoint: string) => ({
				certificate_id: `c-${checkpoint}`,
				semantic_outcome: "pass",
				answers: { work_remaining: { boolean: false }, missing_work_class: { choice: "none" } },
				directive: checkpoint === "JEV-024" ? "completion_candidate" : "allow",
			}),
		} as never,
		repoRoot: committedRepo("pi-account-loop-"),
	});
	return { controller, systemOne };
}

describe("completion account in the objective loop", () => {
	it("asks for the account with a root turn, never an obligation, and completes once it is given", async () => {
		const { controller, systemOne } = loop();
		const asked = await controller.run("obj-1");
		expect(asked.status).toBe("incomplete");
		expect(asked.reasonCodes.join(" ")).toContain("account_missing");
		expect(systemOne.verification.status().obligations).toEqual([]);
		const directive = systemOne.peekControlDirective();
		expect(directive).toMatchObject({ objectiveRoute: "implement" });
		expect(directive?.reasonCodes.join(" ")).toContain("account_missing");
		expect(directive?.reasonCodes.join(" ")).toContain("Call goal complete again with `account`");

		// The model answers with its account (through goal complete); the next completion reads it.
		systemOne.consumeControlDirective(directive);
		systemOne.noteCompletionAccount({
			changes: [{ path: "src/a.ts", reason: "It replaces the old behavior.", serves: ["c1"] }],
			assumptions: [],
			regressions: [],
		});
		const done = await controller.run("obj-1");
		expect(done.status).toBe("complete");
	});

	it("routes the request to one root turn: the directive composes an implement route carrying its text", () => {
		const request = "account_missing: the repository changed. Call goal complete again with `account`.";
		const route = composeObjectiveRoute({
			cycleId: "c",
			objectiveId: "obj-1",
			systemOneDirective: accountRequestDirective([request]),
		} as never);
		expect(route.route).toBe("implement");
		expect(route.reason_codes).toEqual(expect.arrayContaining(["completion_account_requested", request]));
	});

	it("still opens a verification obligation for a failure a check can verify (negative control)", async () => {
		const { controller, systemOne } = loop();
		systemOne.noteCompletionAccount({
			changes: [{ path: "src/a.ts", reason: "It replaces the old behavior.", serves: ["c1"] }],
			assumptions: [],
			regressions: [],
		});
		const baseEvaluate = adapter.evaluate;
		const failing = {
			...adapter,
			evaluate: async (input: { questions?: Record<string, unknown> }) =>
				Object.hasOwn(input.questions ?? {}, "missing_requirement")
					? { model: "jev-1.13.0", latency_ms: 1, answers: { missing_requirement: { noul: 0.9 } } }
					: baseEvaluate(input),
		};
		(systemOne as unknown as { adapter: typeof adapter }).adapter = failing as never;
		const result = await controller.run("obj-1");
		expect(result.status).toBe("incomplete");
		expect(systemOne.verification.status().obligations.length).toBeGreaterThan(0);
	});
});
