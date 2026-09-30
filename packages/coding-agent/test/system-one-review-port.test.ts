import { describe, expect, it, vi } from "vitest";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import type {
	SystemOneEvaluationRecord,
	SystemOneReviewPort,
	SystemOneReviewRecord,
} from "../src/core/review/system-one-review-port.ts";
import { SystemOneReviewError } from "../src/core/review/system-one-review-port.ts";
import type { EvaluationInput, ReviewInput } from "../src/core/review/typesafe-contract.ts";
import { REVIEW_CONFIDENCE } from "../src/core/review/typesafe-contract.ts";
import { TypeSafeEvidenceStore } from "../src/core/review/typesafe-evidence-store.ts";
import { createSystemOneToolDefinition } from "../src/core/tools/systemone.ts";

const evaluation: EvaluationInput = {
	state: { source: "src/cancel.ts", check: "cancel then assert release" },
	questions: {
		release_once: {
			type: "noul",
			instructions: "Does cancellation release the held resource exactly once?",
		},
	},
};

const response: SystemOneEvaluationRecord["response"] = {
	model: "fixture/reviewer",
	answers: { release_once: { type: "noul", noul: 0.99 } },
	usage: { input_tokens: 12, output_tokens: 4 },
};

function plainReviewer(): SystemOneReviewPort {
	const evaluationRecord: SystemOneEvaluationRecord = {
		request: { ...evaluation, model: "fixture/reviewer" },
		requestSha256: "a".repeat(64),
		response,
		attempts: 1,
		transportAttempts: [{ attempt: 1, status: 200, response }],
		elapsedMs: 3,
	};
	const reviewRecord: SystemOneReviewRecord = {
		...evaluationRecord,
		threshold: 0.95,
		expected: { release_once: "supports" },
		accepted: true,
		failures: [],
	};
	return {
		status: async () => ({
			enabled: true,
			model: "fixture/reviewer",
			confidence: REVIEW_CONFIDENCE,
			setup: "fixture setup",
			authenticationVerified: true,
			message: "fixture reviewer ready",
		}),
		evaluate: async (_input: EvaluationInput) => evaluationRecord,
		review: async (_input: ReviewInput) => reviewRecord,
	};
}

describe("provider-neutral System One review port", () => {
	it("uses the configured provider's setup instead of prescribing one vendor login", () => {
		const tool = createSystemOneToolDefinition(
			plainReviewer(),
			new TypeSafeEvidenceStore(createInMemoryArtifactStore()),
		);
		const guidance = tool.promptGuidelines.join("\n");
		expect(guidance).toContain("configured provider");
		expect(guidance).not.toContain("/login typesafe");
	});

	it("executes a plain structural reviewer through tool validation and evidence retention", async () => {
		const reviewer = plainReviewer();
		const tool = createSystemOneToolDefinition(reviewer, new TypeSafeEvidenceStore(createInMemoryArtifactStore()));
		const input = { action: "evaluate", evaluation } satisfies Parameters<typeof tool.execute>[1];

		const result = await tool.execute("plain-reviewer", input);

		expect(result.isError).not.toBe(true);
		expect(JSON.stringify(result.details)).toContain("fixture/reviewer");
		expect(JSON.stringify(result.details)).toContain("evidence");
	});

	it("rejects malformed action input before invoking a plain provider", async () => {
		const reviewer = plainReviewer();
		const evaluate = vi.fn(reviewer.evaluate);
		const review = vi.fn(reviewer.review);
		const status = vi.fn(reviewer.status);
		const tool = createSystemOneToolDefinition(
			{ ...reviewer, evaluate, review, status },
			new TypeSafeEvidenceStore(createInMemoryArtifactStore()),
		);

		const result = await tool.execute(
			"malformed-action",
			JSON.parse('{"action":"invented","evaluation":{}}') as Parameters<typeof tool.execute>[1],
		);

		expect(result.isError).toBe(true);
		expect(evaluate).not.toHaveBeenCalled();
		expect(review).not.toHaveBeenCalled();
		expect(status).not.toHaveBeenCalled();
	});

	it("retains a provider-neutral negative outcome as evidence without accepting it", async () => {
		const reviewer = plainReviewer();
		const failure = new SystemOneReviewError(
			"independent review rejected",
			"b".repeat(64),
			{ ...evaluation, model: "fixture/reviewer" },
			{ model: "fixture/reviewer", answers: { release_once: { type: "noul", noul: 0.01 } } },
			[{ attempt: 1, status: 200, response: { rejected: true } }],
		);
		const tool = createSystemOneToolDefinition(
			{ ...reviewer, evaluate: async () => Promise.reject(failure) },
			new TypeSafeEvidenceStore(createInMemoryArtifactStore()),
		);
		const input = { action: "evaluate", evaluation } satisfies Parameters<typeof tool.execute>[1];

		const result = await tool.execute("negative-outcome", input);

		expect(result.isError).toBe(true);
		expect(result.errorKind).toBe("operation_outcome");
		expect(result.details).toMatchObject({
			accepted: false,
			requestSha256: "b".repeat(64),
			response: { answers: { release_once: { noul: 0.01 } } },
			transportAttempts: [{ attempt: 1, status: 200, response: { rejected: true } }],
			evidence: { id: expect.any(String) },
		});
	});

	it("forwards caller cancellation and records no successful receipt", async () => {
		const controller = new AbortController();
		const reviewer = plainReviewer();
		let receivedSignal: AbortSignal | undefined;
		const tool = createSystemOneToolDefinition(
			{
				...reviewer,
				evaluate: async (_input, signal) => {
					receivedSignal = signal;
					return await new Promise<SystemOneEvaluationRecord>((_resolve, reject) => {
						if (signal?.aborted) reject(signal.reason);
						else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					});
				},
			},
			new TypeSafeEvidenceStore(createInMemoryArtifactStore()),
		);
		const input = { action: "evaluate", evaluation } satisfies Parameters<typeof tool.execute>[1];
		const pending = tool.execute("cancelled-provider", input, controller.signal);

		controller.abort(new Error("caller stopped"));
		const result = await pending;

		expect(receivedSignal).toBe(controller.signal);
		expect(result.isError).toBe(true);
		expect(result.errorKind).toBeUndefined();
		expect(result.details).toMatchObject({
			accepted: false,
			error: "System One review cancelled",
			evidence: { id: expect.any(String) },
		});
		expect(result.details).not.toHaveProperty("requestSha256");
	});
});
