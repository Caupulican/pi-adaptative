import { randomUUID } from "node:crypto";
import { statSync, unlinkSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { MAX_ENVELOPE_BYTES, MAX_SOCKET_BUFFER_BYTES, RECONNECT_INTERVAL_MS } from "./constants.ts";
import type { RuntimeIdentity } from "./identity.ts";
import { getChatPlatformInfo } from "./platform.ts";
import type { PeerRecord } from "./state.ts";
import type { AgentSendInput } from "./validation.ts";

export type DeliveryStatus =
	| "received"
	| "sent"
	| "busy"
	| "denied"
	| "timeout"
	| "offline"
	| "not_authorized"
	| "bad_envelope";

export type DeliveryTarget = {
	target: string;
	status: DeliveryStatus;
	reply?: string;
};

export type AgentSendResult = {
	id: string;
	targets: DeliveryTarget[];
};

export type IncomingPeerMessage = {
	id: string;
	from: PeerRecord;
	to: string;
	message: string;
	expectReply: boolean;
	metadata?: Record<string, unknown>;
};

export type ChatMeshStatus = {
	supported: boolean;
	brokerActive: boolean;
	connected: boolean;
	endpoint?: string;
};

type WireMessage =
	| { type: "hello"; peer: PeerRecord }
	| { type: "peers"; peers: PeerRecord[] }
	| {
			type: "send";
			id: string;
			to: string[];
			message: string;
			expectReply: boolean;
			timeoutMs: number;
			metadata?: Record<string, unknown>;
	  }
	| {
			type: "incoming";
			id: string;
			from: PeerRecord;
			to: string;
			message: string;
			expectReply: boolean;
			metadata?: Record<string, unknown>;
	  }
	| { type: "delivery_ack"; id: string; target: string; status: DeliveryStatus; reply?: string }
	| { type: "send_result"; id: string; targets: DeliveryTarget[] }
	| { type: "error"; id?: string; message: string };

type ServerPeerConnection = { socket: Socket; peer?: PeerRecord };

type PendingServerSend = {
	sender: Socket;
	results: DeliveryTarget[];
	waiting: Set<string>;
	timer: ReturnType<typeof setTimeout>;
};

type PendingClientSend = {
	resolve: (result: AgentSendResult) => void;
	timer: ReturnType<typeof setTimeout>;
};

export type ChatMeshOptions = {
	self: RuntimeIdentity;
	stateRoot: string;
	/** Returns the acknowledgement text for an expectReply message. */
	onIncoming?: (message: IncomingPeerMessage) => string | undefined | Promise<string | undefined>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPeerRecord(value: unknown): value is PeerRecord {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.address === "string"
	);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error;
}

/** Any local process can write to the socket, so every frame is shape-checked before use. */
function parseWire(line: string): WireMessage | undefined {
	if (!line.trim() || Buffer.byteLength(line, "utf8") > MAX_ENVELOPE_BYTES) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || typeof value.type !== "string") return undefined;
	switch (value.type) {
		case "hello":
			return isPeerRecord(value.peer) ? (value as WireMessage) : undefined;
		case "peers":
			return Array.isArray(value.peers) && value.peers.every(isPeerRecord) ? (value as WireMessage) : undefined;
		case "send":
			return typeof value.id === "string" &&
				Array.isArray(value.to) &&
				value.to.every((target) => typeof target === "string") &&
				typeof value.message === "string" &&
				typeof value.expectReply === "boolean" &&
				typeof value.timeoutMs === "number"
				? (value as WireMessage)
				: undefined;
		case "incoming":
			return typeof value.id === "string" &&
				isPeerRecord(value.from) &&
				typeof value.to === "string" &&
				typeof value.message === "string" &&
				typeof value.expectReply === "boolean"
				? (value as WireMessage)
				: undefined;
		case "delivery_ack":
			return typeof value.id === "string" && typeof value.target === "string" && typeof value.status === "string"
				? (value as WireMessage)
				: undefined;
		case "send_result":
			return typeof value.id === "string" && Array.isArray(value.targets) ? (value as WireMessage) : undefined;
		case "error":
			return typeof value.message === "string" ? (value as WireMessage) : undefined;
		default:
			return undefined;
	}
}

function writeWire(socket: Socket, message: WireMessage): void {
	if (socket.destroyed || !socket.writable) return;
	const frame = `${JSON.stringify(message)}\n`;
	if (Buffer.byteLength(frame, "utf8") > MAX_ENVELOPE_BYTES || socket.writableLength > MAX_SOCKET_BUFFER_BYTES) {
		socket.destroy();
		return;
	}
	const accepted = socket.write(frame);
	if (!accepted && socket.writableLength > MAX_SOCKET_BUFFER_BYTES) socket.destroy();
}

function socketIdentity(socketPath: string): string | undefined {
	try {
		const stat = statSync(socketPath);
		return `${stat.dev}:${stat.ino}`;
	} catch {
		return undefined;
	}
}

function unlinkIfSameSocket(socketPath: string, identity?: string): void {
	if (!identity || socketIdentity(socketPath) !== identity) return;
	try {
		unlinkSync(socketPath);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
	}
}

async function removeStaleSocket(socketPath: string): Promise<void> {
	try {
		await unlink(socketPath);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
	}
}

type SelfIdentity = Pick<RuntimeIdentity, "id" | "name">;

function matchesSelf(target: string, self: SelfIdentity): boolean {
	return (
		target === self.id || target === self.name || target === `local:${self.id}` || target === `local:${self.name}`
	);
}

export function resolveTargets(
	to: string | string[],
	self: SelfIdentity,
	peers: PeerRecord[],
	broadcastEnabled: boolean,
): PeerRecord[] {
	const requested = Array.isArray(to) ? to : [to];
	if (requested.length === 0) throw new Error("agent_send.to must include at least one target.");
	if (requested.includes("*")) {
		if (requested.length > 1) throw new Error("Broadcast target '*' cannot be mixed with explicit targets.");
		if (!broadcastEnabled) throw new Error("Broadcast is disabled; set broadcastEnabled in the pi-chat config.");
		return peers.filter((peer) => !matchesSelf(peer.id, self));
	}
	const resolved: PeerRecord[] = [];
	for (const target of requested) {
		const trimmed = target.trim();
		if (trimmed.length === 0) throw new Error("agent_send target must not be empty.");
		if (matchesSelf(trimmed, self)) throw new Error("agent_send refuses to send messages to the current Pi agent.");
		const peer = peers.find(
			(candidate) => candidate.id === trimmed || candidate.name === trimmed || candidate.address === trimmed,
		);
		if (!peer) throw new Error(`Unknown pi-chat peer target: ${trimmed}`);
		if (!resolved.some((existing) => existing.id === peer.id)) resolved.push(peer);
	}
	return resolved;
}

function offlineResult(targets: PeerRecord[], expectReply: boolean): AgentSendResult {
	return {
		id: randomUUID(),
		targets: targets.map((target) => ({
			target: target.id,
			status: target.busy ? "busy" : "offline",
			reply: expectReply && !target.busy ? "No pi-chat transport is active; delivery was not attempted." : undefined,
		})),
	};
}

/**
 * Newline-JSON peer mesh over one Unix socket. The first process to find no broker becomes it; every
 * other process is a client of that broker. The wire protocol matches the user-level pi-chat
 * extension, so agents that already speak it can join the same socket.
 */
export class ChatMesh {
	private self: PeerRecord;
	private readonly socketPath?: string;
	private readonly onIncoming?: ChatMeshOptions["onIncoming"];
	private server?: Server;
	private client?: Socket;
	private clientBuffer = "";
	private readonly serverConnections = new Map<Socket, ServerPeerConnection>();
	private readonly pendingServerSends = new Map<string, PendingServerSend>();
	private readonly pendingClientSends = new Map<string, PendingClientSend>();
	private peers = new Map<string, PeerRecord>();
	private peersFrameSeen = false;
	private peersFrameWaiters: Array<() => void> = [];
	private startPromise?: Promise<void>;
	private connectPromise?: Promise<boolean>;
	private reconnectTimer?: ReturnType<typeof setInterval>;
	private stopping = false;
	private generation = 0;
	private started = false;
	private serverSocketIdentity?: string;
	private clientSocketIdentity?: string;

	constructor(options: ChatMeshOptions) {
		this.onIncoming = options.onIncoming;
		this.socketPath = getChatPlatformInfo(options.stateRoot).socketPath;
		this.self = this.buildSelf(options.self);
	}

	get supported(): boolean {
		return this.socketPath !== undefined;
	}

	get brokerActive(): boolean {
		return Boolean(this.server?.listening);
	}

	status(): ChatMeshStatus {
		return {
			supported: this.supported,
			brokerActive: this.brokerActive,
			connected: Boolean(this.client && !this.client.destroyed),
			endpoint: this.socketPath,
		};
	}

	updateSelf(identity: RuntimeIdentity): void {
		this.self = this.buildSelf(identity);
		if (this.client && !this.client.destroyed) writeWire(this.client, this.helloMessage());
	}

	async start(): Promise<void> {
		if (!this.supported || this.stopping) return;
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.startUnlocked().finally(() => {
			this.startPromise = undefined;
		});
		return this.startPromise;
	}

	private async startUnlocked(): Promise<void> {
		if (!this.socketPath || this.stopping) return;
		if (this.started && this.shouldRejoinCanonicalBroker()) await this.prepareForReconnect(false);
		if (this.started && this.client && !this.client.destroyed) {
			this.stopReconnectTimer();
			await this.awaitFirstPeersFrame();
			return;
		}
		if (this.started && (!this.client || this.client.destroyed)) this.started = false;
		this.stopReconnectTimer();
		await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
		let connected = await this.connectClient();
		if (this.stopping) return;
		if (!connected) {
			await this.startBroker();
			if (this.stopping) return;
			connected = await this.connectClient();
		}
		if (!connected) this.scheduleReconnect();
		this.started = true;
		if (connected) await this.awaitFirstPeersFrame();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.generation += 1;
		this.started = false;
		const inFlightStart = this.startPromise;
		this.startPromise = undefined;
		if (inFlightStart) {
			try {
				await inFlightStart;
			} catch {
				// Shutdown is best effort.
			}
		}
		for (const [id, pending] of this.pendingClientSends) {
			clearTimeout(pending.timer);
			pending.resolve({
				id,
				targets: [
					{ target: "pi-chat", status: "offline", reply: "pi-chat mesh stopped before delivery completed." },
				],
			});
		}
		this.pendingClientSends.clear();
		for (const [id, pending] of this.pendingServerSends) {
			clearTimeout(pending.timer);
			for (const target of pending.waiting) pending.results.push({ target, status: "offline" });
			writeWire(pending.sender, { type: "send_result", id, targets: pending.results });
		}
		this.pendingServerSends.clear();
		this.peers.clear();
		this.stopReconnectTimer();
		this.client?.destroy();
		this.client = undefined;
		this.clientSocketIdentity = undefined;
		this.connectPromise = undefined;
		await this.closeServer(true);
		this.stopping = false;
	}

	private shouldRejoinCanonicalBroker(): boolean {
		if (!this.socketPath) return false;
		const current = socketIdentity(this.socketPath);
		if (this.server && this.serverSocketIdentity && current !== this.serverSocketIdentity) return true;
		return Boolean(
			this.client &&
				!this.client.destroyed &&
				this.clientSocketIdentity &&
				current &&
				current !== this.clientSocketIdentity,
		);
	}

	private async prepareForReconnect(unlinkOwnedSocket: boolean): Promise<void> {
		this.peers.clear();
		this.stopReconnectTimer();
		this.client?.destroy();
		this.client = undefined;
		this.clientSocketIdentity = undefined;
		this.connectPromise = undefined;
		await this.closeServer(unlinkOwnedSocket);
		this.started = false;
	}

	private async closeServer(unlinkOwnedSocket: boolean): Promise<void> {
		for (const connection of this.serverConnections.values()) connection.socket.destroy();
		this.serverConnections.clear();
		const server = this.server;
		const identity = this.serverSocketIdentity;
		this.server = undefined;
		this.serverSocketIdentity = undefined;
		if (!server) return;
		await new Promise<void>((resolve) => {
			server.close(() => {
				if (unlinkOwnedSocket && this.socketPath) unlinkIfSameSocket(this.socketPath, identity);
				resolve();
			});
		});
	}

	/**
	 * A connected client knows no peers until the broker's first `peers` frame arrives, a moment after
	 * `hello`. Waiting on that frame (bounded) keeps a call made right after `start()` from seeing an
	 * empty mesh.
	 */
	private async awaitFirstPeersFrame(timeoutMs = 1_000): Promise<void> {
		if (!this.client || this.client.destroyed || this.peersFrameSeen) return;
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(done, timeoutMs);
			timer.unref?.();
			this.peersFrameWaiters.push(done);
		});
	}

	private noteFirstPeersFrame(): void {
		this.peersFrameSeen = true;
		for (const waiter of this.peersFrameWaiters.splice(0)) waiter();
	}

	listPeers(includeSelf = false): PeerRecord[] {
		return [...this.peers.values()]
			.filter((peer) => includeSelf || peer.id !== this.self.id)
			.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	}

	async send(
		input: AgentSendInput,
		configuredPeers: PeerRecord[],
		broadcastEnabled: boolean,
	): Promise<AgentSendResult> {
		const peersById = new Map<string, PeerRecord>();
		for (const peer of configuredPeers) peersById.set(peer.id, peer);
		for (const peer of this.listPeers(false)) peersById.set(peer.id, peer);
		const targets = resolveTargets(input.to, this.self, [...peersById.values()], broadcastEnabled);
		const client = this.client;
		if (!client || client.destroyed) return offlineResult(targets, true);
		const id = randomUUID();
		const targetIds = targets.map((target) => target.id);
		return new Promise<AgentSendResult>((resolve) => {
			const timer = setTimeout(() => {
				this.pendingClientSends.delete(id);
				resolve({ id, targets: targetIds.map((target) => ({ target, status: "timeout" })) });
			}, input.timeoutMs);
			this.pendingClientSends.set(id, { resolve, timer });
			writeWire(client, {
				type: "send",
				id,
				to: targetIds,
				message: input.message,
				expectReply: input.expectReply,
				timeoutMs: input.timeoutMs,
				metadata: input.metadata,
			});
		});
	}

	private scheduleReconnect(): void {
		if (this.stopping || !this.supported || this.reconnectTimer) return;
		this.reconnectTimer = setInterval(() => {
			if (this.stopping || (this.client && !this.client.destroyed)) {
				this.stopReconnectTimer();
				return;
			}
			void this.start().catch(() => {
				// A failed reconnect is retried on the next tick.
			});
		}, RECONNECT_INTERVAL_MS);
		this.reconnectTimer.unref?.();
	}

	private stopReconnectTimer(): void {
		if (this.reconnectTimer) clearInterval(this.reconnectTimer);
		this.reconnectTimer = undefined;
	}

	private buildSelf(identity: RuntimeIdentity): PeerRecord {
		return {
			id: identity.id,
			name: identity.name,
			address: `local:${identity.id}`,
			scope: "local",
			busy: false,
			lastSeen: new Date().toISOString(),
		};
	}

	private helloMessage(): Extract<WireMessage, { type: "hello" }> {
		return { type: "hello", peer: { ...this.self, lastSeen: new Date().toISOString() } };
	}

	private async startBroker(): Promise<void> {
		const socketPath = this.socketPath;
		if (!socketPath) return;
		await removeStaleSocket(socketPath);
		const server = createServer((socket) => this.handleServerConnection(socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				this.serverSocketIdentity = socketIdentity(socketPath);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(socketPath);
		});
	}

	private async connectClient(): Promise<boolean> {
		if (this.client && !this.client.destroyed) return true;
		if (this.connectPromise) return this.connectPromise;
		this.connectPromise = this.connectClientUnlocked().finally(() => {
			this.connectPromise = undefined;
		});
		return this.connectPromise;
	}

	private async connectClientUnlocked(): Promise<boolean> {
		const socketPath = this.socketPath;
		if (!socketPath || this.stopping) return false;
		const generation = this.generation;
		return new Promise<boolean>((resolve) => {
			const socket = createConnection(socketPath);
			let settled = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const fail = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				socket.destroy();
				resolve(false);
			};
			timeout = setTimeout(fail, 500);
			timeout.unref?.();
			socket.once("connect", () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				if (this.stopping || generation !== this.generation) {
					socket.destroy();
					resolve(false);
					return;
				}
				this.client = socket;
				this.clientBuffer = "";
				this.peersFrameSeen = false;
				socket.setEncoding("utf8");
				this.clientSocketIdentity = socketIdentity(socketPath);
				socket.on("data", (chunk) => this.handleClientData(String(chunk)));
				const dropped = () => {
					if (this.client !== socket) return;
					this.client = undefined;
					this.clientSocketIdentity = undefined;
					this.noteFirstPeersFrame();
					this.scheduleReconnect();
				};
				socket.on("close", dropped);
				socket.on("error", dropped);
				writeWire(socket, this.helloMessage());
				resolve(true);
			});
			socket.once("error", fail);
		});
	}

	private handleServerConnection(socket: Socket): void {
		socket.setEncoding("utf8");
		this.serverConnections.set(socket, { socket });
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += String(chunk);
			if (Buffer.byteLength(buffer, "utf8") > MAX_SOCKET_BUFFER_BYTES) {
				socket.destroy();
				return;
			}
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) this.handleServerMessage(socket, line);
		});
		const gone = () => {
			this.serverConnections.delete(socket);
			this.broadcastPeerList();
		};
		socket.on("close", gone);
		socket.on("error", gone);
	}

	private handleServerMessage(socket: Socket, line: string): void {
		const message = parseWire(line);
		const connection = this.serverConnections.get(socket);
		if (!message || !connection) return;
		if (message.type === "hello") {
			connection.peer = { ...message.peer, scope: "local", lastSeen: new Date().toISOString() };
			this.broadcastPeerList();
			return;
		}
		if (message.type === "send") this.handleServerSend(socket, message);
		else if (message.type === "delivery_ack") this.handleDeliveryAck(message);
	}

	private handleServerSend(senderSocket: Socket, message: Extract<WireMessage, { type: "send" }>): void {
		const sender = this.serverConnections.get(senderSocket)?.peer;
		if (!sender) {
			writeWire(senderSocket, {
				type: "error",
				id: message.id,
				message: "Sender is not registered with the pi-chat broker.",
			});
			return;
		}
		const results: DeliveryTarget[] = [];
		const waiting = new Set<string>();
		const connected = this.connectedPeers();
		for (const targetId of message.to) {
			const target = connected.find((entry) => entry.peer.id === targetId);
			if (!target) {
				results.push({ target: targetId, status: "offline" });
				continue;
			}
			waiting.add(targetId);
			writeWire(target.socket, {
				type: "incoming",
				id: message.id,
				from: sender,
				to: targetId,
				message: message.message,
				expectReply: message.expectReply,
				metadata: message.metadata,
			});
		}
		if (waiting.size === 0) {
			writeWire(senderSocket, { type: "send_result", id: message.id, targets: results });
			return;
		}
		const timer = setTimeout(
			() => {
				const pending = this.pendingServerSends.get(message.id);
				if (!pending) return;
				for (const target of pending.waiting) pending.results.push({ target, status: "timeout" });
				this.pendingServerSends.delete(message.id);
				writeWire(pending.sender, { type: "send_result", id: message.id, targets: pending.results });
			},
			Math.max(1, message.timeoutMs),
		);
		this.pendingServerSends.set(message.id, { sender: senderSocket, results, waiting, timer });
	}

	private handleDeliveryAck(message: Extract<WireMessage, { type: "delivery_ack" }>): void {
		const pending = this.pendingServerSends.get(message.id);
		if (!pending?.waiting.has(message.target)) return;
		pending.waiting.delete(message.target);
		pending.results.push({ target: message.target, status: message.status, reply: message.reply });
		if (pending.waiting.size === 0) {
			clearTimeout(pending.timer);
			this.pendingServerSends.delete(message.id);
			writeWire(pending.sender, { type: "send_result", id: message.id, targets: pending.results });
		}
	}

	private broadcastPeerList(): void {
		const connected = this.connectedPeers();
		const peers = connected.map((entry) => entry.peer);
		for (const entry of connected) writeWire(entry.socket, { type: "peers", peers });
	}

	private connectedPeers(): Array<{ socket: Socket; peer: PeerRecord }> {
		const result: Array<{ socket: Socket; peer: PeerRecord }> = [];
		for (const connection of this.serverConnections.values()) {
			if (connection.peer && !connection.socket.destroyed)
				result.push({ socket: connection.socket, peer: connection.peer });
		}
		return result;
	}

	private handleClientData(chunk: string): void {
		this.clientBuffer += chunk;
		if (Buffer.byteLength(this.clientBuffer, "utf8") > MAX_SOCKET_BUFFER_BYTES) {
			this.client?.destroy();
			this.clientBuffer = "";
			return;
		}
		const lines = this.clientBuffer.split("\n");
		this.clientBuffer = lines.pop() ?? "";
		for (const line of lines) {
			void this.handleClientMessage(line).catch(() => {
				// A malformed or racing frame is dropped.
			});
		}
	}

	private async handleClientMessage(line: string): Promise<void> {
		const message = parseWire(line);
		if (!message) return;
		if (message.type === "peers") {
			this.peers = new Map(message.peers.map((peer) => [peer.id, peer]));
			this.noteFirstPeersFrame();
			return;
		}
		if (message.type === "incoming") {
			let reply: string | undefined;
			try {
				reply = await this.onIncoming?.({
					id: message.id,
					from: message.from,
					to: message.to,
					message: message.message,
					expectReply: message.expectReply,
					metadata: message.metadata,
				});
			} catch (error) {
				reply = error instanceof Error ? error.message : String(error);
			}
			if (this.client && !this.client.destroyed) {
				writeWire(this.client, {
					type: "delivery_ack",
					id: message.id,
					target: this.self.id,
					status: "received",
					reply: message.expectReply ? reply || `ACK: received by ${this.self.name}` : undefined,
				});
			}
			return;
		}
		if (message.type === "send_result") {
			const pending = this.pendingClientSends.get(message.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.pendingClientSends.delete(message.id);
			pending.resolve({ id: message.id, targets: message.targets });
		}
	}
}
