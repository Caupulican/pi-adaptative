// @isolated: real Unix sockets under a scratch state root
// @guards packages/coding-agent/src/core/chat/mesh.ts packages/coding-agent/src/core/chat/validation.ts

import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMesh, resolveTargets } from "../src/core/chat/mesh.ts";
import { getChatStatePaths } from "../src/core/chat/state.ts";
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
