/**
 * HerdrBackend.subscribeEvents: a malformed event payload escapes the adapter callback.
 *
 * The adapter installed at herdr-backend.ts:519-546 is not wrapped. `record(event.data)` (:525)
 * throws `CollaborationBackendError("invalid_response")` for any non-object `data`, and the channel
 * validates an event envelope only as "an object with a truthy `event`" (herdr-channel.ts:122,139),
 * leaving `data` entirely unvalidated. The throw therefore escapes into
 * `for (const listener of listeners) listener(value)` (herdr-channel.ts:140), which runs inside a
 * socket `data` handler with no try/catch, and becomes an uncaught exception in the host process.
 *
 * `record(value)` on the envelope itself (:520) is also unguarded, but the channel already rejects a
 * non-object line before dispatch (herdr-channel.ts:122), so that branch is not reachable over the
 * real transport and is deliberately not asserted here.
 *
 * What must happen instead is already in this adapter's vocabulary: the `event.error` branch (:521)
 * reports `{ type: "connection_closed" }`, which `waitForAgentEventCondition` treats as a terminal
 * event and rejects on. A payload this adapter cannot parse leaves the subscription untrustworthy,
 * so it must inform the owning wait through that same terminal event and release the subscription -
 * never throw back into the socket callback.
 *
 * Dispatch here mirrors herdr-channel.ts:140 but records an escaping throw as a value, so nothing
 * reaches the test runner uncaught.
 */
import { describe, expect, it, vi } from "vitest";
import type { CollaborationBackend, CollaborationEvent } from "../src/core/collaboration/backend.ts";
import { HerdrBackend } from "../src/core/collaboration/herdr-backend.ts";
import type { HerdrEventChannel } from "../src/core/collaboration/herdr-channel.ts";
import { waitForAgentEventCondition } from "../src/core/collaboration/turn-settlement.ts";

const PANE_ID = "w1:p1";
const OTHER_PANE_ID = "w1:p9";
const TERMINAL_ID = "t-owned";

async function flushTasks(rounds = 25): Promise<void> {
	for (let round = 0; round < rounds; round++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

interface ChannelHarness {
	backend: HerdrBackend;
	/** Dispatches exactly like herdr-channel.ts:140, capturing an escaping throw instead of rethrowing. */
	emit(event: unknown): void;
	escapedError(): unknown;
	listenerCount(): number;
	closes(): number;
}

function channelHarness(): ChannelHarness {
	const listeners = new Set<(event: unknown) => void>();
	let escapedError: unknown;
	let closes = 0;
	const connection: HerdrEventChannel = {
		request: vi.fn(async () => ({ type: "ok" })),
		onEvent: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		close: vi.fn(() => {
			closes += 1;
		}),
	};
	return {
		backend: new HerdrBackend({
			executable: "herdr",
			session: "pi-owned",
			socketPath: "/owned/socket",
			connect: async () => connection,
			// `subscribeEvents` only uses the injected channel. This guard makes it impossible for a
			// fixture mistake to fall through to the real `herdr` CLI boundary instead.
			run: () => {
				throw new Error("This fixture must never run a native herdr command.");
			},
		}),
		emit: (event) => {
			for (const listener of [...listeners]) {
				try {
					listener(event);
				} catch (error) {
					escapedError = error;
				}
			}
		},
		escapedError: () => escapedError,
		listenerCount: () => listeners.size,
		closes: () => closes,
	};
}

/** A protocol-valid envelope whose `data` the channel never validates. */
const MALFORMED_EVENT = { event: "pane.agent_status_changed", data: "not-a-record" };

describe("herdr subscribeEvents malformed payload lifetime", () => {
	it("informs the owning listener and releases the subscription instead of throwing at the socket", async () => {
		const harness = channelHarness();
		const seen: CollaborationEvent[] = [];

		const unsubscribe = await harness.backend.subscribeEvents(PANE_ID, (event) => {
			seen.push(event);
		});
		harness.emit(MALFORMED_EVENT);
		await flushTasks();

		try {
			// The socket callback must never be the place this surfaces.
			expect(harness.escapedError()).toBeUndefined();
			// The owning wait must be told, in the vocabulary it already handles.
			expect(seen).toEqual([{ type: "connection_closed" }]);
			// An adapter that cannot parse its own feed must not keep claiming to observe the pane.
			expect(harness.listenerCount()).toBe(0);
			expect(harness.closes()).toBe(1);
		} finally {
			unsubscribe();
		}
	});

	it("rejects the owning wait rather than leaving it watching a broken subscription", async () => {
		const harness = channelHarness();
		const agent = {
			paneId: PANE_ID,
			terminalId: TERMINAL_ID,
			workspaceId: "w1",
			tabId: "w1:t1",
			name: "builder",
			kind: "pi",
			status: "working" as const,
			interactiveReady: true,
			launchPending: false,
			stateChangeSequence: 1,
			revision: 1,
		};
		// Only getAgent is added; subscribeEvents is the real adapter under test.
		const backend = {
			id: "stub",
			session: "stub",
			getAgent: vi.fn(async () => agent),
			subscribeEvents: harness.backend.subscribeEvents.bind(harness.backend),
		} as unknown as CollaborationBackend;

		// Owned cancellation: the wait installs a 30s deadline timer, so if an assertion below throws
		// the finally must still release it rather than leave it armed on the runner.
		const controller = new AbortController();
		let state = "pending";
		let reason: unknown;
		const settled = waitForAgentEventCondition({
			backend,
			target: "builder",
			terminalId: TERMINAL_ID,
			paneId: PANE_ID,
			timeoutMs: 30_000,
			signal: controller.signal,
			check: () => ({ settled: false }),
		}).then(
			() => {
				state = "resolved";
			},
			(error: unknown) => {
				state = "rejected";
				reason = error;
			},
		);
		await flushTasks();

		harness.emit(MALFORMED_EVENT);
		await flushTasks();

		try {
			expect(harness.escapedError()).toBeUndefined();
			expect(state).toBe("rejected");
			expect(String(reason)).toContain("Collaboration agent terminated unexpectedly (connection_closed).");
		} finally {
			controller.abort(new Error("cleanup"));
			await settled;
		}
	});

	it("negative control: a well-formed event is mapped and the subscription stays live", async () => {
		const harness = channelHarness();
		const seen: CollaborationEvent[] = [];

		const unsubscribe = await harness.backend.subscribeEvents(PANE_ID, (event) => {
			seen.push(event);
		});
		harness.emit({
			event: "pane.agent_status_changed",
			data: { pane_id: PANE_ID, workspace_id: "w1", agent_status: "idle", agent: "pi" },
		});
		await flushTasks();

		expect(harness.escapedError()).toBeUndefined();
		expect(seen).toEqual([{ type: "agent_status_changed", paneId: PANE_ID, status: "idle" }]);
		expect(harness.listenerCount()).toBe(1);
		expect(harness.closes()).toBe(0);
		unsubscribe();
		expect(harness.listenerCount()).toBe(0);
		expect(harness.closes()).toBe(1);
	});

	it("negative control: another pane's event is ignored without disturbing the subscription", async () => {
		const harness = channelHarness();
		const seen: CollaborationEvent[] = [];

		const unsubscribe = await harness.backend.subscribeEvents(PANE_ID, (event) => {
			seen.push(event);
		});
		harness.emit({
			event: "pane.agent_status_changed",
			data: { pane_id: OTHER_PANE_ID, workspace_id: "w1", agent_status: "idle", agent: "pi" },
		});
		harness.emit({ event: "pane_closed", data: { type: "pane_closed", pane_id: OTHER_PANE_ID } });
		await flushTasks();

		try {
			expect(harness.escapedError()).toBeUndefined();
			expect(seen).toEqual([]);
			expect(harness.listenerCount()).toBe(1);
			expect(harness.closes()).toBe(0);
		} finally {
			unsubscribe();
		}
	});
});
