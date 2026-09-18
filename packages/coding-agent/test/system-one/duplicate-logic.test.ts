import { describe, expect, it } from "vitest";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";

describe("System One Duplicate Logic Prevention", () => {
	it("identifies semantic duplication and recommends reuse or shared extraction (R-013, R-014)", async () => {
		const store = new ExecutionStore({
			run_id: "dup-run-1",
			objective: {
				request: "Format billing amount with currency symbol",
				normalized_goal: "Format currency amounts consistently",
				acceptance_criteria: [{ id: "AC-1", text: "Formatted amounts display localized currency", required: true }],
			},
			repo: {
				root: "/workspace",
				baseline_revision: "rev-1",
			},
		});

		const existingLogic = `
export function formatCurrency(cents: number, currency: string): string {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}
`;

		const proposedLogic = `
export function renderPrice(amountCents: number, currencyCode: string): string {
    return (amountCents / 100).toLocaleString('en-US', { style: 'currency', currency: currencyCode });
}
`;

		// Jev detects that both functions implement the same responsibility and recommends reuse_existing
		const fauxAdapter = {
			evaluate: async () => ({
				model: "jev-1.13.0",
				answers: {
					same_responsibility: { noul: 0.98 },
					reuse_preferable: {
						choice: "reuse_existing",
						confidence: 0.95,
						probabilities: { reuse_existing: 0.95, extract_shared: 0.03, separate_required: 0.02 },
					},
				},
				latency_ms: 10,
			}),
		};

		const controller = new SystemOneController({
			store,
			adapter: fauxAdapter,
		});

		const result = await controller.validateDuplicateLogic(existingLogic, proposedLogic);
		expect(result.sameResponsibility).toBe(true);
		expect(result.reusePreferable).toBe("reuse_existing");
		expect(result.decision.policy_result).toBe("duplicate:reuse_existing");
	});

	it("recognizes when similar-looking logic actually requires separate implementation", async () => {
		const store = new ExecutionStore({
			run_id: "dup-run-2",
			objective: {
				request: "Implement token counter for pricing vs for rate limiting",
				normalized_goal: "Implement token counter",
				acceptance_criteria: [{ id: "AC-1", text: "Token counting works", required: true }],
			},
			repo: { root: "/workspace", baseline_revision: "rev-1" },
		});

		const existingLogic = "function countBillableTokens(tokens: TokenUsage): number { ... }";
		const proposedLogic = "function countRateLimitTokens(headers: Headers): number { ... }";

		const fauxAdapter = {
			evaluate: async () => ({
				model: "jev-1.13.0",
				answers: {
					same_responsibility: { noul: 0.05 }, // Confident false!
					reuse_preferable: {
						choice: "separate_required",
						confidence: 0.94,
						probabilities: { separate_required: 0.94, reuse_existing: 0.03, extract_shared: 0.03 },
					},
				},
				latency_ms: 10,
			}),
		};

		const controller = new SystemOneController({
			store,
			adapter: fauxAdapter,
		});

		const result = await controller.validateDuplicateLogic(existingLogic, proposedLogic);
		expect(result.sameResponsibility).toBe(false);
		expect(result.reusePreferable).toBe("separate_required");
	});
});
