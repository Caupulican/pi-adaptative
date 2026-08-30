import type { AssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CACHE_TTL_MS } from "../src/core/cache-miss-notice.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4",
		usage: {
			input: 100,
			output: 10,
			cacheRead: 900,
			cacheWrite: 0,
			totalTokens: 1010,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1_000,
		...overrides,
	};
}

function makeCtx(messages: AssistantMessage[], showCacheMissNotices: boolean) {
	const ctx = Object.create((InteractiveMode as any).prototype);
	// `session` is a getter-only accessor on the prototype (backed by runtimeHost), so it must be
	// shadowed with an own property rather than assigned.
	Object.defineProperty(ctx, "session", {
		value: {
			messages,
			settingsManager: { getShowCacheMissNotices: () => showCacheMissNotices },
		},
	});
	ctx.showWarning = vi.fn();
	return ctx;
}

describe("InteractiveMode.reportCacheMissNoticeIfEvidenced (P1m wiring)", () => {
	it("does nothing on the very first turn but records the baseline", () => {
		const ctx = makeCtx([assistantMessage({ timestamp: 1_000 })], true);
		(InteractiveMode as any).prototype.reportCacheMissNoticeIfEvidenced.call(ctx);

		expect(ctx.showWarning).not.toHaveBeenCalled();
		expect(ctx.lastCacheObservation).toEqual({
			usage: expect.objectContaining({ cacheRead: 900 }),
			modelKey: "anthropic/claude-sonnet-4",
			timestamp: 1_000,
		});
	});

	it("warns on a second turn with an evidenced, model-switch-explained miss", () => {
		const ctx = makeCtx([assistantMessage({ timestamp: 1_000 })], true);
		(InteractiveMode as any).prototype.reportCacheMissNoticeIfEvidenced.call(ctx);

		ctx.session.messages.push(
			assistantMessage({
				provider: "openai",
				model: "gpt-5",
				usage: { ...assistantMessage().usage, cacheRead: 0 },
				timestamp: 1_500,
			}),
		);
		(InteractiveMode as any).prototype.reportCacheMissNoticeIfEvidenced.call(ctx);

		expect(ctx.showWarning).toHaveBeenCalledTimes(1);
		expect(ctx.showWarning).toHaveBeenCalledWith(expect.stringContaining("model changed"));
	});

	it("stays silent when the setting is off, even with an evidenced miss", () => {
		const ctx = makeCtx([assistantMessage({ timestamp: 1_000 })], false);
		(InteractiveMode as any).prototype.reportCacheMissNoticeIfEvidenced.call(ctx);
		ctx.session.messages.push(
			assistantMessage({
				provider: "openai",
				model: "gpt-5",
				usage: { ...assistantMessage().usage, cacheRead: 0 },
				timestamp: 1_500,
			}),
		);
		(InteractiveMode as any).prototype.reportCacheMissNoticeIfEvidenced.call(ctx);

		expect(ctx.showWarning).not.toHaveBeenCalled();
		// The baseline is still tracked even while notices are muted, so re-enabling mid-session
		// compares against real history instead of a stale/empty baseline.
		expect(ctx.lastCacheObservation?.modelKey).toBe("openai/gpt-5");
	});

	it("does not fire for an aborted or errored turn, and keeps the prior baseline", () => {
		const ctx = makeCtx([assistantMessage({ timestamp: 1_000 })], true);
		(InteractiveMode as any).prototype.reportCacheMissNoticeIfEvidenced.call(ctx);
		const baselineAfterFirstTurn = ctx.lastCacheObservation;

		ctx.session.messages.push(assistantMessage({ stopReason: "aborted", timestamp: 1_500 }));
		(InteractiveMode as any).prototype.reportCacheMissNoticeIfEvidenced.call(ctx);

		expect(ctx.showWarning).not.toHaveBeenCalled();
		expect(ctx.lastCacheObservation).toBe(baselineAfterFirstTurn);
	});

	it("stays silent for a genuine cache hit on the second turn", () => {
		const ctx = makeCtx([assistantMessage({ timestamp: 1_000 })], true);
		(InteractiveMode as any).prototype.reportCacheMissNoticeIfEvidenced.call(ctx);

		ctx.session.messages.push(
			assistantMessage({ usage: { ...assistantMessage().usage, cacheRead: 950 }, timestamp: 1_500 }),
		);
		(InteractiveMode as any).prototype.reportCacheMissNoticeIfEvidenced.call(ctx);

		expect(ctx.showWarning).not.toHaveBeenCalled();
	});

	it("warns for an idle-gap-explained miss past the default TTL", () => {
		const ctx = makeCtx([assistantMessage({ timestamp: 1_000 })], true);
		(InteractiveMode as any).prototype.reportCacheMissNoticeIfEvidenced.call(ctx);

		ctx.session.messages.push(
			assistantMessage({
				usage: { ...assistantMessage().usage, cacheRead: 0 },
				timestamp: 1_000 + DEFAULT_CACHE_TTL_MS + 60_000,
			}),
		);
		(InteractiveMode as any).prototype.reportCacheMissNoticeIfEvidenced.call(ctx);

		expect(ctx.showWarning).toHaveBeenCalledWith(expect.stringContaining("idle gap"));
	});
});
