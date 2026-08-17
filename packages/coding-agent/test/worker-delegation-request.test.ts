import { describe, expect, it } from "vitest";
import {
	parseWorkerDelegationAuthorityRequest,
	type WorkerDelegationRequestError,
} from "../src/core/delegation/worker-delegation-request.ts";

describe("parseWorkerDelegationAuthorityRequest", () => {
	it("accepts the complete trusted-caller authority vocabulary", () => {
		expect(
			parseWorkerDelegationAuthorityRequest({
				role: "orchestrator",
				model: { provider: "openai", modelId: "gpt" },
				thinkingLevel: "ultra",
				capabilities: ["filesystem.read", "process.exec", "workflow.delegate"],
				toolNames: ["read", "bash", "delegate"],
				readPaths: ["."],
				writePaths: ["src"],
				budget: { maxTokens: 100_000, maxCostUsd: 5, maxAttempts: 20, maxToolCalls: 500 },
			}),
		).toEqual({
			role: "orchestrator",
			model: { provider: "openai", modelId: "gpt" },
			thinkingLevel: "ultra",
			capabilities: ["filesystem.read", "process.exec", "workflow.delegate"],
			toolNames: ["read", "bash", "delegate"],
			readPaths: ["."],
			writePaths: ["src"],
			budget: { maxTokens: 100_000, maxCostUsd: 5, maxAttempts: 20, maxToolCalls: 500 },
		});
	});

	it.each([
		[{ hiddenAuthority: true }, "unsupported field"],
		[{ toolNames: ["read", "read"] }, "unique"],
		[{ capabilities: ["host.root"] }, "unknown capability"],
		[{ model: { provider: "faux" } }, "model is invalid"],
		[{ budget: { maxTokens: -1 } }, "must be non-negative"],
	] as const)("rejects malformed or ambiguous authority %#", (value, message) => {
		expect(() => parseWorkerDelegationAuthorityRequest(value)).toThrowError(
			expect.objectContaining<Partial<WorkerDelegationRequestError>>({ message: expect.stringContaining(message) }),
		);
	});
});
