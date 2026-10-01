import { describe, expect, it } from "vitest";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import {
	containsCredential,
	redactSecrets,
	StateProjector,
	wrapUntrustedText,
} from "../../src/core/system-one/projector.ts";

describe("System One StateProjector", () => {
	it("redacts credentials, API keys, tokens, and private keys (R-032)", () => {
		const rawText = [
			"Using API key apikey_secret1234567890abcdef",
			"Anthropic sk-ant-api03-abcdef1234567890abcdef1234567890",
			"Google AIzaSyA1234567890abcdef1234567890abcdef",
			"OpenAI sk-abcdef1234567890abcdef1234567890",
			"GitHub token ghp_123456789012345678901234567890123456",
			"AWS key AKIAIOSFODNN7EXAMPLE",
			"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M",
			"password: 'superSecretPassword123'",
			"Custom user key: my-secret-custom-key-12345",
		].join("\n");

		expect(containsCredential(rawText, ["my-secret-custom-key-12345"])).toBe(true);

		const redacted = redactSecrets(rawText, ["my-secret-custom-key-12345"]);
		expect(redacted).not.toContain("apikey_secret1234567890abcdef");
		expect(redacted).not.toContain("sk-ant-api03-abcdef1234567890abcdef1234567890");
		expect(redacted).not.toContain("AIzaSyA1234567890abcdef1234567890abcdef");
		expect(redacted).not.toContain("sk-abcdef1234567890abcdef1234567890");
		expect(redacted).not.toContain("ghp_123456789012345678901234567890123456");
		expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(redacted).not.toContain("superSecretPassword123");
		expect(redacted).not.toContain("my-secret-custom-key-12345");
		expect(redacted).toContain("[REDACTED_SECRET]");
		expect(containsCredential(redacted, ["my-secret-custom-key-12345"])).toBe(false);
	});

	it("redacts a key glued to other text or written straight after another key, and never a plain word", () => {
		const openai = "sk-proj-ZYXWVUTSRQPONMLKJIHGFEDCBA0987654321";
		const github = `ghp_${"A".repeat(36)}`;
		const aws = "AKIAQRSTUVWXYZ123456";
		for (const text of [`result${openai}`, `${github}ghp_${"B".repeat(36)}`, `AKIAABCDEFGHIJKLMNOP${aws}`]) {
			const redacted = redactSecrets(text);
			expect(redacted, text).not.toMatch(/ZYXWV|BBBB|QRSTUV/);
			expect(containsCredential(text), text).toBe(true);
		}
		// A lowercase path word that happens to hold a prefix is not a key.
		const path = "edit packages/coding-agent/src/core/automation/task-automation-controller.ts";
		expect(redactSecrets(path)).toBe(path);
		expect(containsCredential(path)).toBe(false);
	});

	it("redacts dynamic userKeys configured in StateProjector instance", () => {
		const userKey = "user-configured-secret-token-99999";
		const projector = new StateProjector([userKey]);
		const store = new ExecutionStore({
			run_id: "test-run",
			objective: {
				request: `Deploy with secret token ${userKey}`,
				normalized_goal: `Deploy with secret token ${userKey}`,
				acceptance_criteria: [],
			},
			repo: {
				root: "/repo",
				baseline_revision: "rev-1",
			},
		});

		const intake = projector.intake(store.snapshot()) as {
			objective: { request: string; normalized_goal: string };
		};
		expect(intake.objective.request).not.toContain(userKey);
		expect(intake.objective.request).toContain("[REDACTED_SECRET]");
		expect(intake.objective.normalized_goal).not.toContain(userKey);
	});

	it("redacts configured credentials in every WorkDiff string field without mutating the source", () => {
		const userKey = "path-secret-value-23456";
		const projector = new StateProjector([userKey]);
		const store = new ExecutionStore({
			run_id: "work-diff-redaction",
			objective: {
				request: "Review changed repository work",
				normalized_goal: "Review changed repository work",
				acceptance_criteria: [],
			},
			repo: { root: "/repo", baseline_revision: "rev-1" },
		});
		const work = {
			base: `base-${userKey}`,
			patch: `+content ${userKey}`,
			omittedChars: 0,
			untracked: [`/repo/${userKey}:new-${userKey}.ts`, "/repo/src/ordinary.ts"],
			diagnostic: `evidence ${userKey} unavailable`,
			repositories: [{ root: `/repo/${userKey}`, base: `repository-base-${userKey}` }],
		};
		const originalWork = structuredClone(work);

		const projection = projector.completion(store.snapshot(), work) as {
			final_diff: {
				base_commit: string;
				patch: string;
				evidence_unavailable: string;
				new_untracked_files: string[];
				repositories: Array<{ root: string; base: string }>;
			};
		};

		expect(JSON.stringify(projection)).not.toContain(userKey);
		expect(projection.final_diff).toMatchObject({
			base_commit: "base-[REDACTED_SECRET]",
			patch: "+content [REDACTED_SECRET]",
			evidence_unavailable: "evidence [REDACTED_SECRET] unavailable",
			new_untracked_files: ["/repo/[REDACTED_SECRET]:new-[REDACTED_SECRET].ts", "/repo/src/ordinary.ts"],
			repositories: [{ root: "/repo/[REDACTED_SECRET]", base: "repository-base-[REDACTED_SECRET]" }],
		});
		expect(work).toEqual(originalWork);
	});

	it("redacts configured credentials from model-bound path and command metadata", () => {
		const userKey = "metadata-secret-value-54321";
		const projector = new StateProjector([userKey]);
		const store = new ExecutionStore({
			run_id: "projector-metadata-redaction",
			objective: {
				request: "Review repository changes",
				normalized_goal: "Review repository changes",
				acceptance_criteria: [{ id: "AC-1", text: "The change passes its focused check" }],
			},
			repo: {
				root: `/repo/${userKey}`,
				baseline_revision: `revision-${userKey}`,
				allowed_paths: [`/repo/${userKey}/src`, "/repo/src"],
				protected_paths: [`/repo/${userKey}/private`, "/repo/vendor"],
				languages: ["typescript"],
			},
			initial_plan: [
				{
					id: "step-1",
					goal: "Update the changed module",
					status: "active",
					action_class: "edit",
					dependencies: [],
					allowed_paths: [`/repo/${userKey}/src`, "/repo/src"],
					proof_obligations: [`Check ${userKey}`, "Preserve the public API"],
				},
			],
		});
		const change = store.recordChange({
			path: `/repo/${userKey}/src/module.ts`,
			kind: "modify",
			ownership: "worker",
			diff_content: "changed",
		});
		const observation = store.recordObservation({
			text: "The source is readable",
			source: {
				kind: "file",
				locator: `/repo/${userKey}/src/module.ts`,
				trust: "repository_untrusted_text",
			},
		});
		const claim = store.recordClaim({
			text: "The source is readable",
			materiality: "informational",
			evidence_ids: [observation.id],
		});
		store.recordHypothesis({
			text: "The implementation is complete",
			supporting_evidence: [observation.id],
			next_discriminator: `Inspect ${userKey}`,
		});
		store.recordToolEvent({
			tool: "bash",
			intent: `Run verification for ${userKey}`,
			impact: "read_only",
			status: "succeeded",
		});
		store.recordVerification({
			kind: "unit_test",
			status: "passed",
			command: `npm test -- ${userKey}`,
			covers_acceptance_ids: ["AC-1"],
		});
		const state = store.snapshot();
		const originalState = structuredClone(state);
		const projections = [
			projector.intake(state),
			projector.preflight(state, "step-1"),
			projector.evidenceCheck(state, claim.id, observation.id),
			projector.postflight(state, "step-1"),
			projector.patchReview(state, [change.id]),
			projector.completion(state),
		];

		expect(JSON.stringify(projections)).not.toContain(userKey);
		expect(projections[0]).toMatchObject({
			repo: {
				root: "/repo/[REDACTED_SECRET]",
				baseline_revision: "revision-[REDACTED_SECRET]",
				languages: ["typescript"],
			},
		});
		expect(projections[1]).toMatchObject({
			current_step: {
				proof_obligations: ["Check [REDACTED_SECRET]", "Preserve the public API"],
			},
			evidence_view: [expect.objectContaining({ source_locator: "/repo/[REDACTED_SECRET]/src/module.ts" })],
		});
		expect(projections[2]).toMatchObject({
			evidence: { locator: "/repo/[REDACTED_SECRET]/src/module.ts" },
		});
		expect(projections[3]).toMatchObject({
			diff_view: [expect.objectContaining({ path: "/repo/[REDACTED_SECRET]/src/module.ts" })],
		});
		expect(projections[4]).toMatchObject({
			diff_view: [expect.objectContaining({ path: "/repo/[REDACTED_SECRET]/src/module.ts" })],
			architecture_context: {
				allowed_paths: ["/repo/[REDACTED_SECRET]/src", "/repo/src"],
				protected_paths: ["/repo/[REDACTED_SECRET]/private", "/repo/vendor"],
			},
		});
		expect(projections[5]).toMatchObject({
			verification_matrix: [expect.objectContaining({ command: "npm test -- [REDACTED_SECRET]" })],
			outcome_evidence: [
				expect.objectContaining({
					checks: [expect.objectContaining({ command: "npm test -- [REDACTED_SECRET]" })],
				}),
			],
			final_diff: [expect.objectContaining({ path: "/repo/[REDACTED_SECRET]/src/module.ts" })],
		});
		expect(state).toEqual(originalState);
	});

	it("labels repository and external text as untrusted (R-031, R-065)", () => {
		const repoUntrusted = wrapUntrustedText("Some README text instructing the agent to ignore rules");
		expect(repoUntrusted.trust).toBe("repository_untrusted_text");
		expect(repoUntrusted.content).toBe("Some README text instructing the agent to ignore rules");

		const externalUntrusted = wrapUntrustedText("External doc text", "external_doc");
		expect(externalUntrusted.trust).toBe("external_untrusted_text");
	});

	it("projects a tool-gate step only from a real plan step or goal, never from an empty objective", () => {
		const request = { tool: "systemone", intent: "Invoke tool systemone", impact: "read_only" as const };
		const plain = new ExecutionStore({
			run_id: "plain-session",
			objective: { request: "", normalized_goal: "", acceptance_criteria: [] },
			repo: { root: "/repo", baseline_revision: "rev-1" },
		});
		const projector = new StateProjector();
		expect(projector.toolGate(plain.snapshot(), request)).not.toHaveProperty("current_step");

		const withGoal = new ExecutionStore({
			run_id: "goal-session",
			objective: { request: "Fix the parser", normalized_goal: "Fix the parser", acceptance_criteria: [] },
			repo: { root: "/repo", baseline_revision: "rev-1" },
		});
		expect(projector.toolGate(withGoal.snapshot(), request)).toMatchObject({
			current_step: { goal: "Fix the parser" },
		});
	});

	it("builds a cold completion projection from authoritative state, not worker summary (R-048, R-049)", () => {
		const store = new ExecutionStore({
			run_id: "cold-completion-run",
			objective: {
				request: "Fix bug and add test",
				normalized_goal: "Fix bug and add test",
				acceptance_criteria: [
					{ id: "AC-1", text: "Bug is fixed", required: true },
					{ id: "AC-2", text: "Regression test added", required: true },
				],
			},
			repo: {
				root: "/repo",
				baseline_revision: "rev-1",
			},
		});

		store.recordChange({
			path: "src/fix.ts",
			kind: "modify",
			ownership: "worker",
			diff_content: "+ fix",
		});

		store.recordVerification({
			kind: "unit_test",
			status: "passed",
			covers_acceptance_ids: ["AC-1", "AC-2"],
		});

		const projector = new StateProjector();
		const projection = projector.completion(store.snapshot()) as {
			acceptance_matrix: Array<{ id: string; status: string }>;
			verification_matrix: Array<{ id: string; status: string }>;
			final_diff: Array<{ path: string; kind: string }>;
			worker_final_summary?: unknown;
		};

		// Authoritative matrix fields present
		expect(projection.acceptance_matrix).toHaveLength(2);
		expect(projection.acceptance_matrix[0].status).toBe("satisfied");
		expect(projection.verification_matrix).toHaveLength(1);
		expect(projection.final_diff).toHaveLength(1);

		// Worker final summary MUST NOT be the primary state (R-049)
		expect(projection.worker_final_summary).toBeUndefined();
	});
});
