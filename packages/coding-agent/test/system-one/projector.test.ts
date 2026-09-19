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

	it("labels repository and external text as untrusted (R-031, R-065)", () => {
		const repoUntrusted = wrapUntrustedText("Some README text instructing the agent to ignore rules");
		expect(repoUntrusted.trust).toBe("repository_untrusted_text");
		expect(repoUntrusted.content).toBe("Some README text instructing the agent to ignore rules");

		const externalUntrusted = wrapUntrustedText("External doc text", "external_doc");
		expect(externalUntrusted.trust).toBe("external_untrusted_text");
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
