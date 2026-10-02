import { describe, expect, it } from "vitest";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";

describe("System One Completion Gate", () => {
	function createStoreWithTask(): ExecutionStore {
		const store = new ExecutionStore({
			run_id: "comp-test-run",
			objective: {
				request: "Fix NPE when user account is null",
				normalized_goal: "Fix NullPointerException when account is null",
				acceptance_criteria: [
					{ id: "AC-1", text: "Null account handled gracefully", required: true },
					{ id: "AC-2", text: "Unit test covers null account case", required: true },
				],
				constraints: [{ id: "C-1", text: "Do not catch generic Throwable", severity: "hard" }],
			},
			repo: {
				root: "/workspace",
				baseline_revision: "rev-001",
			},
		});
		return store;
	}

	it("rejects completion on failing tests before Jev can override (R-020, R-035)", async () => {
		const store = createStoreWithTask();

		// Record a failing test
		store.recordVerification({
			kind: "unit_test",
			status: "failed",
			covers_acceptance_ids: ["AC-1"],
		});

		// Worker signals completion candidate
		store.applyWorkerTurn({
			run_id: store.runId,
			step_id: "S-final",
			requested_action: "none",
			claims: [],
			hypothesis_updates: [],
			requested_tools: [],
			completion_candidate: true,
		});

		// Mock adapter returning favorable answers
		const fauxAdapter = {
			evaluate: async () => ({
				model: "jev-1.13.0",
				answers: {
					outcomes_achieved: { noul: 0.99 },
					completion_verdict: { choice: "complete", confidence: 0.99, probabilities: { complete: 0.99 } },
				},
				latency_ms: 10,
			}),
		};

		const controller = new SystemOneController({
			store,
			adapter: fauxAdapter,
		});

		const result = await controller.executeCompletionTransaction(true);
		expect(result.verdict).toBe("rework");
		expect(result.failed_gates.some((g) => g.id === "G-TEST")).toBe(true);
		// State phase must NOT be complete!
		expect(store.phase).not.toBe("complete");
	});

	it("rejects completion when a completion-critical claim is unsupported (R-054)", async () => {
		const store = createStoreWithTask();

		// Mark tests and criteria as passing
		store.recordVerification({
			kind: "unit_test",
			status: "passed",
			covers_acceptance_ids: ["AC-1", "AC-2"],
		});
		store.verifyConstraint("C-1");

		// Add an unsupported completion-critical claim
		store.recordClaim({
			text: "Legacy system handles null accounts identically",
			materiality: "completion_critical",
			evidence_ids: ["NON_EXISTENT_EVIDENCE"],
		});

		const fauxAdapter = {
			evaluate: async () => ({
				model: "jev-1.13.0",
				answers: {
					outcomes_achieved: { noul: 0.99 },
					completion_verdict: { choice: "complete", confidence: 0.99, probabilities: { complete: 0.99 } },
				},
				latency_ms: 10,
			}),
		};

		const controller = new SystemOneController({
			store,
			adapter: fauxAdapter,
		});

		const result = await controller.executeCompletionTransaction(true);
		expect(result.verdict).toBe("rework");
		expect(result.failed_gates.some((g) => g.id === "G-EVIDENCE")).toBe(true);
		expect(store.phase).not.toBe("complete");
	});

	/** What live System One reads for each claim in the model's account, by claim index. */
	function adapterForAccount(verdicts: Record<number, "confirmed" | "refuted" | "unsettled">) {
		return {
			evaluate: async (input: { questions: Record<string, unknown> }) => {
				const keys = Object.keys(input.questions);
				if (keys.some((key) => key.startsWith("shows_true_"))) {
					const answers: Record<string, unknown> = {};
					for (const key of keys) {
						const index = Number(key.split("_").at(-1));
						const verdict = verdicts[index] ?? "confirmed";
						const shown = verdict === "confirmed" ? 0.97 : verdict === "refuted" ? 0.03 : 0.5;
						const contradicted = verdict === "refuted" ? 0.96 : verdict === "confirmed" ? 0.02 : 0.5;
						answers[key] = { noul: key.startsWith("shows_true_") ? shown : contradicted };
					}
					return { model: "jev-1.13.0", answers, latency_ms: 10 };
				}
				const challenge = Object.hasOwn(input.questions, "missing_requirement");
				return {
					model: "jev-1.13.0",
					answers: challenge
						? { missing_requirement: { noul: 0.01 } }
						: {
								outcomes_achieved: { noul: 0.95 },
								required_behavior_unverified: { noul: 0.02 },
								material_claim_unsupported: { noul: 0.02 },
							},
					latency_ms: 10,
				};
			},
		};
	}

	const CODE_PATCH =
		"diff --git a/src/account.ts b/src/account.ts\n--- a/src/account.ts\n+++ b/src/account.ts\n@@\n-return account.name;\n+return account?.name ?? '';\n";

	function repositoryFix(adapter: ReturnType<typeof adapterForAccount>) {
		const store = createStoreWithTask();
		store.recordVerification({
			kind: "unit_test",
			status: "passed",
			command: "vitest run account.test.ts",
			covers_acceptance_ids: ["AC-1", "AC-2"],
		});
		store.verifyConstraint("C-1");
		const controller = new SystemOneController({ store, adapter });
		controller.setWorkDiffSource(() => ({ base: "base", patch: CODE_PATCH, omittedChars: 0, untracked: [] }));
		return { store, controller };
	}

	const GOOD_ACCOUNT = {
		changes: [
			{
				path: "src/account.ts",
				reason: "It returns an empty name for a null account instead of throwing.",
				serves: ["AC-1"],
			},
		],
		assumptions: [],
		regressions: [{ path: "a null account", evidenceIds: ["VR-1"] }],
		cause: { claim: "The name was read from a null account without a guard.", evidenceIds: ["VR-1"] },
	};

	it("completes a bug fix whose account System One confirms against the cited evidence", async () => {
		const { store, controller } = repositoryFix(adapterForAccount({}));
		controller.noteCompletionAccount(GOOD_ACCOUNT);
		const result = await controller.executeCompletionTransaction(true);
		expect(result).toMatchObject({ verdict: "complete", failed_gates: [] });
		expect(store.phase).not.toBe("complete");
	});

	it("refuses a bug fix whose stated cause the cited evidence contradicts, naming the claim and opening no obligation", async () => {
		// Claims, in order: what the one changed file does, what it serves, the regression path, the cause.
		const { store, controller } = repositoryFix(adapterForAccount({ 3: "refuted" }));
		controller.noteCompletionAccount(GOOD_ACCOUNT);
		const result = await controller.executeCompletionTransaction(true);
		expect(result.verdict).toBe("verify_more");
		expect(result.failed_gates).toEqual([
			expect.objectContaining({ id: "account_contradicted:cause", reason: expect.stringContaining("stated cause") }),
		]);
		expect(controller.verification.status().obligations).toEqual([]);
		expect(store.phase).not.toBe("complete");
	});

	it("refuses when the evidence contradicts a stated assumption", async () => {
		const { controller } = repositoryFix(adapterForAccount({ 2: "refuted" }));
		controller.noteCompletionAccount({
			...GOOD_ACCOUNT,
			regressions: [],
			assumptions: [{ claim: "Every caller passes a string id.", evidenceIds: ["VR-1"] }],
		});
		const result = await controller.executeCompletionTransaction(true);
		expect(result.failed_gates).toEqual([expect.objectContaining({ id: "account_contradicted:assumption" })]);
	});

	it("transitions phase to complete when deterministic, primary, and challenge gates all pass (R-002, R-058)", async () => {
		const store = createStoreWithTask();

		store.recordVerification({
			kind: "unit_test",
			status: "passed",
			covers_acceptance_ids: ["AC-1", "AC-2"],
		});
		store.verifyConstraint("C-1");

		const fauxAdapter = {
			evaluate: async (input: { questions: Record<string, unknown> }) => {
				const isChallenge = Object.hasOwn(input.questions, "missing_requirement");
				if (isChallenge) {
					return {
						model: "jev-1.13.0",
						answers: {
							missing_requirement: { noul: 0.01 },
							hidden_assumption: { noul: 0.01 },
							plausible_regression_not_tested: { noul: 0.01 },
							conclusion_overstates_evidence: { noul: 0.01 },
						},
						latency_ms: 10,
					};
				}
				return {
					model: "jev-1.13.0",
					answers: {
						outcomes_achieved: { noul: 0.96 },
						root_cause_addressed: { noul: 0.95 },
						required_behavior_unverified: { noul: 0.01 },
						material_claim_unsupported: { noul: 0.01 },
						out_of_scope_change_present: { noul: 0.01 },
						duplicate_responsibility_introduced: { noul: 0.01 },
						completion_verdict: {
							choice: "complete",
							confidence: 0.96,
							probabilities: { complete: 0.96, rework: 0.04 },
						},
					},
					latency_ms: 10,
				};
			},
		};

		const controller = new SystemOneController({
			store,
			adapter: fauxAdapter,
		});

		const result = await controller.executeCompletionTransaction(true);
		expect(result.verdict).toBe("complete");
		expect(result.failed_gates).toHaveLength(0);
		// Omitted persistTerminal does not persist the store. Outer finalization does.
		expect(store.phase).not.toBe("complete");
	});
});
