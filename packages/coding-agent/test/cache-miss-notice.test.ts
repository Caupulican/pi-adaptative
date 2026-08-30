import type { Usage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_CACHE_TTL_MS, detectCacheMissNotice } from "../src/core/cache-miss-notice.ts";

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

describe("detectCacheMissNotice (P1m)", () => {
	it("returns undefined on the first turn (nothing to compare against)", () => {
		const current = { usage: usage({ cacheRead: 0 }), modelKey: "anthropic/claude", timestamp: 1000 };
		expect(detectCacheMissNotice(current, undefined)).toBeUndefined();
	});

	it("returns undefined when the cache actually hit (no evidence of a miss)", () => {
		const previous = { usage: usage({ input: 100, cacheRead: 900 }), modelKey: "anthropic/claude", timestamp: 1000 };
		// Previous prompt was 1000 tokens; current cacheRead of 950 shows it mostly carried over.
		const current = { usage: usage({ cacheRead: 950 }), modelKey: "anthropic/claude", timestamp: 1000 + 1000 };
		expect(detectCacheMissNotice(current, previous)).toBeUndefined();
	});

	it("returns undefined when the previous turn had no prompt tokens to have cached", () => {
		const previous = { usage: usage(), modelKey: "anthropic/claude", timestamp: 1000 };
		const current = { usage: usage({ cacheRead: 0 }), modelKey: "anthropic/claude", timestamp: 2000 };
		expect(detectCacheMissNotice(current, previous)).toBeUndefined();
	});

	it("attributes a miss to a model switch when the model changed", () => {
		const previous = { usage: usage({ input: 100, cacheRead: 900 }), modelKey: "anthropic/claude", timestamp: 1000 };
		const current = { usage: usage({ cacheRead: 0 }), modelKey: "openai/gpt-5", timestamp: 1_500 };
		const notice = detectCacheMissNotice(current, previous);
		expect(notice?.reason).toBe("model_switch");
		expect(notice?.message).toContain("anthropic/claude");
		expect(notice?.message).toContain("openai/gpt-5");
	});

	it("attributes a miss to an idle gap when idle time exceeds the TTL and the model is unchanged", () => {
		const previous = { usage: usage({ input: 100, cacheRead: 900 }), modelKey: "anthropic/claude", timestamp: 1000 };
		const current = {
			usage: usage({ cacheRead: 0 }),
			modelKey: "anthropic/claude",
			timestamp: 1000 + DEFAULT_CACHE_TTL_MS + 60_000,
		};
		const notice = detectCacheMissNotice(current, previous);
		expect(notice?.reason).toBe("idle_gap");
		expect(notice?.message).toMatch(/idle gap/);
	});

	it("does not report an unexplained miss (same model, within TTL, but still low cacheRead)", () => {
		const previous = { usage: usage({ input: 100, cacheRead: 900 }), modelKey: "anthropic/claude", timestamp: 1000 };
		const current = { usage: usage({ cacheRead: 0 }), modelKey: "anthropic/claude", timestamp: 1000 + 1000 };
		expect(detectCacheMissNotice(current, previous)).toBeUndefined();
	});

	it("respects a custom idle TTL", () => {
		const previous = { usage: usage({ input: 100, cacheRead: 900 }), modelKey: "anthropic/claude", timestamp: 1000 };
		const current = { usage: usage({ cacheRead: 0 }), modelKey: "anthropic/claude", timestamp: 1000 + 10_000 };
		expect(detectCacheMissNotice(current, previous, 5_000)?.reason).toBe("idle_gap");
		expect(detectCacheMissNotice(current, previous, 60_000)).toBeUndefined();
	});
});
