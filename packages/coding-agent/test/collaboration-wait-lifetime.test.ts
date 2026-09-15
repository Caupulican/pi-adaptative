/**
 * waitForAgentEventCondition cancellation lifetime.
 *
 * The wait installs its abort listener and its deadline timer only after `await backend.getAgent()`
 * and `await check(current)` have both resolved (turn-settlement.ts:110-164). Everything before that
 * point is unguarded: a backend read or a predicate that never settles leaves the caller with no
 * cancellation path at all, and neither the abort signal nor the declared timeout can reach it.
 *
 * The existing coverage (collaboration-herdr-panel.test.ts, "delayed getAgent cancellation ...")
 * aborts and then immediately resolves the outstanding getAgent, so it only proves the post-release
 * `throwIfAborted` fence. It cannot observe the window this file is about, because the window closes
 * the moment the backend replies.
 *
 * Settlement is therefore observed directly rather than through vitest's own test timeout: each wait
 * is wrapped in an observer that records its state, the loop is flushed a bounded number of times,
 * and the state is asserted. A hung wait fails as "pending", not as a suite timeout. Every test
 * releases its outstanding promise in a `finally` so no rejection is left unhandled.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	CollaborationAgent,
	CollaborationBackend,
	CollaborationEvent,
} from "../src/core/collaboration/backend.ts";
import { waitForAgentEventCondition } from "../src/core/collaboration/turn-settlement.ts";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

type SettlementState = "pending" | "resolved" | "rejected";

interface Observed<T> {
	/** Settled state as observed by an attached handler, never by racing a timer. */
	state(): SettlementState;
	reason(): unknown;
	value(): T | undefined;
	/** Pre-handled, so awaiting it during cleanup can never surface an unhandled rejection. */
	settled: Promise<void>;
}

function observe<T>(promise: Promise<T>): Observed<T> {
	let state: SettlementState = "pending";
	let reason: unknown;
	let value: T | undefined;
	const settled = promise.then(
		(result) => {
			state = "resolved";
			value = result;
		},
		(error: unknown) => {
			state = "rejected";
			reason = error;
		},
	);
	return { state: () => state, reason: () => reason, value: () => value, settled };
}

/** Bounded macrotask drain: enough turns for any settled promise chain, finite for a hung one. */
async function flushTasks(rounds = 25): Promise<void> {
	for (let round = 0; round < rounds; round++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

function agentAt(paneId: string, terminalId: string, overrides: Partial<CollaborationAgent> = {}): CollaborationAgent {
	return {
		paneId,
		terminalId,
		workspaceId: "w1",
		tabId: "w1:t1",
		name: "builder",
		kind: "pi",
		status: "working",
		interactiveReady: true,
		launchPending: false,
		stateChangeSequence: 1,
		revision: 1,
		...overrides,
	};
}

/**
 * waitForAgentEventCondition touches only getAgent and subscribeEvents. One documented cast keeps the
 * stub to the ports actually exercised instead of hand-stubbing seventeen unrelated backend methods.
 */
function stubBackend(parts: Partial<CollaborationBackend>): CollaborationBackend {
	return { id: "stub", session: "stub", ...parts } as unknown as CollaborationBackend;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("collaboration wait cancellation lifetime", () => {
	it("rejects promptly when the wait is aborted while the initial getAgent is outstanding", async () => {
		const controller = new AbortController();
		const outstanding = deferred<CollaborationAgent>();
		const subscribeEvents = vi.fn(async () => () => {});
		const check = vi.fn(() => ({ settled: false }));
		const backend = stubBackend({ getAgent: vi.fn(() => outstanding.promise), subscribeEvents });

		const observed = observe(
			waitForAgentEventCondition({
				backend,
				target: "builder",
				terminalId: "t1",
				paneId: "p1",
				timeoutMs: 5000,
				signal: controller.signal,
				check,
			}),
		);
		await flushTasks();
		controller.abort(new Error("Wait cancelled while the backend read was outstanding."));
		await flushTasks();

		try {
			expect(observed.state()).toBe("rejected");
			expect(String(observed.reason())).toContain("Wait cancelled while the backend read was outstanding.");
		} finally {
			// Release the stale read regardless of the assertion outcome so nothing is left unhandled.
			outstanding.resolve(agentAt("p1", "t1"));
			await observed.settled;
		}

		// The released stale read must not revive a cancelled wait.
		expect(subscribeEvents).not.toHaveBeenCalled();
		expect(check).not.toHaveBeenCalled();
	});

	it("rejects at its declared deadline when the initial getAgent never resolves", async () => {
		vi.useFakeTimers();
		const outstanding = deferred<CollaborationAgent>();
		const subscribeEvents = vi.fn(async () => () => {});
		const check = vi.fn(() => ({ settled: false }));
		const backend = stubBackend({ getAgent: vi.fn(() => outstanding.promise), subscribeEvents });

		const observed = observe(
			waitForAgentEventCondition({
				backend,
				target: "builder",
				terminalId: "t1",
				paneId: "p1",
				timeoutMs: 1000,
				startTime: Date.now(),
				timeoutMessage: "Collaboration wait timed out.",
				check,
			}),
		);
		await vi.advanceTimersByTimeAsync(10_000);

		try {
			expect(observed.state()).toBe("rejected");
			expect(String(observed.reason())).toContain("Collaboration wait timed out.");
		} finally {
			outstanding.resolve(agentAt("p1", "t1"));
			await vi.advanceTimersByTimeAsync(10_000);
			await observed.settled;
		}

		expect(check).not.toHaveBeenCalled();
	});

	it("rejects promptly when the wait is aborted while the initial check is outstanding", async () => {
		const controller = new AbortController();
		const outstanding = deferred<{ settled: boolean }>();
		const subscribeEvents = vi.fn(async () => () => {});
		const check = vi.fn(() => outstanding.promise);
		const backend = stubBackend({ getAgent: vi.fn(async () => agentAt("p1", "t1")), subscribeEvents });

		const observed = observe(
			waitForAgentEventCondition({
				backend,
				target: "builder",
				terminalId: "t1",
				paneId: "p1",
				timeoutMs: 5000,
				signal: controller.signal,
				check,
			}),
		);
		await flushTasks();
		expect(check).toHaveBeenCalledTimes(1);
		controller.abort(new Error("Wait cancelled while the predicate was outstanding."));
		await flushTasks();

		try {
			expect(observed.state()).toBe("rejected");
			expect(String(observed.reason())).toContain("Wait cancelled while the predicate was outstanding.");
		} finally {
			outstanding.resolve({ settled: false });
			await observed.settled;
		}

		expect(subscribeEvents).not.toHaveBeenCalled();
		expect(check).toHaveBeenCalledTimes(1);
	});

	it("re-checks the occupant when a replacement agent is detected without a status change", async () => {
		const controller = new AbortController();
		let emit: (event: CollaborationEvent) => void = () => {};
		let occupant = agentAt("p1", "t1");
		const subscribeEvents = vi.fn(async (_paneId: string, listener: (event: CollaborationEvent) => void) => {
			emit = listener;
			return () => {};
		});
		const backend = stubBackend({ getAgent: vi.fn(async () => occupant), subscribeEvents });

		const observed = observe(
			waitForAgentEventCondition({
				backend,
				target: "builder",
				terminalId: "t1",
				paneId: "p1",
				timeoutMs: 30_000,
				signal: controller.signal,
				check: () => ({ settled: false }),
			}),
		);
		await flushTasks();
		expect(subscribeEvents).toHaveBeenCalledTimes(1);

		// A new occupant takes the pane. Herdr reports this as pane_agent_detected (herdr-backend.ts:531)
		// and no agent_status_changed needs to follow, because the replacement's status never changed.
		occupant = agentAt("p1", "t-replacement");
		emit({ type: "pane_agent_detected", paneId: "p1" });
		await flushTasks();

		try {
			expect(observed.state()).toBe("rejected");
			expect(String(observed.reason())).toContain("Collaboration pane occupant changed during wait.");
		} finally {
			controller.abort(new Error("cleanup"));
			await observed.settled;
		}
	});

	it("negative control: settles from the initial check without installing any event source", async () => {
		const subscribeEvents = vi.fn(async () => () => {});
		const backend = stubBackend({ getAgent: vi.fn(async () => agentAt("p1", "t1")), subscribeEvents });

		const settled = await waitForAgentEventCondition<string>({
			backend,
			target: "builder",
			terminalId: "t1",
			paneId: "p1",
			timeoutMs: 5000,
			check: () => ({ settled: true, value: "ready" }),
		});

		expect(settled).toBe("ready");
		expect(subscribeEvents).not.toHaveBeenCalled();
	});

	it("negative control: coalesces status events during an in-flight check and still settles", async () => {
		const controller = new AbortController();
		let emit: (event: CollaborationEvent) => void = () => {};
		const subscribeEvents = vi.fn(async (_paneId: string, listener: (event: CollaborationEvent) => void) => {
			emit = listener;
			return () => {};
		});
		const backend = stubBackend({ getAgent: vi.fn(async () => agentAt("p1", "t1")), subscribeEvents });

		let ready = false;
		let held: Deferred<void> | undefined;
		const check = vi.fn(async () => {
			if (held) await held.promise;
			return { settled: ready, value: "settled-value" };
		});

		const observed = observe(
			waitForAgentEventCondition<string>({
				backend,
				target: "builder",
				terminalId: "t1",
				paneId: "p1",
				timeoutMs: 30_000,
				signal: controller.signal,
				check,
			}),
		);
		await flushTasks();
		expect(observed.state()).toBe("pending");

		// Hold one check in flight and deliver three events behind it. None may be dropped, and they
		// must not stack into three concurrent checks.
		held = deferred<void>();
		emit({ type: "agent_status_changed", paneId: "p1", status: "working" });
		await flushTasks(3);
		const callsBeforeBurst = check.mock.calls.length;
		emit({ type: "agent_status_changed", paneId: "p1", status: "working" });
		emit({ type: "agent_status_changed", paneId: "p1", status: "working" });
		emit({ type: "agent_status_changed", paneId: "p1", status: "idle" });
		ready = true;
		held.resolve();
		held = undefined;
		await flushTasks();

		try {
			expect(observed.state()).toBe("resolved");
			expect(observed.value()).toBe("settled-value");
			expect(check.mock.calls.length).toBeLessThan(callsBeforeBurst + 3);
		} finally {
			controller.abort(new Error("cleanup"));
			await observed.settled;
		}
	});

	it("negative control: rejects immediately on a termination event", async () => {
		let emit: (event: CollaborationEvent) => void = () => {};
		const subscribeEvents = vi.fn(async (_paneId: string, listener: (event: CollaborationEvent) => void) => {
			emit = listener;
			return () => {};
		});
		const backend = stubBackend({ getAgent: vi.fn(async () => agentAt("p1", "t1")), subscribeEvents });

		const observed = observe(
			waitForAgentEventCondition({
				backend,
				target: "builder",
				terminalId: "t1",
				paneId: "p1",
				timeoutMs: 30_000,
				check: () => ({ settled: false }),
			}),
		);
		await flushTasks();
		emit({ type: "pane_closed", paneId: "p1" });
		await flushTasks();

		expect(observed.state()).toBe("rejected");
		expect(String(observed.reason())).toContain("Collaboration agent terminated unexpectedly (pane_closed).");
		await observed.settled;
	});
});
