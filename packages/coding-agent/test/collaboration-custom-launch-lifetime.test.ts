/**
 * Custom Herdr launch: terminal events versus in-flight requests.
 *
 * `launchHerdrCommand` marks itself terminal from the event callback (herdr-custom-launch.ts:91-118)
 * and settles `ready`, but neither of its two request continuations re-reads that flag before acting:
 *
 * 1. The pre-submission re-read (`pane.get`, line 128-138) validates the *reply* and then sends
 *    `pane.send_input` unconditionally. A pane_closed / connection error that arrives while that read
 *    is in flight leaves the command typed into a pane the launcher has already given up on.
 * 2. The readiness continuation (line 46-57) checks `terminal` only on entry to `check()`. After
 *    `await connection.request("agent.get")` resolves it goes straight to `agent.rename`, mutating an
 *    agent whose launch was already declared terminal.
 *
 * Existing coverage (collaboration-custom-launch.test.ts) drives the happy reread/rename readiness
 * path and the replacement-snapshot rejection, always with the terminal event arriving between
 * requests rather than during one, so neither continuation is ever observed racing a terminal.
 *
 * The channel is injected at the existing `connect` port, so no socket, pipe or process is real. The
 * two bindings are exercised as *values* handed to that port: this proves the launch path is
 * binding-agnostic and forwards the path verbatim, and it is explicitly NOT native Windows pipe I/O.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CollaborationBackendError } from "../src/core/collaboration/backend.ts";
import { HerdrBackend } from "../src/core/collaboration/herdr-backend.ts";
import type { HerdrEventChannel } from "../src/core/collaboration/herdr-channel.ts";

const PANE = { pane_id: "w1:p1", terminal_id: "t-owned", workspace_id: "w1", tab_id: "w1:t1" };
const PI_IDLE_LABEL = "pi:collaboration:12345678-1234-4234-8234-123456789abc";

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

async function flushTasks(rounds = 25): Promise<void> {
	for (let round = 0; round < rounds; round++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

function agentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		...PANE,
		agent: "pi",
		name: "worker",
		agent_status: "idle",
		launch_pending: false,
		state_change_seq: 3,
		revision: 1,
		state_labels: { idle: PI_IDLE_LABEL },
		...overrides,
	};
}

interface ChannelHarness {
	channel: HerdrEventChannel;
	methods: string[];
	connectedPaths: string[];
	emit(event: unknown): void;
	/** Hold the Nth call of a method open until the returned gate is released. */
	hold(method: string, occurrence: number): Deferred;
	connect(path: string): Promise<HerdrEventChannel>;
}

function channelHarness(agentReply: () => Record<string, unknown>): ChannelHarness {
	const methods: string[] = [];
	const connectedPaths: string[] = [];
	const counts = new Map<string, number>();
	const gates = new Map<string, Deferred>();
	let listener: (event: unknown) => void = () => {};

	const request = vi.fn(async (method: string, _params: Record<string, unknown>): Promise<unknown> => {
		const occurrence = (counts.get(method) ?? 0) + 1;
		counts.set(method, occurrence);
		methods.push(method);
		const gate = gates.get(`${method}#${occurrence}`);
		if (gate) await gate.promise;
		if (method === "pane.get") return { pane: { ...PANE, agent: null, state_change_seq: 1 } };
		if (method === "agent.get" || method === "agent.rename") return { agent: agentReply() };
		return {};
	});

	const channel: HerdrEventChannel = {
		request,
		onEvent: (next) => {
			listener = next;
			return () => {
				listener = () => {};
			};
		},
		close: vi.fn(),
	};

	return {
		channel,
		methods,
		connectedPaths,
		emit: (event) => listener(event),
		hold: (method, occurrence) => {
			const gate = deferred();
			gates.set(`${method}#${occurrence}`, gate);
			return gate;
		},
		connect: async (path: string) => {
			connectedPaths.push(path);
			return channel;
		},
	};
}

function backendFor(harness: ChannelHarness, socketPath: string): HerdrBackend {
	return new HerdrBackend({
		executable: "herdr",
		shared: true,
		socketPath,
		connect: harness.connect,
	});
}

/**
 * Both bindings are plain strings handed to the injected `connect` port. The POSIX form is built from
 * tmpdir() so it is a genuinely valid absolute path on whichever OS runs the suite; the Windows form
 * is the literal named-pipe namespace the backend accepts. Neither opens real IO on either platform.
 */
const BINDINGS: ReadonlyArray<{ label: string; socketPath: string }> = [
	{ label: "unix socket", socketPath: join(tmpdir(), `pi-herdr-custom-launch-${process.pid}.sock`) },
	{ label: "windows named pipe", socketPath: `\\\\.\\pipe\\pi-herdr-custom-launch-${process.pid}` },
];

const TERMINAL_EVENTS: ReadonlyArray<{ label: string; event: unknown }> = [
	{ label: "pane_closed", event: { event: "pane_closed", data: { pane_id: PANE.pane_id } } },
	{ label: "connection error", event: { error: { code: "connection_closed", message: "socket ended" } } },
];

describe.each(BINDINGS)("custom collaboration launch lifetime over a $label", ({ socketPath }) => {
	it.each(TERMINAL_EVENTS)(
		"does not send the command after a $label arrives during the pre-submission pane reread",
		async ({ event }) => {
			const harness = channelHarness(() => agentRecord());
			const backend = backendFor(harness, socketPath);
			const gate = harness.hold("pane.get", 2);

			const launching = backend
				.startAgent({ name: "worker", kind: "pi", paneId: PANE.pane_id, command: "pi-opus" })
				.then(
					() => "resolved",
					(error: unknown) => error,
				);
			await flushTasks();
			expect(harness.methods).toContain("events.subscribe");
			expect(harness.methods).not.toContain("pane.send_input");

			harness.emit(event);
			await flushTasks();
			// The pane read now completes with a reply that was already stale when it was issued.
			gate.release();
			const outcome = await launching;

			expect(outcome).toBeInstanceOf(CollaborationBackendError);
			expect(harness.methods).not.toContain("pane.send_input");
			expect(harness.connectedPaths).toEqual([socketPath]);
		},
	);

	it.each(TERMINAL_EVENTS)(
		"does not rename the agent after a $label arrives during the readiness read",
		async ({ event }) => {
			const harness = channelHarness(() => agentRecord());
			const backend = backendFor(harness, socketPath);
			const gate = harness.hold("agent.get", 1);

			const launching = backend
				.startAgent({ name: "worker", kind: "pi", paneId: PANE.pane_id, command: "pi-opus" })
				.then(
					() => "resolved",
					(error: unknown) => error,
				);
			await flushTasks();
			expect(harness.methods).toContain("pane.send_input");
			expect(harness.methods).toContain("agent.get");

			harness.emit(event);
			await flushTasks();
			// A ready-looking reply arrives after the launch was declared terminal.
			gate.release();
			await flushTasks();
			const outcome = await launching;

			expect(outcome).toBeInstanceOf(CollaborationBackendError);
			expect(harness.methods).not.toContain("agent.rename");
			expect(harness.connectedPaths).toEqual([socketPath]);
		},
	);

	it("negative control: an uninterrupted launch sends the command once and admits the agent", async () => {
		const harness = channelHarness(() => agentRecord());
		const backend = backendFor(harness, socketPath);

		const agent = await backend.startAgent({
			name: "worker",
			kind: "pi",
			paneId: PANE.pane_id,
			command: "pi-opus",
		});

		expect(agent).toMatchObject({ status: "idle", interactiveReady: true, stateChangeSequence: 3 });
		expect(harness.methods.filter((method) => method === "pane.send_input")).toHaveLength(1);
		expect(harness.methods).toContain("agent.rename");
		expect(harness.connectedPaths).toEqual([socketPath]);
	});

	it("negative control: an event for a different pane is ignored and triggers no readiness read", async () => {
		let stable = false;
		const harness = channelHarness(() => agentRecord(stable ? {} : { state_change_seq: 1 }));
		const backend = backendFor(harness, socketPath);

		const launching = backend
			.startAgent({ name: "worker", kind: "pi", paneId: PANE.pane_id, command: "pi-opus" })
			.then(
				(value) => value,
				(error: unknown) => error,
			);
		await flushTasks();
		const readsAfterSubmission = harness.methods.filter((method) => method === "agent.get").length;
		expect(readsAfterSubmission).toBe(1);

		harness.emit({ event: "pane.agent_status_changed", data: { pane_id: "w1:other" } });
		harness.emit({ event: "pane_closed", data: { pane_id: "w1:other" } });
		await flushTasks();
		expect(harness.methods.filter((method) => method === "agent.get")).toHaveLength(readsAfterSubmission);

		stable = true;
		harness.emit({ event: "pane.agent_status_changed", data: { pane_id: PANE.pane_id } });
		const outcome = await launching;

		expect(outcome).toMatchObject({ status: "idle", interactiveReady: true });
	});
});
