import { afterEach, describe, expect, it, vi } from "vitest";
import { pollOAuthDeviceCodeFlow } from "../src/utils/oauth/device-code.ts";

describe("OAuth device-code polling", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("polls immediately and returns the completed value", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));

		const pollTimes: number[] = [];
		const poll = vi.fn(async () => {
			pollTimes.push(Date.now());
			return pollTimes.length === 1
				? { status: "pending" as const }
				: { status: "complete" as const, value: "token" };
		});

		const resultPromise = pollOAuthDeviceCodeFlow({
			intervalSeconds: 2,
			expiresInSeconds: 30,
			poll,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(pollTimes).toEqual([new Date("2026-03-09T00:00:00Z").getTime()]);

		await vi.advanceTimersByTimeAsync(1999);
		expect(pollTimes).toEqual([new Date("2026-03-09T00:00:00Z").getTime()]);

		await vi.advanceTimersByTimeAsync(1);
		await expect(resultPromise).resolves.toBe("token");
		expect(pollTimes).toEqual([
			new Date("2026-03-09T00:00:00Z").getTime(),
			new Date("2026-03-09T00:00:02Z").getTime(),
		]);
	});

	it("cancels an in-flight wait", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();

		const resultPromise = pollOAuthDeviceCodeFlow({
			intervalSeconds: 5,
			expiresInSeconds: 30,
			poll: async () => ({ status: "pending" }),
			signal: controller.signal,
		});

		controller.abort();
		await expect(resultPromise).rejects.toThrow("Login cancelled");
	});

	// Regression: waitBeforeFirstPoll is opt-in. The 4 existing callers (xai, kimi-coding,
	// openai-codex, github-copilot) that construct OAuthDeviceCodePollOptions without setting it
	// must keep polling immediately at t=0, byte-identical to before this option existed.
	it("polls immediately when waitBeforeFirstPoll is left unset", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));

		const pollTimes: number[] = [];
		const poll = vi.fn(async () => {
			pollTimes.push(Date.now());
			return { status: "complete" as const, value: "token" };
		});

		const resultPromise = pollOAuthDeviceCodeFlow({
			intervalSeconds: 2,
			expiresInSeconds: 30,
			poll,
		});

		await vi.advanceTimersByTimeAsync(0);
		await expect(resultPromise).resolves.toBe("token");
		expect(pollTimes).toEqual([new Date("2026-03-09T00:00:00Z").getTime()]);
	});

	it("waits one interval before the first poll when waitBeforeFirstPoll is set", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));

		const pollTimes: number[] = [];
		const poll = vi.fn(async () => {
			pollTimes.push(Date.now());
			return { status: "complete" as const, value: "token" };
		});

		const resultPromise = pollOAuthDeviceCodeFlow({
			intervalSeconds: 2,
			expiresInSeconds: 30,
			waitBeforeFirstPoll: true,
			poll,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(pollTimes).toEqual([]);

		await vi.advanceTimersByTimeAsync(1999);
		expect(pollTimes).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		await expect(resultPromise).resolves.toBe("token");
		expect(pollTimes).toEqual([new Date("2026-03-09T00:00:02Z").getTime()]);
	});

	it("cancels while waiting before the first poll", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();

		const resultPromise = pollOAuthDeviceCodeFlow({
			intervalSeconds: 5,
			expiresInSeconds: 30,
			waitBeforeFirstPoll: true,
			poll: async () => ({ status: "pending" }),
			signal: controller.signal,
		});

		controller.abort();
		await expect(resultPromise).rejects.toThrow("Login cancelled");
	});

	it("uses the server-provided slow_down interval instead of the +5s RFC bump", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));

		const pollTimes: number[] = [];
		const poll = vi.fn(async () => {
			pollTimes.push(Date.now());
			// A server interval of 3s is well below the 2s+5s=7s the RFC bump would produce,
			// so only honoring the server value (not adding it) explains a 3s gap.
			return pollTimes.length === 1
				? { status: "slow_down" as const, intervalSeconds: 3 }
				: { status: "complete" as const, value: "token" };
		});

		const resultPromise = pollOAuthDeviceCodeFlow({
			intervalSeconds: 2,
			expiresInSeconds: 30,
			poll,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(pollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(2999);
		expect(pollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		await expect(resultPromise).resolves.toBe("token");
		expect(pollTimes).toEqual([
			new Date("2026-03-09T00:00:00Z").getTime(),
			new Date("2026-03-09T00:00:03Z").getTime(),
		]);
	});

	it("falls back to the +5s RFC bump when slow_down carries no interval", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-03-09T00:00:00Z"));

		const pollTimes: number[] = [];
		const poll = vi.fn(async () => {
			pollTimes.push(Date.now());
			return pollTimes.length === 1
				? { status: "slow_down" as const }
				: { status: "complete" as const, value: "token" };
		});

		const resultPromise = pollOAuthDeviceCodeFlow({
			intervalSeconds: 2,
			expiresInSeconds: 30,
			poll,
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(pollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(6999);
		expect(pollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		await expect(resultPromise).resolves.toBe("token");
		expect(pollTimes).toEqual([
			new Date("2026-03-09T00:00:00Z").getTime(),
			new Date("2026-03-09T00:00:07Z").getTime(),
		]);
	});
});
