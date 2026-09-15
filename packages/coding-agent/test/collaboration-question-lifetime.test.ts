/**
 * HerdrBackend.answerQuestion: terminal and malformed events versus the one input write.
 *
 * Two gaps, both in the event listener installed at herdr-backend.ts:360-383.
 *
 * 1. `if (!submitted) return;` (:369) sits ABOVE the pane_exited / pane_closed / pane_agent_detected
 *    branch, so before the input is written those three are discarded outright. While the
 *    pre-submission re-read (`agent.get`, :395) is in flight the answer is not yet submitted, so a
 *    pane that closes in that window is ignored, the stale blocked snapshot still matches `before`,
 *    and `pane.send_input` (:406) writes the answer into a pane that is gone. A connection error is
 *    seen (:362) but only settles the wait promise - the main flow keeps going and still writes.
 *
 * 2. The listener body is not wrapped. `record(event.data)` (:370) throws
 *    `CollaborationBackendError("invalid_response")` for any non-object `data`, and the channel
 *    validates an event envelope only as "an object with a truthy `event`" (herdr-channel.ts:139),
 *    leaving `data` entirely unvalidated. The throw therefore escapes into the socket `data` handler
 *    that dispatches listeners (herdr-channel.ts:140, no try/catch) and becomes an uncaught
 *    exception in the host process. `launchHerdrCommand` wraps its own listener (
 *    herdr-custom-launch.ts:92-117); this one does not.
 *
 * The existing coverage (collaboration-question-answer.test.ts) has exactly two cases: an ordered
 * working -> done settlement, and a changed snapshot refused before input. Neither delivers an event
 * while a request is outstanding, and neither delivers a malformed one.
 *
 * Settlement is observed as a recorded state after a bounded flush, never via the suite timeout: the
 * failure modes here are hangs, and a hang must fail as "pending" with its side effects listed.
 * Listener throws are captured by this file's own dispatcher, so nothing reaches the runner uncaught.
 */
import { describe, expect, it, vi } from "vitest";
import { CollaborationBackendError } from "../src/core/collaboration/backend.ts";
import { HerdrBackend } from "../src/core/collaboration/herdr-backend.ts";
import type { HerdrEventChannel } from "../src/core/collaboration/herdr-channel.ts";

const BLOCKED = {
	pane_id: "w1:p2",
	terminal_id: "t-owned",
	workspace_id: "w1",
	tab_id: "w1:t1",
	agent: "codex",
	name: "reviewer",
	agent_status: "blocked",
	interactive_ready: false,
	launch_pending: false,
	state_change_seq: 3,
	revision: 4,
};

interface Deferred {
	promise: Promise<void>;
	release(): void;
}

function deferred(): Deferred {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = () => resolve();
	});
	return { promise, release };
}

type SettlementState = "pending" | "resolved" | "rejected";

interface Observed {
	state(): SettlementState;
	reason(): unknown;
	settled: Promise<void>;
}

function observe<T>(promise: Promise<T>): Observed {
	let state: SettlementState = "pending";
	let reason: unknown;
	const settled = promise.then(
		() => {
			state = "resolved";
		},
		(error: unknown) => {
			state = "rejected";
			reason = error;
		},
	);
	return { state: () => state, reason: () => reason, settled };
}

async function flushTasks(rounds = 25): Promise<void> {
	for (let round = 0; round < rounds; round++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

interface QuestionHarness {
	backend: HerdrBackend;
	methods: string[];
	/** Dispatches like herdr-channel.ts:140 does, but records a throwing listener instead of
	 * letting it escape into the socket handler and abort the runner. */
	emit(event: unknown): void;
	listenerError(): unknown;
	hold(method: string, occurrence: number): Deferred;
	/** Deliver the ordered status changes that legitimately settle an answered question. */
	settleAnswer(): void;
}

function questionHarness(agentReplies: () => Record<string, unknown>): QuestionHarness {
	const methods: string[] = [];
	const counts = new Map<string, number>();
	const gates = new Map<string, Deferred>();
	let listener: ((event: unknown) => void) | undefined;
	let listenerError: unknown;

	const request = vi.fn(async (method: string, _params: Record<string, unknown>): Promise<unknown> => {
		const occurrence = (counts.get(method) ?? 0) + 1;
		counts.set(method, occurrence);
		methods.push(method);
		const gate = gates.get(`${method}#${occurrence}`);
		if (gate) await gate.promise;
		if (method === "agent.get") return { type: "agent_info", agent: agentReplies() };
		return { type: "ok" };
	});

	const connection: HerdrEventChannel = {
		request,
		onEvent: (next) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		close: vi.fn(),
	};

	const emit = (event: unknown): void => {
		if (!listener) return;
		try {
			listener(event);
		} catch (error) {
			listenerError = error;
		}
	};

	return {
		backend: new HerdrBackend({
			executable: "herdr",
			session: "pi-owned",
			socketPath: "/owned/socket",
			connect: async () => connection,
		}),
		methods,
		emit,
		listenerError: () => listenerError,
		hold(method, occurrence) {
			const gate = deferred();
			gates.set(`${method}#${occurrence}`, gate);
			return gate;
		},
		settleAnswer() {
			emit({ event: "pane.agent_status_changed", data: { pane_id: BLOCKED.pane_id, agent_status: "working" } });
			emit({ event: "pane.agent_status_changed", data: { pane_id: BLOCKED.pane_id, agent_status: "done" } });
		},
	};
}

const TERMINAL_EVENTS: ReadonlyArray<{ label: string; event: unknown }> = [
	{ label: "pane_closed", event: { event: "pane_closed", data: { pane_id: BLOCKED.pane_id } } },
	{ label: "connection error", event: { error: { code: "connection_closed" } } },
];

describe("collaboration question answer lifetime", () => {
	it.each(TERMINAL_EVENTS)(
		"does not write the answer after a $label arrives during the pre-submission re-read",
		async ({ event }) => {
			let answered = false;
			const harness = questionHarness(() =>
				answered ? { ...BLOCKED, agent_status: "done", state_change_seq: 5 } : BLOCKED,
			);
			const gate = harness.hold("agent.get", 2);

			const observed = observe(
				harness.backend.answerQuestion({
					target: "reviewer",
					terminalId: BLOCKED.terminal_id,
					text: "Use the specified path",
					timeoutMs: 1000,
				}),
			);
			await flushTasks();
			expect(harness.methods).toContain("events.subscribe");

			harness.emit(event);
			await flushTasks();
			// The re-read completes with a snapshot that was already stale when it was issued.
			gate.release();
			await flushTasks();

			try {
				expect(harness.methods).not.toContain("pane.send_input");
				expect(observed.state()).toBe("rejected");
				expect(observed.reason()).toBeInstanceOf(CollaborationBackendError);
			} finally {
				answered = true;
				harness.settleAnswer();
				await flushTasks();
				await Promise.race([observed.settled, flushTasks()]);
			}
		},
	);

	it("rejects the answer instead of throwing out of the listener on a malformed event payload", async () => {
		let answered = false;
		const harness = questionHarness(() =>
			answered ? { ...BLOCKED, agent_status: "done", state_change_seq: 5 } : BLOCKED,
		);

		const observed = observe(
			harness.backend.answerQuestion({
				target: "reviewer",
				terminalId: BLOCKED.terminal_id,
				text: "Use the specified path",
				timeoutMs: 1000,
			}),
		);
		await flushTasks();
		expect(harness.methods).toContain("pane.send_input");
		answered = true;

		// A protocol-valid envelope: the channel checks only that `event` is truthy and never
		// validates `data`, so a non-object payload is dispatched to the listener verbatim.
		harness.emit({ event: "pane.agent_status_changed", data: "not-a-record" });
		await flushTasks();

		try {
			expect(harness.listenerError()).toBeUndefined();
			expect(observed.state()).toBe("rejected");
			expect(observed.reason()).toBeInstanceOf(CollaborationBackendError);
		} finally {
			harness.settleAnswer();
			await flushTasks();
			await Promise.race([observed.settled, flushTasks()]);
		}
	});

	it("negative control: a healthy answer writes the input exactly once and returns the settled agent", async () => {
		let answered = false;
		const harness = questionHarness(() =>
			answered ? { ...BLOCKED, agent_status: "done", state_change_seq: 5 } : BLOCKED,
		);

		const answering = harness.backend.answerQuestion({
			target: "reviewer",
			terminalId: BLOCKED.terminal_id,
			text: "Use the specified path",
			timeoutMs: 1000,
		});
		await flushTasks();
		answered = true;
		// A foreign pane must not settle this answer.
		harness.emit({ event: "pane.agent_status_changed", data: { pane_id: "foreign", agent_status: "done" } });
		harness.settleAnswer();

		const result = await answering;

		expect(result.status).toBe("done");
		expect(harness.methods.filter((method) => method === "pane.send_input")).toHaveLength(1);
		expect(harness.methods).toEqual(["agent.get", "events.subscribe", "agent.get", "pane.send_input", "agent.get"]);
		expect(harness.listenerError()).toBeUndefined();
	});
});
