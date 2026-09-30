// @isolated: uses fake timers to exercise the provider retry deadline and backoff
import { afterEach, describe, expect, it, vi } from "vitest";
import { SystemOneReviewer } from "../src/core/review/typesafe-reviewer.ts";
import { SystemOneJevAdapter, type SystemOneReviewerLike } from "../src/core/system-one/adapter.ts";

const input = { state: "fixture", questions: { q: { type: "noul" as const, instructions: "Check" } } };
const answer = () =>
	Response.json({
		model: "jev-1.13.0",
		answers: { q: { type: "noul", noul: 1 } },
		usage: { input_tokens: 1, output_tokens: 1 },
	});

afterEach(() => vi.useRealTimers());

describe("System One transport retry owner", () => {
	it.each([false, true])(
		"retries classified network failures once per provider attempt (exhausted: %s)",
		async (exhausted) => {
			vi.useFakeTimers();
			let attempts = 0;
			const fetcher = vi.fn<typeof fetch>(async () => {
				attempts++;
				if (exhausted || attempts === 1)
					throw new TypeError("fetch failed", {
						cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
					});
				return answer();
			});
			const reviewer = new SystemOneReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
			const outerSleep = vi.fn(async () => {});
			const adapter = new SystemOneJevAdapter(reviewer as unknown as SystemOneReviewerLike, undefined, {
				getApiKey: () => "fixture-key",
				sleep: outerSleep,
			});
			const result = adapter.evaluate(input).then(
				() => "success",
				() => "failure",
			);
			await vi.advanceTimersByTimeAsync(1500);
			expect(await result).toBe(exhausted ? "failure" : "success");
			expect(fetcher).toHaveBeenCalledTimes(exhausted ? 3 : 2);
			expect(outerSleep).not.toHaveBeenCalled();
		},
	);
	it.each(["unknown", "auth", "malformed", "usage"])(
		"does not retry permanent or invalid failures: %s",
		async (kind) => {
			const fetcher = vi.fn<typeof fetch>(async () => {
				if (kind === "unknown") throw new Error("unexpected local defect");
				if (kind === "auth") return new Response("{}", { status: 401 });
				if (kind === "malformed")
					return Response.json({ model: "jev-1.13.0", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } });
				return answer();
			});
			const reviewer = new SystemOneReviewer({
				getApiKey: async () => "fixture-key",
				fetch: fetcher,
				onUsage:
					kind === "usage"
						? () => {
								throw new Error("disk failed");
							}
						: undefined,
			});
			await expect(reviewer.evaluate(input)).rejects.toThrow();
			expect(fetcher).toHaveBeenCalledTimes(1);
		},
	);
	it("aborts during backoff without another provider attempt", async () => {
		vi.useFakeTimers();
		const abort = new AbortController();
		const fetcher = vi.fn<typeof fetch>(async () => {
			throw new TypeError("fetch failed");
		});
		const reviewer = new SystemOneReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		let settled = false;
		const result = reviewer.evaluate(input, abort.signal).then(
			() => {
				settled = true;
				return "success";
			},
			() => {
				settled = true;
				return "failure";
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(settled).toBe(false);
		abort.abort();
		expect(await result).toBe("failure");
		await vi.advanceTimersByTimeAsync(1500);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
