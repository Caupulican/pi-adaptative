import type { StopReason } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ReflectionTurnLifecycle } from "../src/core/reflection-turn-lifecycle.ts";

describe("reflection turn admission", () => {
	it.each([
		{ stopReason: "stop", cancelled: false, starts: true },
		{ stopReason: "error", cancelled: false, starts: false },
		{ stopReason: "aborted", cancelled: false, starts: false },
		{ stopReason: "stop", cancelled: true, starts: false },
	] satisfies Array<{ stopReason: StopReason; cancelled: boolean; starts: boolean }>)(
		"requires a completed, uncancelled foreground submission: %j",
		async ({ stopReason, cancelled, starts }) => {
			const prompt = vi.fn(async () => {});
			const beginDueReflectionTurn = vi.fn(() => "Reflect on completed work");
			const endReflectionTurn = vi.fn();
			const lifecycle = new ReflectionTurnLifecycle({
				prompt,
				beginDueReflectionTurn,
				endReflectionTurn,
				abortAgent: vi.fn(),
				getLastAssistantStopReason: () => stopReason,
				isDisposed: () => false,
				warn: vi.fn(),
			});
			const submission = new AbortController();
			if (cancelled) submission.abort();
			lifecycle.startDueTurn({ signal: submission.signal });
			await lifecycle.settle();
			expect(beginDueReflectionTurn).toHaveBeenCalledTimes(starts ? 1 : 0);
			expect(prompt).toHaveBeenCalledTimes(starts ? 1 : 0);
			expect(endReflectionTurn).toHaveBeenCalledTimes(starts ? 1 : 0);
			expect(lifecycle.inFlight).toBe(false);
		},
	);
});
