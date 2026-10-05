import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAntigravityCredits } from "../src/providers/antigravity-credits.ts";
import { mergeGoogleUsage, projectGoogleUsage } from "../src/providers/google-usage.ts";
import {
	antigravityThinkingBudget,
	antigravityThinkingLevel,
	parseAntigravityModels,
	resolveAntigravityProjectOnce,
} from "../src/utils/antigravity.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Antigravity packaged provider", () => {
	it("keeps an independent waiter alive when a shared project lookup caller cancels", async () => {
		let deliver!: (response: Response) => void;
		let requestSignal: AbortSignal | undefined;
		const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
			requestSignal = init?.signal ?? undefined;
			return new Promise<Response>((resolve) => {
				deliver = resolve;
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const caller = new AbortController();
		const first = resolveAntigravityProjectOnce("local-independent-waiters", caller.signal);
		const second = resolveAntigravityProjectOnce("local-independent-waiters");
		const rejected = expect(first).rejects.toThrow("cancel caller");
		caller.abort(new Error("cancel caller"));
		await rejected;
		expect(requestSignal?.aborted).toBe(false);
		deliver(Response.json({ cloudaicompanionProject: "project" }));
		await expect(second).resolves.toBe("project");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("cancels the upstream request after the final waiter leaves and permits a fresh lookup", async () => {
		let requestSignal: AbortSignal | undefined;
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockImplementationOnce((_url, init) => {
				requestSignal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
				});
			})
			.mockResolvedValueOnce(Response.json({ cloudaicompanionProject: "fresh" }));
		vi.stubGlobal("fetch", fetchMock);
		const caller = new AbortController();
		const first = resolveAntigravityProjectOnce("local-final-waiter", caller.signal);
		const rejected = expect(first).rejects.toThrow("cancel final");
		caller.abort(new Error("cancel final"));
		await rejected;
		expect(requestSignal?.aborted).toBe(true);
		await expect(resolveAntigravityProjectOnce("local-final-waiter")).resolves.toBe("fresh");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retains partial Google counts and projects details without double counting", () => {
		const original = mergeGoogleUsage(undefined, {
			promptTokenCount: 100,
			cachedContentTokenCount: 20,
			candidatesTokenCount: 5,
			thoughtsTokenCount: 2,
			toolUsePromptTokenCount: 3,
		});
		const merged = mergeGoogleUsage(original, {
			toolCallStats: [{ functionName: "lookup", toolCallCount: 2, serverExecuted: true }],
		});
		const usage = projectGoogleUsage(merged, {
			consumedCredits: parseAntigravityCredits([
				{ creditType: "AI", creditAmount: "7", minimumCreditAmountForUsage: 2 },
			]),
		});
		expect([usage.input, usage.output, usage.cacheRead, usage.totalTokens]).toEqual([83, 7, 20, 110]);
		expect(usage.details?.toolCalls?.[0]?.count).toBe(2);
		expect(usage.details?.consumedCredits?.[0]?.amount).toBe(7);
		expect(original.toolCallStats).toBeUndefined();
		expect(() => mergeGoogleUsage(original, { promptTokenCount: 10 })).toThrow("cached token");
	});

	it("keeps adaptive presets and GPT-OSS Medium budget mutually exclusive", () => {
		const models = parseAntigravityModels({
			"claude-local-high": {
				maxTokens: 100000,
				maxOutputTokens: 1000,
				supportsThinking: true,
				supportsAdaptiveThinking: true,
				thinkingLevel: 3,
			},
			"gpt-oss-local-medium": {
				maxTokens: 100000,
				maxOutputTokens: 1000,
				supportsThinking: true,
				thinkingBudget: 8192,
			},
		});
		expect(models).toHaveLength(2);
		expect(antigravityThinkingLevel(models[0]!)).toBe(3);
		expect(antigravityThinkingBudget(models[0]!)).toBeUndefined();
		expect(models[1]?.defaultThinkingLevel).toBe("medium");
		expect(antigravityThinkingBudget(models[1]!)).toBe(8192);
		expect(antigravityThinkingLevel(models[1]!)).toBeUndefined();
	});
});
