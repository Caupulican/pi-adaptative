import { describe, expect, it } from "vitest";
import { runBoundedCompletion } from "../src/core/autonomy/bounded-completion.ts";

describe("runBoundedCompletion", () => {
	it("returns the completion when the executor settles in time", async () => {
		const outcome = await runBoundedCompletion({
			maxWallClockMs: 0,
			execute: async () => ({ text: "ok", costUsd: 0.01, stopReason: "stop" }),
		});
		expect(outcome.completion?.text).toBe("ok");
		expect(outcome.failure).toBeUndefined();
	});

	it("maps a wall-clock breach to timeout", async () => {
		const outcome = await runBoundedCompletion({
			maxWallClockMs: 10,
			execute: (signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		});
		expect(outcome.completion).toBeUndefined();
		expect(outcome.failure).toEqual({ status: "timeout", reasonCode: "wall_clock_exceeded" });
	});

	it("maps an external abort to canceled, winning over timeout", async () => {
		const controller = new AbortController();
		const pending = runBoundedCompletion({
			maxWallClockMs: 0,
			signal: controller.signal,
			execute: (signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		});
		controller.abort();
		const outcome = await pending;
		expect(outcome.failure).toEqual({ status: "canceled", reasonCode: "external_abort" });
	});

	it("maps an executor throw without any abort to failed/completion_error", async () => {
		const outcome = await runBoundedCompletion({
			maxWallClockMs: 0,
			execute: async () => {
				throw new Error("boom");
			},
		});
		expect(outcome.failure).toEqual({ status: "failed", reasonCode: "completion_error" });
	});

	it("treats an abort that raced a settled completion as the abort outcome", async () => {
		const controller = new AbortController();
		const outcome = await runBoundedCompletion({
			maxWallClockMs: 0,
			signal: controller.signal,
			execute: async () => {
				controller.abort();
				return { text: "settled anyway", costUsd: 0.02, stopReason: "stop" };
			},
		});
		expect(outcome.failure?.status).toBe("canceled");
		expect(outcome.completion?.costUsd).toBe(0.02);
	});
});
