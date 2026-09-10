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
				hasOpenWork: () => false,
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

describe("reflection turn admission during open work", () => {
	it("keeps the cue waiting while a goal or step is open and buys the turn once the work closes", async () => {
		let open = true;
		const prompt = vi.fn(async () => {});
		const beginDueReflectionTurn = vi.fn(() => "Reflect on completed work");
		const lifecycle = new ReflectionTurnLifecycle({
			prompt,
			beginDueReflectionTurn,
			endReflectionTurn: vi.fn(),
			abortAgent: vi.fn(),
			getLastAssistantStopReason: () => "stop",
			hasOpenWork: () => open,
			isDisposed: () => false,
			warn: vi.fn(),
		});
		// A short owner ping answered mid-goal: the turn completed, but the goal did not.
		lifecycle.startDueTurn({});
		await lifecycle.settle();
		expect(beginDueReflectionTurn).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		// The goal closes; the next completed turn's tail buys the one reflection turn.
		open = false;
		lifecycle.startDueTurn({});
		await lifecycle.settle();
		expect(beginDueReflectionTurn).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledTimes(1);
	});
});
