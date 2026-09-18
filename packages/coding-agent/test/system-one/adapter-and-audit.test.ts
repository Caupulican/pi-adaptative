import { describe, expect, it, vi } from "vitest";
import { SystemOneJevAdapter } from "../../src/core/system-one/adapter.ts";
import { AuditStore } from "../../src/core/system-one/audit.ts";

describe("System One Adapter and Audit", () => {
	it("enforces pinned model jev-1.13.0 and rejects model drift (R-006, R-007)", async () => {
		// Mock reviewer that returns an unpinned model drift
		const driftingReviewer = {
			evaluate: async (input: { model?: string }) => ({
				request: { model: input.model ?? "jev-1.13.0" },
				response: {
					model: "jev-preview-unpinned", // Drift!
					answers: { test: { noul: 0.99 } },
				},
				elapsedMs: 50,
			}),
		};

		const adapter = new SystemOneJevAdapter(driftingReviewer);
		await expect(
			adapter.evaluate({
				state: { test: true },
				questions: { test: { type: "noul", instructions: "test" } },
			}),
		).rejects.toThrow("Model drift detected");
	});

	it("applies failure policy: degrades open on read-only with audit, fails closed on repo mutation (R-066)", async () => {
		vi.useFakeTimers();
		try {
			const failingReviewer = {
				evaluate: async () => {
					throw new Error("TypeSafe API 503 Service Unavailable");
				},
			};

			const adapter = new SystemOneJevAdapter(failingReviewer);

			const readOnlyRes = adapter.evaluate(
				{
					state: { test: true },
					questions: { test: { type: "noul", instructions: "test" } },
				},
				{ impact: "read_only" },
			);
			await vi.runAllTimersAsync();
			expect((await readOnlyRes).answers).toEqual({});

			const mutationRes = adapter.evaluate(
				{
					state: { test: true },
					questions: { test: { type: "noul", instructions: "test" } },
				},
				{ impact: "repo_mutation" },
			);
			const mutationAssert = expect(mutationRes).rejects.toThrow(
				"Jev System One unavailable for impact 'repo_mutation'",
			);
			await vi.runAllTimersAsync();
			await mutationAssert;
		} finally {
			vi.useRealTimers();
		}
	});

	it("persists full decision and tool action audit trail and provides explanation (R-040, R-041)", () => {
		const audit = new AuditStore();
		const runId = "audit-run-123";

		audit.recordDecision(runId, {
			id: "DEC-1",
			stage: "preflight",
			model: "jev-1.13.0",
			question_catalog_version: "1.0.0",
			questions_hash: "hash-questions-001",
			state_hash: "hash-state-001",
			answers: { step_relevant: { noul: 0.95 } },
			policy_result: "allow",
			timestamp: new Date().toISOString(),
		});

		audit.recordToolAction(runId, {
			id: "TE-1",
			tool: "file_read",
			intent: "Read checkout.ts",
			status: "succeeded",
			timestamp: new Date().toISOString(),
			impact: "read_only",
			input_hash: "input-hash-1",
			output_hash: "output-hash-1",
			observation_ids: ["OBS-1"],
		});

		const decisions = audit.getDecisionsForRun(runId);
		expect(decisions).toHaveLength(1);
		expect(decisions[0].model).toBe("jev-1.13.0");
		expect(decisions[0].policy_result).toBe("allow");

		const tools = audit.getToolActionsForRun(runId);
		expect(tools).toHaveLength(1);
		expect(tools[0].tool).toBe("file_read");

		const explanation = audit.explainDecision("DEC-1");
		expect(explanation).toBeDefined();
		expect(explanation?.explanation).toContain("Stage: preflight");
		expect(explanation?.explanation).toContain("Model: jev-1.13.0");
		expect(explanation?.explanation).toContain("Policy Result: allow");
	});
});
