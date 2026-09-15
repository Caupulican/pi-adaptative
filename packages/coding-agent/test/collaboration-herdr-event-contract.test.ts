/**
 * Herdr event-name contract, pinned to the daemon's own schema.
 *
 * Authority: /home/caudev/GitHub/external/herdr/src/api/schema/events.rs (read-only reference) plus
 * src/api/subscriptions.rs. The wire has two envelope families and the mixed spelling is deliberate:
 *
 * - `Subscription` (the selector we SEND) uses explicit dotted renames: `pane.closed`, `pane.exited`,
 *   `pane.agent_detected`, `pane.agent_status_changed`.
 * - `EventEnvelope { event: EventKind, data: EventData }` is what an unparameterized selector
 *   RECEIVES. `EventKind` is `rename_all = "snake_case"`, and `ActiveSubscription::Event::poll`
 *   (subscriptions.rs:282-292) serializes that envelope verbatim. So `pane.closed` /`pane.exited` /
 *   `pane.agent_detected` are answered by `pane_closed` / `pane_exited` / `pane_agent_detected`.
 *   `EventData` is `tag = "type", rename_all = "snake_case"`, so `data` carries its own `type` field.
 * - `SubscriptionEventEnvelope { event: SubscriptionEventKind, data }` is what the three
 *   parameterized selectors receive. `SubscriptionEventKind` uses dotted renames, and
 *   `ActiveAgentStatusChangedSubscription::poll` (subscriptions.rs:330-360) returns it, so
 *   `pane.agent_status_changed` is answered by `pane.agent_status_changed` - dotted - with an
 *   untagged `PaneAgentStatusChangedEvent` payload that has no `type` field.
 *
 * This file locks that contract with envelopes built exactly as the daemon serializes them, and
 * proves a detection reaches the `subscribeEvents` callback and drives custom-launch readiness. It
 * also pins the negative: a dotted `pane.agent_detected` is a SELECTOR spelling only, emitted by no
 * source, and must not be honoured as an event name.
 */
import { describe, expect, it, vi } from "vitest";
import type { CollaborationEvent } from "../src/core/collaboration/backend.ts";
import { HerdrBackend } from "../src/core/collaboration/herdr-backend.ts";
import type { HerdrEventChannel } from "../src/core/collaboration/herdr-channel.ts";

const PANE_ID = "w1:p1";
const OTHER_PANE_ID = "w1:p9";
const TERMINAL_ID = "t-owned";
const PI_IDLE_LABEL = "pi:collaboration:12345678-1234-4234-8234-123456789abc";

const PANE = { pane_id: PANE_ID, terminal_id: TERMINAL_ID, workspace_id: "w1", tab_id: "w1:t1" };

/**
 * EventEnvelope: `event` is EventKind (snake_case), `data` is EventData (internally tagged `type`,
 * also snake_case). Produced for every unparameterized `Subscription` selector.
 */
function eventEnvelope(kind: string, data: Record<string, unknown>): Record<string, unknown> {
	return { event: kind, data: { type: kind, ...data } };
}

/**
 * SubscriptionEventEnvelope: `event` is SubscriptionEventKind (dotted), `data` is an untagged
 * PaneAgentStatusChangedEvent. Produced only for the three parameterized selectors.
 */
function statusEnvelope(paneId: string, agentStatus: string): Record<string, unknown> {
	return {
		event: "pane.agent_status_changed",
		data: { pane_id: paneId, workspace_id: "w1", agent_status: agentStatus, agent: "pi" },
	};
}

async function flushTasks(rounds = 25): Promise<void> {
	for (let round = 0; round < rounds; round++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

interface ChannelHarness {
	channel: HerdrEventChannel;
	methods: string[];
	subscriptionSelectors: string[];
	emit(event: unknown): void;
}

function channelHarness(reply: (method: string) => unknown): ChannelHarness {
	const methods: string[] = [];
	const subscriptionSelectors: string[] = [];
	let listener: ((event: unknown) => void) | undefined;
	const request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
		methods.push(method);
		if (method === "events.subscribe") {
			const subscriptions = params.subscriptions;
			if (Array.isArray(subscriptions)) {
				for (const entry of subscriptions) {
					const type = (entry as { type?: unknown }).type;
					if (typeof type === "string") subscriptionSelectors.push(type);
				}
			}
		}
		return reply(method);
	});
	return {
		channel: {
			request,
			onEvent: (next) => {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			close: vi.fn(),
		},
		methods,
		subscriptionSelectors,
		emit: (event) => listener?.(event),
	};
}

function backendFor(harness: ChannelHarness): HerdrBackend {
	return new HerdrBackend({
		executable: "herdr",
		session: "pi-owned",
		socketPath: "/owned/socket",
		connect: async () => harness.channel,
	});
}

describe("herdr event-name contract", () => {
	it("sends dotted selectors and maps the snake_case envelopes the daemon answers with", async () => {
		const harness = channelHarness(() => ({ type: "ok" }));
		const backend = backendFor(harness);
		const seen: CollaborationEvent[] = [];

		const unsubscribe = await backend.subscribeEvents?.(PANE_ID, (event) => {
			seen.push(event);
		});

		// Selectors are the dotted `Subscription` spellings.
		expect(harness.subscriptionSelectors).toEqual([
			"pane.agent_status_changed",
			"pane.exited",
			"pane.closed",
			"pane.agent_detected",
		]);

		harness.emit(eventEnvelope("pane_agent_detected", { pane_id: PANE_ID, agent: "pi" }));
		harness.emit(statusEnvelope(PANE_ID, "idle"));
		harness.emit(eventEnvelope("pane_exited", { pane_id: PANE_ID }));
		harness.emit(eventEnvelope("pane_closed", { pane_id: PANE_ID }));

		expect(seen).toEqual([
			{ type: "pane_agent_detected", paneId: PANE_ID },
			{ type: "agent_status_changed", paneId: PANE_ID, status: "idle" },
			{ type: "pane_exited", paneId: PANE_ID },
			{ type: "pane_closed", paneId: PANE_ID },
		]);
		unsubscribe?.();
	});

	it("ignores another pane's envelopes and any spelling no source emits", async () => {
		const harness = channelHarness(() => ({ type: "ok" }));
		const backend = backendFor(harness);
		const seen: CollaborationEvent[] = [];

		const unsubscribe = await backend.subscribeEvents?.(PANE_ID, (event) => {
			seen.push(event);
		});

		harness.emit(eventEnvelope("pane_agent_detected", { pane_id: OTHER_PANE_ID, agent: "pi" }));
		harness.emit(statusEnvelope(OTHER_PANE_ID, "idle"));
		harness.emit(eventEnvelope("pane_closed", { pane_id: OTHER_PANE_ID }));
		// `pane.agent_detected` is a Subscription selector spelling. EventKind serializes
		// `pane_agent_detected`, and SubscriptionEventKind has no detected variant at all, so no
		// supported source emits this envelope; honouring it would invent protocol.
		harness.emit(eventEnvelope("pane.agent_detected", { pane_id: PANE_ID, agent: "pi" }));
		// Likewise the inverse: the targeted status subscription answers dotted, never snake_case.
		harness.emit({
			event: "pane_agent_status_changed",
			data: { type: "pane_agent_status_changed", pane_id: PANE_ID, agent_status: "idle" },
		});

		expect(seen).toEqual([]);
		unsubscribe?.();
	});

	it("drives custom-launch readiness from a real pane_agent_detected envelope", async () => {
		let stopped = false;
		const harness = channelHarness((method) => {
			if (method === "pane.get") return { pane: { ...PANE, agent: null, state_change_seq: 1 } };
			if (method === "agent.get" || method === "agent.rename")
				return {
					agent: {
						...PANE,
						agent: "pi",
						name: "worker",
						agent_status: "idle",
						launch_pending: false,
						state_change_seq: stopped ? 3 : 1,
						revision: 1,
						state_labels: { idle: PI_IDLE_LABEL },
					},
				};
			return { type: "ok" };
		});
		const backend = backendFor(harness);

		const launching = backend.startAgent({ name: "worker", kind: "pi", paneId: PANE_ID, command: "pi-opus" });
		await flushTasks();
		expect(harness.subscriptionSelectors).toContain("pane.agent_detected");
		expect(harness.methods).toContain("pane.send_input");

		// No status change follows: detection alone must re-check and admit the agent.
		stopped = true;
		harness.emit(eventEnvelope("pane_agent_detected", { pane_id: PANE_ID, agent: "pi" }));

		await expect(launching).resolves.toMatchObject({
			status: "idle",
			interactiveReady: true,
			stateChangeSequence: 3,
		});
	});

	it("negative control: a detection for another pane does not admit a custom launch", async () => {
		let stopped = false;
		const harness = channelHarness((method) => {
			if (method === "pane.get") return { pane: { ...PANE, agent: null, state_change_seq: 1 } };
			if (method === "agent.get" || method === "agent.rename")
				return {
					agent: {
						...PANE,
						agent: "pi",
						name: "worker",
						agent_status: "idle",
						launch_pending: false,
						state_change_seq: stopped ? 3 : 1,
						revision: 1,
						state_labels: { idle: PI_IDLE_LABEL },
					},
				};
			return { type: "ok" };
		});
		const backend = backendFor(harness);

		const launching = backend.startAgent({ name: "worker", kind: "pi", paneId: PANE_ID, command: "pi-opus" });
		await flushTasks();
		const readsBefore = harness.methods.filter((method) => method === "agent.get").length;

		stopped = true;
		harness.emit(eventEnvelope("pane_agent_detected", { pane_id: OTHER_PANE_ID, agent: "pi" }));
		await flushTasks();

		expect(harness.methods.filter((method) => method === "agent.get")).toHaveLength(readsBefore);
		expect(harness.methods).not.toContain("agent.rename");

		// Release the launch so nothing is left outstanding.
		harness.emit(eventEnvelope("pane_agent_detected", { pane_id: PANE_ID, agent: "pi" }));
		await expect(launching).resolves.toMatchObject({ status: "idle" });
	});
});
