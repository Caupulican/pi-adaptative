import { afterEach, expect, it, vi } from "vitest";
import { CollaborationDeadlines } from "../src/core/collaboration/deadlines.ts";

afterEach(() => vi.useRealTimers());

it("retries cleanup three times without resetting attempts on state events", async () => {
	vi.useFakeTimers();
	const stop = vi.fn(async () => {
		throw new Error("backend unavailable");
	});
	const failed = vi.fn();
	const owner = new CollaborationDeadlines(stop, failed);
	const turns = [{ jobId: "job", agentId: "one", turnId: "turn", deadlineAt: Date.now() }];
	owner.reconcile(turns);
	await vi.advanceTimersByTimeAsync(10000);
	owner.reconcile(turns);
	await vi.advanceTimersByTimeAsync(1000);
	owner.reconcile(turns);
	await vi.advanceTimersByTimeAsync(5000);
	owner.reconcile(turns);
	await vi.advanceTimersByTimeAsync(60000);
	expect(stop).toHaveBeenCalledTimes(3);
	expect(failed).toHaveBeenCalledTimes(1);
	owner.dispose();
});

it("cancels obsolete turn deadlines and leaves live peer deadlines independent", async () => {
	vi.useFakeTimers();
	const stop = vi.fn(async () => {});
	const owner = new CollaborationDeadlines(stop, vi.fn());
	const first = { jobId: "job", agentId: "one", turnId: "old", deadlineAt: Date.now() };
	const peer = { ...first, agentId: "two", turnId: "peer" };
	owner.reconcile([first, peer]);
	owner.reconcile([peer]);
	await vi.advanceTimersByTimeAsync(10000);
	expect(stop).toHaveBeenCalledExactlyOnceWith("job", "two", "peer");
	owner.dispose();
});

it("does not re-arm cleanup after disposal while a command is settling", async () => {
	vi.useFakeTimers();
	let reject: (error: Error) => void = () => {};
	const stop = vi.fn(
		() =>
			new Promise<void>((_resolve, fail) => {
				reject = fail;
			}),
	);
	const failed = vi.fn();
	const owner = new CollaborationDeadlines(stop, failed);
	owner.reconcile([{ jobId: "job", agentId: "one", turnId: "turn", deadlineAt: Date.now() }]);
	await vi.advanceTimersByTimeAsync(10000);
	owner.dispose();
	reject(new Error("late failure"));
	await vi.advanceTimersByTimeAsync(60000);
	expect(stop).toHaveBeenCalledTimes(1);
	expect(failed).not.toHaveBeenCalled();
});

it("does not reset a persisted cleanup attempt budget across reloads", async () => {
	vi.useFakeTimers();
	let attempts = 0;
	const reserve = () => (attempts < 3 ? ++attempts : 0);
	const stop = vi.fn(async () => {
		throw new Error("offline");
	});
	const turns = [{ jobId: "job", agentId: "one", turnId: "turn", deadlineAt: Date.now() }];
	for (let restart = 0; restart < 5; restart++) {
		const owner = new CollaborationDeadlines(stop, vi.fn(), reserve);
		owner.reconcile(turns);
		await vi.advanceTimersByTimeAsync(10000);
		owner.dispose();
	}
	expect(stop).toHaveBeenCalledTimes(3);
});
