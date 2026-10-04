import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
	BROKER_PROBE_TIMEOUT_MS,
	CHAT_CREDENTIAL_ENV,
	CHAT_SESSION_ID_ENV,
	MAX_BROKER_CHAINS,
	MAX_BROKER_CREDENTIALS,
	MAX_ENVELOPE_BYTES,
	MAX_MESSAGE_ID_CHARS,
	MAX_PEER_FIELD_CHARS,
	MAX_REMEMBERED_MESSAGES,
	MAX_REPLY_HOPS,
	MAX_SOCKET_BUFFER_BYTES,
	MAX_TIMEOUT_MS,
	MESSAGE_ID_PATTERN,
	RECONNECT_INTERVAL_MS,
	REPLY_CHAIN_WINDOW_MS,
} from "./constants.ts";
import type { RuntimeIdentity } from "./identity.ts";
import { getChatPlatformInfo } from "./platform.ts";
import { ensureChatStateDirs, type PeerRecord, readChatSessionSecret } from "./state.ts";
import type { AgentSendInput } from "./validation.ts";

export type DeliveryStatus =
	| "received"
	| "failed"
	| "sent"
	| "busy"
	| "denied"
	| "timeout"
	| "offline"
	| "not_authorized"
	| "bad_envelope";

/** What the receiving session did with one incoming message: it took it (with an optional reply) or failed. */
type IncomingOutcome = { failed: boolean; reply?: string };

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
	| { type: "hello"; peer: PeerRecord; protocol?: number; credential?: string; proof?: string }
	| { type: "registered"; credential: string }
	| { type: "peers"; peers: PeerRecord[] }
	| {
			type: "send";
			credential?: string;
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
	| {
			type: "delivery_ack";
			credential?: string;
			id: string;
			target: string;
			status: DeliveryStatus;
			reply?: string;
	  }
	| { type: "send_result"; id: string; targets: DeliveryTarget[] }
	| { type: "error"; id?: string; message: string };

/** What the broker holds for one connection: the claim it accepted, the credential bound to it and its rank. */
type ServerPeerConnection = {
	socket: Socket;
	peer?: PeerRecord;
	credential?: string;
	/**
	 * A peer whose hello does not announce the credential protocol (an older pi-chat client or extension).
	 * It is registered as an unverified peer with no credential: its frames are never refused for lacking one,
	 * and the broker never marks it verified.
	 */
	legacy?: boolean;
	/** The id a legacy peer announced when the broker had to assign it another (see {@link ChatMesh.handleHello}). */
	legacyClaim?: string;
	/** Registration order: the earliest holder of a name keeps it. */
	seq: number;
};

/** The hello protocol that carries the credential handshake; a hello without it is a legacy peer. */
const CREDENTIAL_PROTOCOL = 2;

type PendingServerSend = {
	messageId: string;
	sender: Socket;
	results: DeliveryTarget[];
	waiting: Set<string>;
	timer: ReturnType<typeof setTimeout>;
};

type PendingClientSend = {
	resolvers: Array<(result: AgentSendResult) => void>;
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

/** Peer identity text reaches prompts and the UI, so it is bounded and carries no control or line-break characters. */
function isPeerText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_PEER_FIELD_CHARS &&
		!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
	);
}

function isPeerRecord(value: unknown): value is PeerRecord {
	return (
		isRecord(value) &&
		isPeerText(value.id) &&
		isPeerText(value.name) &&
		isPeerText(value.address) &&
		(value.scope === "local" || value.scope === "network" || value.scope === "relay") &&
		(value.busy === undefined || typeof value.busy === "boolean") &&
		(value.verified === undefined || typeof value.verified === "boolean") &&
		(value.lastSeen === undefined || isPeerText(value.lastSeen))
	);
}

const SECRET_HEX = /^[0-9a-f]{64}$/;

function isMessageId(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_MESSAGE_ID_CHARS && MESSAGE_ID_PATTERN.test(value);
}

function isOptionalSecret(value: unknown): boolean {
	return value === undefined || (typeof value === "string" && SECRET_HEX.test(value));
}

/** A session proves it is a pi session by keying its id with the machine's session secret. */
function sessionProof(secret: string, peerId: string): string {
	return createHmac("sha256", secret).update(`pi-chat-session-v1:${peerId}`).digest("hex");
}

function secretsEqual(expected: string | undefined, presented: string | undefined): boolean {
	if (expected === undefined || presented === undefined) return false;
	const left = createHmac("sha256", "pi-chat-compare").update(expected).digest();
	const right = createHmac("sha256", "pi-chat-compare").update(presented).digest();
	return timingSafeEqual(left, right);
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
			// The broker assigns the scope, so a hello that omits it (older peers) is still a valid claim.
			return isRecord(value.peer) &&
				isPeerRecord({ scope: "local", ...value.peer }) &&
				(value.protocol === undefined || typeof value.protocol === "number") &&
				isOptionalSecret(value.credential) &&
				isOptionalSecret(value.proof)
				? (value as WireMessage)
				: undefined;
		case "registered":
			return typeof value.credential === "string" && SECRET_HEX.test(value.credential)
				? (value as WireMessage)
				: undefined;
		case "peers":
			return Array.isArray(value.peers) && value.peers.every(isPeerRecord) ? (value as WireMessage) : undefined;
		case "send":
			return isMessageId(value.id) &&
				isOptionalSecret(value.credential) &&
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
			return typeof value.id === "string" &&
				isOptionalSecret(value.credential) &&
				typeof value.target === "string" &&
				typeof value.status === "string"
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
		// An id is unique; a name or address is not. Two peers answering to one name never resolve to the first.
		const byId = peers.find((candidate) => candidate.id === trimmed);
		const matches = byId
			? [byId]
			: peers.filter((candidate) => candidate.name === trimmed || candidate.address === trimmed);
		if (matches.length === 0) throw new Error(`Unknown pi-chat peer target: ${trimmed}`);
		if (matches.length > 1) {
			throw new Error(
				`pi-chat target ${JSON.stringify(trimmed)} is ambiguous (${matches.map((match) => match.id).join(", ")}); address one peer by id.`,
			);
		}
		const peer = matches[0];
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
	private busy = false;
	private readonly stateRoot: string;
	private readonly socketPath?: string;
	/** The machine's session secret, when this process may hold it; without it the peer joins unverified. */
	private readonly sessionSecret?: string;
	/** The credential the broker issued this session; presented on every frame after hello. */
	private credential?: string;
	/** Broker side: the credential bound to each peer id, so the id cannot be re-claimed without it. */
	private readonly issuedCredentials = new Map<string, string>();
	/** Broker side: the freshest message each ordered peer pair exchanged, owning the reply-chain depth. */
	private readonly replyChains = new Map<string, { hops: number; at: number }>();
	private serverSeq = 0;
	/** Client side: a change to this peer's record is waiting for the registration reply before it is sent. */
	private helloDirty = false;
	/** Receiver side: messages already delivered, per sender and id, so a retried send is delivered once. */
	private readonly receivedMessages = new Map<string, Promise<IncomingOutcome>>();
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
		this.stateRoot = options.stateRoot;
		this.socketPath = getChatPlatformInfo(options.stateRoot).socketPath;
		this.sessionSecret = this.socketPath ? readChatSessionSecret(options.stateRoot) : undefined;
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
		this.pushHello();
	}

	/**
	 * A re-hello must carry the credential the broker issues on registration, so it waits until that frame (or,
	 * from a broker that never issues one, the first peers frame) arrived; the change is sent then.
	 */
	private pushHello(): void {
		const client = this.client;
		if (!client || client.destroyed) return;
		if (this.credential === undefined && !this.peersFrameSeen) {
			this.helloDirty = true;
			return;
		}
		this.helloDirty = false;
		writeWire(client, this.helloMessage());
	}

	/** Peers see this agent as busy while its own turn runs; the broker rebroadcasts the change. */
	setBusy(busy: boolean): void {
		if (this.busy === busy) return;
		this.busy = busy;
		this.self = { ...this.self, busy };
		this.pushHello();
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
		ensureChatStateDirs(this.stateRoot);
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
			const stopped: AgentSendResult = {
				id,
				targets: [
					{ target: "pi-chat", status: "offline", reply: "pi-chat mesh stopped before delivery completed." },
				],
			};
			for (const resolve of pending.resolvers) resolve(stopped);
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
		this.withdrawCredential();
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
		// A sender-supplied id makes a retry the same send: the receiver delivers it once.
		const id = input.messageId ?? randomUUID();
		const targetIds = targets.map((target) => target.id);
		return new Promise<AgentSendResult>((resolve) => {
			const inFlight = this.pendingClientSends.get(id);
			if (inFlight) {
				inFlight.resolvers.push(resolve);
				return;
			}
			const timer = setTimeout(() => {
				const pending = this.pendingClientSends.get(id);
				this.pendingClientSends.delete(id);
				const timedOut: AgentSendResult = {
					id,
					targets: targetIds.map((target) => ({ target, status: "timeout" })),
				};
				for (const settle of pending?.resolvers ?? [resolve]) settle(timedOut);
			}, input.timeoutMs);
			this.pendingClientSends.set(id, { resolvers: [resolve], timer });
			writeWire(client, {
				type: "send",
				credential: this.credential,
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
			busy: this.busy,
			lastSeen: new Date().toISOString(),
		};
	}

	private helloMessage(): Extract<WireMessage, { type: "hello" }> {
		return {
			type: "hello",
			peer: { ...this.self, lastSeen: new Date().toISOString() },
			protocol: CREDENTIAL_PROTOCOL,
			credential: this.credential,
			proof: this.sessionSecret ? sessionProof(this.sessionSecret, this.self.id) : undefined,
		};
	}

	/** The credential reaches pi's own child processes through the environment; tool commands never inherit it. */
	private adoptCredential(credential: string): void {
		this.credential = credential;
		process.env[CHAT_CREDENTIAL_ENV] = credential;
		process.env[CHAT_SESSION_ID_ENV] = this.self.id;
	}

	private withdrawCredential(): void {
		if (this.credential !== undefined && process.env[CHAT_CREDENTIAL_ENV] === this.credential) {
			delete process.env[CHAT_CREDENTIAL_ENV];
			delete process.env[CHAT_SESSION_ID_ENV];
		}
		this.credential = undefined;
	}

	/** True when something on the socket path answers (or is too slow to rule out): its path is never taken. */
	private brokerResponds(socketPath: string): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const probe = createConnection(socketPath);
			const done = (live: boolean) => {
				clearTimeout(timer);
				probe.destroy();
				resolve(live);
			};
			const timer = setTimeout(() => done(true), BROKER_PROBE_TIMEOUT_MS);
			timer.unref?.();
			probe.once("connect", () => done(true));
			probe.once("error", (error: NodeJS.ErrnoException) =>
				done(error.code !== "ECONNREFUSED" && error.code !== "ENOENT"),
			);
		});
	}

	/** False when a live broker already owns the path: this process then joins it as a client. */
	private async startBroker(): Promise<boolean> {
		const socketPath = this.socketPath;
		if (!socketPath) return false;
		// Only a socket proven dead is removed, and only the exact file that was probed: a broker that
		// bound the path in the meantime is a different file and is left alone.
		const observed = socketIdentity(socketPath);
		if (observed !== undefined) {
			if (await this.brokerResponds(socketPath)) return false;
			unlinkIfSameSocket(socketPath, observed);
		}
		const server = createServer((socket) => this.handleServerConnection(socket));
		this.server = server;
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => {
					server.off("listening", onListening);
					reject(error);
				};
				const onListening = () => {
					server.off("error", onError);
					this.serverSocketIdentity = socketIdentity(socketPath);
					// The state directory is 0700, which is the boundary; the socket itself is owner-only too.
					try {
						chmodSync(socketPath, 0o600);
					} catch {
						// Some filesystems have no socket modes.
					}
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onListening);
				server.listen(socketPath);
			});
		} catch (error) {
			// Another process bound the path first: it is the broker, and this one joins it.
			if (isNodeError(error) && error.code === "EADDRINUSE") {
				this.server = undefined;
				return false;
			}
			throw error;
		}
		return true;
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
				this.helloDirty = false;
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
		this.serverConnections.set(socket, { socket, seq: this.serverSeq++ });
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

	private refuse(socket: Socket, message: string): void {
		writeWire(socket, { type: "error", message });
		socket.end();
	}

	private handleServerMessage(socket: Socket, line: string): void {
		const message = parseWire(line);
		const connection = this.serverConnections.get(socket);
		if (!message || !connection) return;
		if (message.type === "hello") {
			this.handleHello(socket, connection, message);
			return;
		}
		if (message.type !== "send" && message.type !== "delivery_ack") return;
		if (!connection.peer) {
			if (message.type === "send") {
				writeWire(socket, {
					type: "error",
					id: message.id,
					message: "Sender is not registered with the pi-chat broker.",
				});
			}
			return;
		}
		// Every frame after hello proves the session: the credential the broker issued for this id. A legacy peer
		// holds none; it stays an unverified peer rather than being refused.
		if (!connection.legacy && !secretsEqual(connection.credential, message.credential)) {
			this.refuse(socket, "pi-chat credential rejected.");
			return;
		}
		if (message.type === "send") this.handleServerSend(socket, message);
		else this.handleDeliveryAck(socket, message);
	}

	/**
	 * The broker is the identity authority. A peer id is bound to the credential the broker issued for it: a
	 * live id is never reassigned, and a known id is only re-claimed with its credential. `verified` is the
	 * broker's own finding (a valid session proof), never the peer's claim, and the address is assigned here.
	 */
	private handleHello(
		socket: Socket,
		connection: ServerPeerConnection,
		message: Extract<WireMessage, { type: "hello" }>,
	) {
		const claimed = message.peer.id;
		const registering = connection.peer === undefined;
		const isHeldElsewhere = (id: string): boolean =>
			this.connectedPeers().some((entry) => entry.peer.id === id && entry.socket !== socket);
		if (registering) connection.legacy = (message.protocol ?? 0) < CREDENTIAL_PROTOCOL;
		// What the peer calls itself: a legacy peer keeps announcing its own id even when the broker had to give
		// it another one, so its later frames are matched against the claim, not the assigned id.
		const announced = connection.legacyClaim ?? connection.peer?.id;
		if (!registering && announced !== claimed) {
			this.refuse(socket, "pi-chat peer id is already in use on this broker.");
			return;
		}
		let peerId = connection.peer?.id ?? claimed;
		// An id the broker issued a credential for, whether or not its holder is connected now: only that
		// holder's credential re-claims it. A legacy peer has none.
		const isCredentialBound = (id: string): boolean => this.issuedCredentials.has(id);
		if (registering && !connection.legacy && isHeldElsewhere(claimed)) {
			this.refuse(socket, "pi-chat peer id is already in use on this broker.");
			return;
		}
		if (registering && connection.legacy && (isHeldElsewhere(claimed) || isCredentialBound(claimed))) {
			// Older clients (and the user-level extension) share one stored id across every session on the
			// machine. Each is still a distinct, unverified peer: the broker assigns the id it routes by, and the
			// connection, not the id a legacy peer announces, identifies it. This holds for an id another live
			// peer holds and for one bound to a credential whose holder is disconnected: the legacy peer is
			// routed under a suffix instead of being refused or taking over the verified identity.
			for (let n = 2; ; n++) {
				const suffix = `~${n}`;
				const candidate = `${claimed.slice(0, MAX_PEER_FIELD_CHARS - suffix.length)}${suffix}`;
				if (!isHeldElsewhere(candidate) && !isCredentialBound(candidate)) {
					peerId = candidate;
					connection.legacyClaim = claimed;
					break;
				}
			}
		}
		const known = this.issuedCredentials.get(peerId);
		if (registering) {
			// A known id is re-claimed only with its credential (a legacy peer has none and was routed under a
			// suffix above, never reaching this refusal); an unknown id is issued one, or adopts the one a
			// session presents after a broker restart (the broker that issued it is gone). A legacy peer is
			// registered without a credential, as an unverified peer.
			if (known !== undefined && !secretsEqual(known, message.credential)) {
				this.refuse(socket, "pi-chat peer id is bound to another credential.");
				return;
			}
			if (!connection.legacy) {
				connection.credential = known ?? message.credential ?? randomBytes(32).toString("hex");
				this.issuedCredentials.delete(peerId);
				this.issuedCredentials.set(peerId, connection.credential);
				while (this.issuedCredentials.size > MAX_BROKER_CREDENTIALS) {
					const oldest = this.issuedCredentials.keys().next().value;
					if (oldest === undefined) break;
					this.issuedCredentials.delete(oldest);
				}
			}
		} else if (!connection.legacy && !secretsEqual(connection.credential, message.credential)) {
			this.refuse(socket, "pi-chat credential rejected.");
			return;
		}
		const secret = this.sessionSecret;
		connection.peer = {
			id: peerId,
			name: message.peer.name,
			address: `local:${peerId}`,
			scope: "local",
			verified:
				!connection.legacy && secret !== undefined && secretsEqual(sessionProof(secret, peerId), message.proof),
			busy: message.peer.busy === true,
			lastSeen: new Date().toISOString(),
		};
		if (registering && connection.credential)
			writeWire(socket, { type: "registered", credential: connection.credential });
		this.broadcastPeerList();
	}

	private handleServerSend(senderSocket: Socket, message: Extract<WireMessage, { type: "send" }>): void {
		const connected = this.connectedPeers();
		const sender = connected.find((entry) => entry.socket === senderSocket)?.peer;
		if (!sender) return;
		const now = Date.now();
		const key = `${sender.id}\0${message.id}`;
		// A retried send (same sender, same id) joins the one in flight instead of replacing it.
		const inFlight = this.pendingServerSends.get(key);
		const results: DeliveryTarget[] = inFlight?.results ?? [];
		const waiting = inFlight?.waiting ?? new Set<string>();
		for (const targetId of message.to) {
			if (inFlight && !waiting.has(targetId)) continue;
			const target = connected.find((entry) => entry.peer.id === targetId);
			if (!target) {
				results.push({ target: targetId, status: "offline" });
				continue;
			}
			// The broker owns the reply-chain depth: one past the freshest chain the target started toward the
			// sender, whatever the sender claims in its metadata.
			const inbound = this.replyChains.get(`${targetId}>${sender.id}`);
			const hops = inbound && now - inbound.at <= REPLY_CHAIN_WINDOW_MS ? inbound.hops + 1 : 1;
			if (hops > MAX_REPLY_HOPS) {
				results.push({
					target: targetId,
					status: "denied",
					reply: `pi-chat reply chain reached ${MAX_REPLY_HOPS} hops; the owner must continue it.`,
				});
				continue;
			}
			const chainKey = `${sender.id}>${targetId}`;
			this.replyChains.delete(chainKey);
			this.replyChains.set(chainKey, { hops, at: now });
			while (this.replyChains.size > MAX_BROKER_CHAINS) {
				const oldest = this.replyChains.keys().next().value;
				if (oldest === undefined) break;
				this.replyChains.delete(oldest);
			}
			waiting.add(targetId);
			writeWire(target.socket, {
				type: "incoming",
				id: message.id,
				from: sender,
				to: targetId,
				message: message.message,
				expectReply: message.expectReply,
				metadata: { ...message.metadata, hops },
			});
		}
		if (inFlight) {
			clearTimeout(inFlight.timer);
			inFlight.sender = senderSocket;
		}
		if (waiting.size === 0) {
			this.pendingServerSends.delete(key);
			writeWire(senderSocket, { type: "send_result", id: message.id, targets: results });
			return;
		}
		const timer = setTimeout(
			() => {
				const pending = this.pendingServerSends.get(key);
				if (!pending) return;
				for (const target of pending.waiting) pending.results.push({ target, status: "timeout" });
				this.pendingServerSends.delete(key);
				writeWire(pending.sender, { type: "send_result", id: message.id, targets: pending.results });
			},
			Math.min(MAX_TIMEOUT_MS, Math.max(1, message.timeoutMs)),
		);
		if (inFlight) inFlight.timer = timer;
		else
			this.pendingServerSends.set(key, {
				messageId: message.id,
				sender: senderSocket,
				results,
				waiting,
				timer,
			});
	}

	private handleDeliveryAck(socket: Socket, message: Extract<WireMessage, { type: "delivery_ack" }>): void {
		// An acknowledgement is only the acknowledging peer's own: the broker never takes another's word for it.
		const ackerConnection = this.serverConnections.get(socket);
		const acker = ackerConnection?.peer;
		// A legacy peer acknowledges with the id it announced, which may differ from the id assigned to it.
		if (!acker || message.target !== (ackerConnection?.legacyClaim ?? acker.id)) return;
		for (const [key, pending] of this.pendingServerSends) {
			if (pending.messageId !== message.id || !pending.waiting.has(acker.id)) continue;
			pending.waiting.delete(acker.id);
			pending.results.push({ target: acker.id, status: message.status, reply: message.reply });
			if (pending.waiting.size === 0) {
				clearTimeout(pending.timer);
				this.pendingServerSends.delete(key);
				writeWire(pending.sender, { type: "send_result", id: message.id, targets: pending.results });
			}
			return;
		}
	}

	private broadcastPeerList(): void {
		const connected = this.connectedPeers();
		const peers = connected.map((entry) => entry.peer);
		for (const entry of connected) writeWire(entry.socket, { type: "peers", peers });
	}

	/**
	 * Registered peers with the names peers see. A name two peers declare is held by its earliest verified
	 * holder (else its earliest holder); every other peer gets a short id suffix. Derived from the current
	 * registrations each time, so a repeated hello never changes a name by itself.
	 */
	private connectedPeers(): Array<{ socket: Socket; peer: PeerRecord }> {
		const live: Array<{ connection: ServerPeerConnection; peer: PeerRecord }> = [];
		for (const connection of this.serverConnections.values()) {
			if (connection.peer && !connection.socket.destroyed) live.push({ connection, peer: connection.peer });
		}
		const byName = new Map<string, typeof live>();
		for (const entry of live) byName.set(entry.peer.name, [...(byName.get(entry.peer.name) ?? []), entry]);
		const taken = new Set(byName.keys());
		const names = new Map<string, string>();
		for (const [name, holders] of byName) {
			const ranked = [...holders].sort(
				(a, b) =>
					Number(b.peer.verified === true) - Number(a.peer.verified === true) ||
					a.connection.seq - b.connection.seq,
			);
			for (const entry of ranked.slice(1)) {
				const alnum = entry.peer.id.replace(/[^0-9A-Za-z]/g, "");
				for (let tail = 4; ; tail += 4) {
					const suffix = `-${alnum.slice(-tail)}`;
					const candidate = `${name.slice(0, MAX_PEER_FIELD_CHARS - suffix.length)}${suffix}`;
					if (!taken.has(candidate) || tail >= alnum.length) {
						taken.add(candidate);
						names.set(entry.peer.id, candidate);
						break;
					}
				}
			}
		}
		return live.map(({ connection, peer }) => ({
			socket: connection.socket,
			peer: { ...peer, name: names.get(peer.id) ?? peer.name },
		}));
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
			if (this.helloDirty) this.pushHello();
			return;
		}
		if (message.type === "registered") {
			this.adoptCredential(message.credential);
			if (this.helloDirty) this.pushHello();
			return;
		}
		if (message.type === "incoming") {
			// A retried send carries the same sender and id: it is delivered once, and every copy is acknowledged.
			const key = `${message.from.id}\0${message.id}`;
			let delivery = this.receivedMessages.get(key);
			if (delivery) {
				this.receivedMessages.delete(key);
			} else {
				delivery = Promise.resolve(
					this.onIncoming?.({
						id: message.id,
						from: message.from,
						to: message.to,
						message: message.message,
						expectReply: message.expectReply,
						metadata: message.metadata,
					}),
				).then(
					(reply): IncomingOutcome => ({ failed: false, reply }),
					(error: unknown): IncomingOutcome => ({
						failed: true,
						reply: error instanceof Error ? error.message : String(error),
					}),
				);
			}
			this.receivedMessages.set(key, delivery);
			while (this.receivedMessages.size > MAX_REMEMBERED_MESSAGES) {
				const oldest = this.receivedMessages.keys().next().value;
				if (oldest === undefined) break;
				this.receivedMessages.delete(oldest);
			}
			const outcome = await delivery;
			if (this.client && !this.client.destroyed) {
				writeWire(this.client, {
					type: "delivery_ack",
					credential: this.credential,
					id: message.id,
					target: this.self.id,
					// A message the session could not accept is reported as failed, never as received.
					status: outcome.failed ? "failed" : "received",
					reply: outcome.failed
						? outcome.reply
						: message.expectReply
							? outcome.reply || `ACK: received by ${this.self.name}`
							: undefined,
				});
			}
			return;
		}
		if (message.type === "send_result") {
			const pending = this.pendingClientSends.get(message.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.pendingClientSends.delete(message.id);
			for (const resolve of pending.resolvers) resolve({ id: message.id, targets: message.targets });
		}
	}
}
