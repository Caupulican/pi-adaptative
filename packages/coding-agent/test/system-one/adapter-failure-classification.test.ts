import { describe, expect, it, vi } from "vitest";
import { SystemOneReviewError } from "../../src/core/review/system-one-review-port.ts";
import { SystemOneReviewer } from "../../src/core/review/typesafe-reviewer.ts";
import { classifyJevFailure, JevAdapterFailure, SystemOneJevAdapter } from "../../src/core/system-one/adapter.ts";

const request = {
	model: "jev-1.13.0",
	state: {},
	questions: { check: { type: "noul" as const, instructions: "Is the evidence sufficient?" } },
};

describe("System One failure classification", () => {
	it("retains a sanitized HTTP 400 receipt and classifies rejection without sending impact or retrying", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(JSON.stringify({ error: "Invalid question apikey_private_fixture" }), { status: 400 }),
			);
		const sleep = vi.fn(async () => {});
		const reviewer = new SystemOneReviewer({ getApiKey: async () => "test-user-key", fetch: fetchMock });
		const adapter = new SystemOneJevAdapter(reviewer, undefined, { getApiKey: () => "test-user-key", sleep });
		const error: unknown = await adapter.evaluate(request, { impact: "read_only" }).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(JevAdapterFailure);
		if (!(error instanceof JevAdapterFailure)) throw new Error("Expected a classified rejection");
		expect(error.kind).toBe("invalid_request");
		expect(error.message).toContain("HTTP 400");
		expect(error.cause).toBeInstanceOf(SystemOneReviewError);
		if (!(error.cause instanceof SystemOneReviewError)) throw new Error("Expected a retained transport receipt");
		expect(error.cause.response).toEqual({ error: "Invalid question [REDACTED]" });
		expect(error.cause.transportAttempts).toEqual([
			{ attempt: 1, status: 400, response: { error: "Invalid question [REDACTED]" } },
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(request);
	});

	it.each([
		[400, "invalid_request"],
		[422, "invalid_request"],
		[429, "rate_limit"],
		[401, "unavailable"],
		[403, "unavailable"],
		[503, "unavailable"],
	] as const)("keeps structured HTTP %s distinct without multiplying transport retries", async (status, kind) => {
		const failure = new SystemOneReviewError(`TypeSafe HTTP ${status}`, "hash", request, {}, [
			{ attempt: 1, status: 503 },
			{ attempt: 2, status },
		]);
		const evaluate = vi.fn(async () => {
			throw failure;
		});
		const sleep = vi.fn(async () => {});
		const adapter = new SystemOneJevAdapter({ evaluate }, undefined, { getApiKey: () => "test-user-key", sleep });
		await expect(adapter.evaluate(request, { impact: "repo_mutation" })).rejects.toMatchObject({
			kind,
			cause: failure,
		});
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("rejects malformed questions locally as invalid requests before transport", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		const reviewer = new SystemOneReviewer({ getApiKey: async () => "test-user-key", fetch: fetchMock });
		const adapter = new SystemOneJevAdapter(reviewer, undefined, { getApiKey: () => "test-user-key" });
		await expect(
			adapter.evaluate({
				state: {},
				questions: { check: { type: "choice", instructions: "Select", criteria: {} } },
			}),
		).rejects.toMatchObject({ kind: "invalid_request" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not confuse usage persistence failures or cancelled work with rejected requests", () => {
		const failure = new SystemOneReviewError(
			"TypeSafe usage recording failed",
			"hash",
			request,
			{},
			[{ attempt: 1, status: 400 }],
			"usage_recording",
		);
		expect(classifyJevFailure(failure, false)).toBe("unavailable");
		expect(classifyJevFailure(failure, true)).toBe("cancelled");
		expect(classifyJevFailure(new Error("TypeSafe HTTP 400"), false)).toBe("invalid_request");
		expect(classifyJevFailure(new Error("Received 400 tokens"), false)).toBe("unavailable");
	});
});
