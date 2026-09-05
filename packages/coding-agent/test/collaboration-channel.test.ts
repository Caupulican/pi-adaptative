import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectHerdrChannel } from "../src/core/collaboration/herdr-channel.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function serverFixture() {
	const directory = await mkdtemp(join(tmpdir(), "pi-herdr-wire-"));
	const path =
		process.platform === "win32"
			? `\\\\.\\pipe\\pi-herdr-wire-${process.pid}-${Date.now()}`
			: join(directory, "api.sock");
	const sockets = new Set<Socket>();
	const methods: string[] = [];
	let subscription: Socket | undefined;
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let text = "";
		let consumed = false;
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			if (consumed) return;
			text += chunk;
			if (!text.includes("\n")) return;
			consumed = true;
			const request = JSON.parse(text.slice(0, text.indexOf("\n"))) as { id: string; method: string };
			methods.push(request.method);
			const response = `${JSON.stringify({ id: request.id, result: { accepted: request.method } })}\n`;
			// The real Herdr server consumes one request per connection, except the subscription stream.
			if (request.method === "events.subscribe") {
				subscription = socket;
				socket.write(response);
			} else socket.end(response);
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, resolve);
	});
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	});
	return {
		path,
		methods,
		event: () =>
			subscription?.write(
				`${JSON.stringify({ event: "pane_agent_status_changed", data: { pane_id: "pane:1" } })}\n`,
			),
		disconnect: () => subscription?.destroy(),
	};
}

describe("Herdr single-request socket protocol", () => {
	it("uses independent RPC sockets while retaining the acknowledged event subscription", async () => {
		const server = await serverFixture();
		const channel = await connectHerdrChannel(server.path, AbortSignal.timeout(5000));
		cleanups.push(async () => channel.close());
		await expect(channel.request("pane.get", {})).resolves.toEqual({ accepted: "pane.get" });
		await expect(channel.request("events.subscribe", { subscriptions: [] })).resolves.toEqual({
			accepted: "events.subscribe",
		});
		await expect(channel.request("pane.send_input", {})).resolves.toEqual({ accepted: "pane.send_input" });
		const event = new Promise((resolve) => channel.onEvent(resolve));
		server.event();
		await expect(event).resolves.toMatchObject({ event: "pane_agent_status_changed" });
		expect(server.methods).toEqual(["pane.get", "events.subscribe", "pane.send_input"]);
		const closed = new Promise((resolve) => channel.onEvent(resolve));
		server.disconnect();
		await expect(closed).resolves.toMatchObject({ error: { code: "connection_closed" } });
		await expect(channel.request("pane.get", {})).rejects.toThrow("unavailable");
	});
	it("ordinary completed RPC closure is not a connection-loss event or a reason to replay input", async () => {
		const server = await serverFixture();
		const channel = await connectHerdrChannel(server.path, AbortSignal.timeout(5000));
		cleanups.push(async () => channel.close());
		const events: unknown[] = [];
		channel.onEvent((event) => events.push(event));
		await channel.request("pane.report_agent", {});
		await channel.request("pane.release_agent", {});
		expect(events).toEqual([]);
		expect(server.methods).toEqual(["pane.report_agent", "pane.release_agent"]);
	});
});
