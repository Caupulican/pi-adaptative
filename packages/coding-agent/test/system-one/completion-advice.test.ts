import { describe, expect, it, vi } from "vitest";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import type { SemanticVerificationSnapshot } from "../../src/core/system-one/verification-obligations.ts";

const passingAnswers = {
	outcomes_achieved: true,
	required_behavior_unverified: false,
	material_claim_unsupported: false,
	missing_requirement: false,
	verification_resolution_valid: { noul: 0.99 },
	// The account's claims, read against their cited evidence by the same fixed pair of questions.
	shows_true_0: { noul: 0.97 },
	shows_false_0: { noul: 0.02 },
	shows_true_1: { noul: 0.97 },
	shows_false_1: { noul: 0.02 },
};

describe("completion advice lifecycle", () => {
	it("holds unavailable repository outcome evidence as a recoverable diagnostic, then continues", async () => {
		const store = new ExecutionStore({
			run_id: "repository-evidence",
			objective: {
				request: "Fix the repository outcome",
				normalized_goal: "Fix the repository outcome",
				acceptance_criteria: [{ id: "AC", text: "Outcome verified", required: true }],
			},
			repo: { root: "/repo", baseline_revision: "base" },
		});
		store.recordVerification({ kind: "unit_test", status: "passed", covers_acceptance_ids: ["AC"] });
		const controller = new SystemOneController({
			store,
			adapter: { evaluate: async () => ({ model: "fixture", answers: passingAnswers, latency_ms: 0 }) },
		});
		controller.noteCompletionAccount({
			changes: [{ path: "owner.ts", reason: "It fixes the repository outcome.", serves: ["AC"] }],
			assumptions: [],
			regressions: [],
		});
		let diagnostic: string | undefined = "repository_work_baseline_unavailable";
		controller.setWorkDiffSource(() => ({
			base: "base",
			patch: diagnostic ? "" : "diff --git a/owner.ts b/owner.ts\n+fixed\n",
			omittedChars: 0,
			untracked: [],
			...(diagnostic ? { diagnostic } : {}),
		}));
		const unavailable = await controller.executeCompletionTransaction();
		expect(unavailable.verdict).toBe("blocked_external");
		expect(unavailable.failed_gates[0]?.id).toBe("repository_outcome_evidence_unavailable");
		expect(controller.verification.status().obligations).toEqual([]);
		expect(store.phase).not.toBe("complete");
		diagnostic = undefined;
		expect((await controller.executeCompletionTransaction()).verdict).toBe("complete");
	});

	it.each(["primary", "challenge", "both"] as const)(
		"keeps %s evaluator failures advisory after deterministic proof",
		async (failure) => {
			const store = new ExecutionStore({
				run_id: "advice",
				objective: {
					request: "Fix the outcome",
					normalized_goal: "Fix the outcome",
					acceptance_criteria: [{ id: "AC", text: "Outcome verified", required: true }],
				},
				repo: { root: "/repo", baseline_revision: "base" },
			});
			store.recordVerification({ kind: "unit_test", status: "passed", covers_acceptance_ids: ["AC"] });
			const evaluate = vi.fn(async (input: { questions: Record<string, unknown> }) => {
				const challenge = Object.hasOwn(input.questions, "missing_requirement");
				if (failure === "both" || (challenge ? failure === "challenge" : failure === "primary"))
					throw new Error("semantic service failed");
				return { model: "fixture", answers: passingAnswers, latency_ms: 1 };
			});
			const controller = new SystemOneController({ store, adapter: { evaluate } });
			const result = await controller.executeCompletionTransaction();
			expect(result.verdict).toBe("complete");
			expect(result.failed_gates).toEqual([]);
			expect(result.advisories).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ reason: expect.stringContaining("semantic service failed") }),
				]),
			);
			expect(evaluate).toHaveBeenCalledTimes(2);
			expect(controller.isEvaluating).toBe(false);
			expect(store.phase).toBe("verifying");
		},
	);

	it("keeps a received finding ahead of ordinary work until it is verified and revised", async () => {
		const store = new ExecutionStore({
			run_id: "verify",
			objective: {
				request: "Fix",
				normalized_goal: "Fix",
				acceptance_criteria: [{ id: "AC", text: "Verified", required: true }],
			},
			repo: { root: "/repo", baseline_revision: "base" },
		});
		store.recordVerification({ kind: "unit_test", status: "passed", covers_acceptance_ids: ["AC"] });
		let revised = false;
		const controller = new SystemOneController({
			store,
			adapter: {
				evaluate: async () => ({
					model: "fixture",
					answers: { ...passingAnswers, missing_requirement: !revised },
					latency_ms: 1,
				}),
			},
		});
		let candidate = "base";
		let snapshot: SemanticVerificationSnapshot | undefined;
		controller.setVerificationHost({
			storage: {
				getBranchKey: () => "verify",
				readRecords: () => snapshot,
				appendRecord: (_key, record) => {
					snapshot = record;
				},
			},
			getReceiverId: () => "verify",
			getCandidate: () => ({ id: candidate, scope: "/repo", kind: "repository" }),
			captureFence: () => () => true,
		});
		const rejected = await controller.executeCompletionTransaction();
		expect(rejected.verdict).toBe("verify_more");
		expect(rejected.failed_gates).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "JEV-CHALLENGE-missing_requirement" })]),
		);
		expect(store.phase).not.toBe("complete");
		const priority = controller.peekControlDirective();
		expect(priority).toMatchObject({
			objectiveRoute: "deterministic_test",
			reasonCodes: expect.arrayContaining(["same_lane_verification_required"]),
		});
		controller.noteControlDirective({
			source: "postflight",
			objectiveRoute: "completion_candidate",
			reasonCodes: ["ordinary_work"],
		});
		expect(controller.peekControlDirective()).toBe(priority);
		const replacement = { ...priority!, reasonCodes: ["same_lane_verification_required", "fresh_finding"] };
		controller.noteControlDirective(replacement);
		expect(controller.consumeControlDirective(priority)).toBeUndefined();
		expect(controller.verification.status().obligations).toHaveLength(2);
		expect(controller.peekControlDirective()?.reasonCodes.join(" ")).toContain("fresh_finding");
		expect((await controller.executeCompletionTransaction()).verdict).toBe("verify_more");
		expect(controller.consumeControlDirective(controller.peekControlDirective())).toBeUndefined();
		revised = true;
		// A clean later evaluation or acknowledged executor is insufficient: prove the repair.
		expect((await controller.executeCompletionTransaction()).verdict).toBe("verify_more");
		const verification = controller.verification;
		const reproduction = verification.beginCall("verify", "bash");
		verification.finishCall({
			callId: reproduction,
			tool: "bash",
			args: { command: "reproduce" },
			output: "Confirmed defect",
			succeeded: false,
		});
		const repair = verification.beginCall("verify", "edit");
		candidate = "fixed";
		verification.finishCall({
			callId: repair,
			tool: "edit",
			args: { path: "owner.ts" },
			output: "Fixed cause",
			succeeded: true,
		});
		const recheck = verification.beginCall("verify", "bash");
		verification.finishCall({
			callId: recheck,
			tool: "bash",
			args: { command: "recheck" },
			output: "PASS: outcome verified",
			succeeded: true,
		});
		const status = verification.status();
		const evidence = status.receipts.map((receipt, index) => ({
			receiptId: receipt.id,
			role: (["reproduction", "repair", "recheck"] as const)[index],
		}));
		for (const obligation of status.obligations) {
			expect(await verification.resolve({ id: obligation.id, disposition: "repaired", evidence })).toMatchObject({
				status: "resolved",
			});
		}
		expect((await controller.executeCompletionTransaction()).verdict).toBe("complete");
	});

	it.each(["primary", "challenge", "before"] as const)(
		"propagates %s cancellation and leaves completion uncommitted",
		async (at) => {
			const store = new ExecutionStore({
				run_id: "cancel",
				objective: {
					request: "Work",
					normalized_goal: "Work",
					acceptance_criteria: [{ id: "AC", text: "Outcome verified", required: true }],
				},
				repo: { root: "/repo", baseline_revision: "base" },
			});
			store.recordVerification({ kind: "unit_test", status: "passed", covers_acceptance_ids: ["AC"] });
			const abort = new AbortController();
			const cancelled = new Error("owner cancelled");
			const evaluate = vi.fn(
				async (input: { questions: Record<string, unknown> }, options?: { signal?: AbortSignal }) => {
					expect(options?.signal).toBe(abort.signal);
					if (at === "primary" || Object.hasOwn(input.questions, "missing_requirement")) {
						abort.abort(cancelled);
						throw cancelled;
					}
					return { model: "fixture", answers: {}, latency_ms: 1 };
				},
			);
			const controller = new SystemOneController({ store, adapter: { evaluate } });
			if (at === "before") abort.abort(cancelled);
			await expect(controller.executeCompletionTransaction(false, { signal: abort.signal })).rejects.toBe(cancelled);
			expect(store.phase).not.toBe("complete");
			expect(controller.isEvaluating).toBe(false);
			// Both stages start together, so a cancellation after the start has already reached both.
			expect(evaluate).toHaveBeenCalledTimes(at === "before" ? 0 : 2);
		},
	);
});
