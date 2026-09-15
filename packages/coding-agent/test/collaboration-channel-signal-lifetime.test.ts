/**
 * connectHerdrChannel signal lifetime, over a real socket / named pipe.
 *
 * `connectHerdrChannel` registers `signal.addEventListener("abort", fail, { once: true })`
 * (herdr-channel.ts:34) for the channel's whole lifetime, not just for the reachability probe.
 * `fail` (:18-33) rejects every in-flight request, destroys their sockets, emits
 * `{ error: { code: "connection_closed" } }` to every listener exactly once, and latches `closed` so
 * later requests are refused without touching the transport.
 *
 * That is the cancellation and deadline path for anything awaiting channel events - notably
 * `HerdrBackend.answerQuestion`, whose `await settled` is released by that emitted error through its
 * own `event.error` branch. A test double that ignores the signal cannot observe this, so this file
 * uses the real implementation against a locally owned server.
 *
 * Expected GREEN control. Readiness and completion are observed from events only: the subscription
 * acknowledgement is the awaited request itself, the server signals receipt from its own data
 * handler, and socket teardown is awaited via `close` events. Nothing is polled. No Herdr daemon, no
 * provider, no paid model. The same fixture runs unchanged on Windows (named pipe) and POSIX.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationBackendError } from "../src/core/collaboration/backend.ts";
import { connectHerdrChannel, type HerdrEventChannel } from "../src/core/collaboration/herdr-channel.ts";

const DEADLINE_MS = 10_000;
/** A method this fixture's server accepts and deliberately never answers. */
const UNANSWERED_METHOD = "pane.get";

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), DEADLINE_MS);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

interface ServerFixture {
	path: string;
	server: Server;
	sockets: Set<Socket>;
	/** Methods the server actually received, in arrival order. */
	received: string[];
	/** Resolves once the server has read a request for `UNANSWERED_METHOD`. */
	unansweredReceived: Promise<void>;
	connectionCount(): number;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
	// Runs even when admission or readiness failed part-way through a fixture.
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/**
 * Mirrors the Herdr wire contract this channel is written against: one request per connection, and
 * only `events.subscribe` keeps its socket open after the acknowledgement.
 */
function serverFixture(): ServerFixture {
	const directory = mkdtempSync(join(tmpdir(), "pi-herdr-signal-"));
	const path =
		process.platform === "win32"
			? `\\\\.\\pipe\\pi-herdr-signal-${process.pid}-${Date.now()}`
			: join(directory, "api.sock");
	const sockets = new Set<Socket>();
	const received: string[] = [];
	let connectionCount = 0;
	let announceUnanswered!: () => void;
	const unansweredReceived = new Promise<void>((resolve) => {
		announceUnanswered = resolve;
	});

	const server = createServer((socket) => {
		connectionCount += 1;
		sockets.add(socket);
		socket.on("error", () => sockets.delete(socket));
		socket.on("close", () => sockets.delete(socket));
		let text = "";
		let consumed = false;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			if (consumed) return;
			text += chunk;
			if (!text.includes("\n")) return;
			consumed = true;
			const request = JSON.parse(text.slice(0, text.indexOf("\n"))) as { id: string; method: string };
			received.push(request.method);
			if (request.method === UNANSWERED_METHOD) {
				// Held open with no reply: an in-flight request for the abort to cancel.
				announceUnanswered();
				return;
			}
			const response = `${JSON.stringify({ id: request.id, result: { accepted: request.method } })}\n`;
			if (request.method === "events.subscribe") socket.write(response);
			else socket.end(response);
		});
	});

	const fixture: ServerFixture = {
		path,
		server,
		sockets,
		received,
		unansweredReceived,
		connectionCount: () => connectionCount,
	};
	cleanups.push(() => {
		for (const socket of sockets) socket.destroy();
		server.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return fixture;
}

async function listening(fixture: ServerFixture): Promise<void> {
	await withDeadline(
		new Promise<void>((resolve, reject) => {
			fixture.server.once("error", reject);
			fixture.server.listen(fixture.path, () => resolve());
		}),
		"the fixture server to listen",
	);
}

interface LiveChannel {
	channel: HerdrEventChannel;
	events: unknown[];
	/** Resolves the first time the channel notifies its listeners. */
	notified: Promise<void>;
}

async function subscribedChannel(fixture: ServerFixture, signal: AbortSignal): Promise<LiveChannel> {
	const channel = await withDeadline(connectHerdrChannel(fixture.path, signal), "the channel to connect");
	cleanups.push(() => channel.close());
	const events: unknown[] = [];
	let announceNotified!: () => void;
	const notified = new Promise<void>((resolve) => {
		announceNotified = resolve;
	});
	channel.onEvent((event) => {
		events.push(event);
		announceNotified();
	});
	// Awaiting the acknowledgement IS the readiness signal; nothing is polled.
	await withDeadline(channel.request("events.subscribe", { subscriptions: [] }), "the subscription acknowledgement");
	return { channel, events, notified };
}

async function allSocketsClosed(fixture: ServerFixture): Promise<void> {
	const open = [...fixture.sockets].filter((socket) => !socket.destroyed);
	await withDeadline(Promise.all(open.map((socket) => once(socket, "close"))), "the fixture server sockets to close");
}

describe("herdr channel signal lifetime", () => {
	it("an abort after subscription cancels live requests, notifies once, and closes the transport", async () => {
		const fixture = serverFixture();
		await listening(fixture);
		const controller = new AbortController();
		const live = await subscribedChannel(fixture, controller.signal);

		const pending = live.channel.request(UNANSWERED_METHOD, { pane_id: "w1:p1" }).then(
			() => "resolved",
			(error: unknown) => error,
		);
		await withDeadline(fixture.unansweredReceived, "the server to receive the unanswered request");
		const connectionsBeforeAbort = fixture.connectionCount();

		controller.abort();

		const outcome = await withDeadline(pending, "the in-flight request to settle");
		expect(outcome).toBeInstanceOf(CollaborationBackendError);
		expect((outcome as CollaborationBackendError).code).toBe("connection_closed");

		await withDeadline(live.notified, "the channel to notify its listener");
		expect(live.events).toEqual([{ error: { code: "connection_closed" } }]);

		await allSocketsClosed(fixture);

		// A closed channel refuses further work without ever reaching the transport.
		const afterClose = await live.channel.request("pane.list", {}).then(
			() => "resolved",
			(error: unknown) => error,
		);
		expect(afterClose).toBeInstanceOf(CollaborationBackendError);
		expect(fixture.connectionCount()).toBe(connectionsBeforeAbort);
		expect(fixture.received).not.toContain("pane.list");

		// The notification is latched: closing again must not produce a second one.
		live.channel.close();
		expect(live.events).toHaveLength(1);
	});

	it("a deadline reached after subscription notifies exactly once through the same path", async () => {
		const fixture = serverFixture();
		await listening(fixture);
		// The signal is handed to connect exactly as a real deadline would be, but the timer that trips
		// it is armed only once readiness is proven below. An `AbortSignal.timeout` started before
		// connect would let slow host startup - a Windows named pipe, a loaded runner - decide this
		// test, which would be an unrelated failure rather than the lifetime behaviour under test.
		const controller = new AbortController();
		const live = await subscribedChannel(fixture, controller.signal);

		const pending = live.channel.request(UNANSWERED_METHOD, { pane_id: "w1:p1" }).then(
			() => "resolved",
			(error: unknown) => error,
		);
		await withDeadline(fixture.unansweredReceived, "the server to receive the unanswered request");

		// Readiness is established: arm the one-shot deadline now. Nothing else aborts this channel.
		const deadline = setTimeout(() => controller.abort(), 50);
		deadline.unref?.();
		cleanups.push(() => clearTimeout(deadline));

		// The deadline fires on its own; the listener notification is the observed event.
		await withDeadline(live.notified, "the deadline to notify the channel listener");

		expect(live.events).toEqual([{ error: { code: "connection_closed" } }]);
		expect(await withDeadline(pending, "the in-flight request to settle")).toBeInstanceOf(CollaborationBackendError);
		await allSocketsClosed(fixture);
	});

	it("negative control: an un-aborted channel keeps serving requests and notifies nothing", async () => {
		const fixture = serverFixture();
		await listening(fixture);
		const controller = new AbortController();
		const live = await subscribedChannel(fixture, controller.signal);

		const result = await withDeadline(live.channel.request("pane.list", {}), "a normal request");

		expect(result).toEqual({ accepted: "pane.list" });
		expect(live.events).toEqual([]);
		expect(fixture.received).toEqual(["events.subscribe", "pane.list"]);

		// Explicit close uses the same latch as abort.
		live.channel.close();
		await withDeadline(live.notified, "the explicit close to notify");
		expect(live.events).toEqual([{ error: { code: "connection_closed" } }]);
	});
});
