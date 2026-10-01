// @isolated: real Unix sockets under a scratch state root
// @guards packages/coding-agent/src/core/chat/mesh.ts packages/coding-agent/src/core/chat/validation.ts

import { writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_REPLY_HOPS, REPLY_CHAIN_WINDOW_MS } from "../src/core/chat/constants.ts";
import { incomingPrompt } from "../src/core/chat/incoming.ts";
import { ChatMesh, resolveTargets } from "../src/core/chat/mesh.ts";
import { getChatStatePaths } from "../src/core/chat/state.ts";
import { type ChatRuntime, nextReplyHops } from "../src/core/chat/tools.ts";
import { normalizeAgentSendInput } from "../src/core/chat/validation.ts";
import { tempDir } from "./temp-dir.ts";

const identity = (name: string) => ({ id: `id-${name}`, name, pcLabel: "host", persistent: false });

describe.skipIf(process.platform === "win32")("pi-chat local mesh", () => {
	const meshes: ChatMesh[] = [];
	afterEach(async () => {
		while (meshes.length > 0) await meshes.pop()?.stop();
	});

	function mesh(root: string, name: string, onIncoming?: ConstructorParameters<typeof ChatMesh>[0]["onIncoming"]) {
		const created = new ChatMesh({ self: identity(name), stateRoot: root, onIncoming });
		meshes.push(created);
		return created;
	}

	it("lets two processes discover each other and acknowledge a message", async () => {
		const root = tempDir("pi-chat-mesh-");
		const received: string[] = [];
		const alpha = mesh(root, "alpha", (message) => {
			received.push(`${message.from.name}:${message.message}`);
			return "ACK: alpha has it";
		});
		const beta = mesh(root, "beta");
		await alpha.start();
		await beta.start();
		expect(alpha.brokerActive).toBe(true);
		expect(beta.brokerActive).toBe(false);
		// A call made right after start() must already see the mesh, not race the first peers frame.
		expect(beta.listPeers().map((peer) => peer.id)).toEqual(["id-alpha"]);

		const result = await beta.send(
			{ to: "id-alpha", message: "ping", expectReply: true, timeoutMs: 5_000 },
			[],
			false,
		);
		expect(result.targets).toEqual([{ target: "id-alpha", status: "received", reply: "ACK: alpha has it" }]);
		expect(received).toEqual(["beta:ping"]);
	});

	it("reports an unreachable known peer as offline and refuses unknown, self and unsanctioned broadcast targets", async () => {
		const root = tempDir("pi-chat-mesh-");
		const alpha = mesh(root, "alpha");
		await alpha.start();
		const gone = { id: "id-gone", name: "gone", address: "local:id-gone", scope: "local" as const };
		const offline = await alpha.send(
			{ to: "gone", message: "hello", expectReply: false, timeoutMs: 1_000 },
			[gone],
			false,
		);
		expect(offline.targets).toEqual([{ target: "id-gone", status: "offline" }]);

		const self = identity("alpha");
		expect(() => resolveTargets("nobody", self, [gone], false)).toThrow(/Unknown pi-chat peer/);
		expect(() => resolveTargets("alpha", self, [gone], false)).toThrow(/current Pi agent/);
		expect(() => resolveTargets("*", self, [gone], false)).toThrow(/Broadcast is disabled/);
		expect(resolveTargets("*", self, [gone], true)).toEqual([gone]);
	});

	it("survives malformed and unknown frames from any local process", async () => {
		const root = tempDir("pi-chat-mesh-");
		const alpha = mesh(root, "alpha");
		await alpha.start();
		const { socket: socketPath } = getChatStatePaths(root);
		const raw = createConnection(socketPath);
		await new Promise<void>((resolve) => raw.once("connect", resolve));
		raw.write("not json\n");
		raw.write(`${JSON.stringify({ type: "send", id: 7 })}\n`);
		raw.write(`${JSON.stringify({ type: "mystery" })}\n`);
		raw.write(
			`${JSON.stringify({ type: "hello", peer: { id: "ext-1", name: "external", address: "local:ext-1", scope: "local" } })}\n`,
		);
		const beta = mesh(root, "beta");
		await beta.start();
		await vi.waitFor(() => expect(beta.listPeers().map((peer) => peer.id)).toContain("ext-1"));
		expect(alpha.brokerActive).toBe(true);
		raw.destroy();
	});

	it("shows a peer as busy only while its own turn runs", async () => {
		const root = tempDir("pi-chat-mesh-");
		const alpha = mesh(root, "alpha");
		const beta = mesh(root, "beta");
		await alpha.start();
		await beta.start();
		expect(alpha.listPeers().find((peer) => peer.id === "id-beta")?.busy).toBeFalsy();
		beta.setBusy(true);
		await vi.waitFor(() => expect(alpha.listPeers().find((peer) => peer.id === "id-beta")?.busy).toBe(true));
		beta.setBusy(false);
		await vi.waitFor(() => expect(alpha.listPeers().find((peer) => peer.id === "id-beta")?.busy).toBe(false));
	});

	it("never takes the path of a broker that answers, and replaces a dead socket file", async () => {
		const root = tempDir("pi-chat-mesh-");
		const { socket: socketPath } = getChatStatePaths(root);
		const alpha = mesh(root, "alpha");
		await alpha.start();
		const startBroker = (target: ChatMesh) =>
			(target as unknown as { startBroker(): Promise<boolean> }).startBroker();
		// A second process that finds a live broker joins it; the broker's socket file is untouched.
		const gamma = mesh(root, "gamma");
		expect(await startBroker(gamma)).toBe(false);
		expect(gamma.brokerActive).toBe(false);
		await gamma.start();
		await vi.waitFor(() => expect(alpha.listPeers().map((peer) => peer.id)).toContain("id-gamma"));
		await alpha.stop();

		// A file nothing listens on is stale: the next process becomes the broker.
		writeFileSync(socketPath, "");
		const delta = mesh(root, "delta");
		expect(await startBroker(delta)).toBe(true);
		expect(delta.brokerActive).toBe(true);

		// Something that accepts but is slow to talk is still alive: it is never replaced.
		await delta.stop();
		const quiet = createServer(() => undefined);
		await new Promise<void>((resolve) => quiet.listen(socketPath, resolve));
		try {
			expect(await startBroker(mesh(root, "epsilon"))).toBe(false);
		} finally {
			await new Promise<void>((resolve) => quiet.close(() => resolve()));
		}
	});

	it("bounds a reply chain: a message is one hop past the freshest chain it answers", () => {
		const runtime: Pick<ChatRuntime, "inboundHops"> = { inboundHops: new Map() };
		const now = 1_000_000;
		expect(nextReplyHops(runtime, ["a"], now)).toBe(1);
		runtime.inboundHops.set("a", { hops: 3, at: now });
		runtime.inboundHops.set("b", { hops: 5, at: now });
		expect(nextReplyHops(runtime, ["a"], now)).toBe(4);
		expect(nextReplyHops(runtime, ["a", "b"], now)).toBe(6);
		// An old chain no longer counts, so a fresh conversation starts over.
		expect(nextReplyHops(runtime, ["a"], now + REPLY_CHAIN_WINDOW_MS + 1)).toBe(1);
		runtime.inboundHops.set("a", { hops: MAX_REPLY_HOPS, at: now });
		expect(nextReplyHops(runtime, ["a"], now)).toBeGreaterThan(MAX_REPLY_HOPS);

		const peer = { id: "id-a", name: "a", address: "local:id-a", scope: "local" as const };
		const message = { id: "m", from: peer, to: "id-b", message: "hi", expectReply: true };
		expect(incomingPrompt(message, 2, MAX_REPLY_HOPS)).toContain("call agent_send to peer id");
		const atLimit = incomingPrompt(message, MAX_REPLY_HOPS, MAX_REPLY_HOPS);
		expect(atLimit).toContain("do not reply to the peer");
		expect(atLimit).not.toContain("call agent_send");
	});

	it("rejects malformed agent_send input before anything is sent", () => {
		expect(() => normalizeAgentSendInput({ to: "a", message: "  " })).toThrow(/must not be empty/);
		expect(() => normalizeAgentSendInput({ to: "a", message: "x", extra: 1 })).toThrow(/unsupported field/);
		expect(() => normalizeAgentSendInput({ to: "a", message: "x", timeoutMs: 999_999 })).toThrow(/exceeds max/);
		expect(() => normalizeAgentSendInput({ to: "a", message: "x".repeat(40_000) })).toThrow(/too large/);
		expect(normalizeAgentSendInput({ to: ["a", "b"], message: " hi " })).toMatchObject({
			message: "hi",
			expectReply: false,
		});
	});
});
