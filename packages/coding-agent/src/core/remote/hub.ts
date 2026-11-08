/**
 * The listening side of the link: any session can host it. A machine joins under a name the owner added here with a secret
 * only the two of them hold; the hub tells the session when a machine arrives, leaves or answers, and sends it messages.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { harnessLog } from "../../kernel/harness-log.ts";
import {
	encodeFrame,
	hubProof,
	joinProof,
	LINK_PROTOCOL_VERSION,
	LineBuffer,
	type LinkFrame,
	type LinkRefusal,
	MAX_LINK_DEPTH,
	MAX_MESSAGE_CHARS,
	newNonce,
	parseFrame,
	proofsMatch,
} from "./protocol.ts";
import { listHubMachines, type MachineIdentity, updateHubMachine } from "./registry.ts";

const HANDSHAKE_MS = 10_000;
const PING_EVERY_MS = 20_000;
const SILENCE_MS = 60_000;
const MAX_QUEUED_BYTES = 1024 * 1024;

export interface RemoteHubEvents {
	/** A machine's answer to a message this hub sent; `id` is the message's id. */
	reply(machine: string, id: string, text: string): void;
	/** A machine arrived (true) or left (false). */
	presence(machine: string, connected: boolean): void;
}

interface Live {
	readonly socket: Socket;
	readonly machineId: string;
	readonly subtree: readonly string[];
	readonly depth: number;
	lastSeen: number;
}

export class RemoteHub {
	private readonly agentDir: string;
	private readonly identity: MachineIdentity;
	private readonly events: RemoteHubEvents;
	private readonly onUp: () => readonly string[];
	private server: Server | undefined;
	private readonly live = new Map<string, Live>();
	private ticker: ReturnType<typeof setInterval> | undefined;

	/** `upSubtree` is what this machine reports to a hub it joined itself: its own joiners' ids, for loop detection. */
	constructor(options: {
		agentDir: string;
		identity: MachineIdentity;
		events: RemoteHubEvents;
		upSubtree?: () => readonly string[];
	}) {
		this.agentDir = options.agentDir;
		this.identity = options.identity;
		this.events = options.events;
		this.onUp = options.upSubtree ?? (() => []);
	}

	listen(host: string, port: number): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = createServer((socket) => this.accept(socket));
			server.once("error", reject);
			server.listen(port, host, () => {
				server.off("error", reject);
				server.on("error", () => {});
				this.server = server;
				this.ticker = setInterval(() => this.tick(), PING_EVERY_MS);
				this.ticker.unref();
				const address = server.address();
				resolve(typeof address === "object" && address ? address.port : port);
			});
		});
	}

	async close(): Promise<void> {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
		for (const [name, entry] of this.live) {
			entry.socket.destroy();
			this.live.delete(name);
		}
		const server = this.server;
		this.server = undefined;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	isConnected(name: string): boolean {
		return this.live.has(name);
	}

	connected(): string[] {
		return [...this.live.keys()];
	}

	/** The ids of the machines joined here, with theirs, for a hub above this one to check for a loop. */
	reachableIds(): string[] {
		return [...this.live.values()].flatMap((entry) => [entry.machineId, ...entry.subtree]);
	}

	/** How many hubs deep the chain below this one goes: 0 with no machine joined. */
	chainDepth(): number {
		return this.live.size === 0 ? 0 : 1 + Math.max(...[...this.live.values()].map((entry) => entry.depth));
	}

	/** Sends one message to a joined machine and returns its id; throws when the machine is not here. */
	send(name: string, text: string): string {
		const entry = this.live.get(name);
		if (!entry) throw new Error(`${name} is not connected.`);
		if (text.length === 0 || text.length > MAX_MESSAGE_CHARS)
			throw new Error(`A message to ${name} is 1 to ${MAX_MESSAGE_CHARS} characters.`);
		if (entry.socket.writableLength > MAX_QUEUED_BYTES)
			throw new Error(`${name} is not keeping up; try again later.`);
		const id = randomUUID();
		entry.socket.write(encodeFrame({ t: "msg", id, text }));
		return id;
	}

	/** Cuts a machine's connection now (a revoke). */
	disconnect(name: string): void {
		this.live.get(name)?.socket.destroy();
	}

	private tick(): void {
		const now = Date.now();
		for (const entry of this.live.values()) {
			if (now - entry.lastSeen > SILENCE_MS) entry.socket.destroy();
			else entry.socket.write(encodeFrame({ t: "ping" }));
		}
	}

	private accept(socket: Socket): void {
		socket.setEncoding("utf8");
		socket.setNoDelay(true);
		const lines = new LineBuffer();
		const nonce = newNonce();
		let name: string | undefined;
		let welcomed = false;
		const timer = setTimeout(() => {
			if (!welcomed) socket.destroy();
		}, HANDSHAKE_MS);
		const refuse = (reason: LinkRefusal): void => {
			harnessLog.warn("link", "a machine was refused", { reason, machine: name });
			socket.end(encodeFrame({ t: "refuse", reason }));
		};
		socket.on("error", () => {});
		socket.on("close", () => {
			clearTimeout(timer);
			if (name !== undefined && this.live.get(name)?.socket === socket) {
				this.live.delete(name);
				this.events.presence(name, false);
			}
		});
		socket.write(
			encodeFrame({
				t: "challenge",
				proto: LINK_PROTOCOL_VERSION,
				nonce,
				hubId: this.identity.machineId,
				hubName: this.identity.name,
			}),
		);
		socket.on("data", (chunk: string) => {
			const received = lines.push(chunk);
			if (!received) {
				socket.destroy();
				return;
			}
			for (const line of received) {
				const frame = parseFrame(line);
				if (!frame) {
					if (!welcomed) refuse("protocol");
					else socket.destroy();
					return;
				}
				if (!welcomed) {
					if (frame.t !== "hello") return refuse("protocol");
					const joined = this.handshake(frame, nonce, socket);
					if (typeof joined === "string") return refuse(joined);
					name = frame.name;
					welcomed = true;
					clearTimeout(timer);
					this.admit(frame.name, joined);
					continue;
				}
				const entry = name === undefined ? undefined : this.live.get(name);
				if (!entry || entry.socket !== socket) return;
				entry.lastSeen = Date.now();
				if (frame.t === "reply" && name !== undefined) this.events.reply(name, frame.id, frame.text);
				else if (frame.t === "ping") socket.write(encodeFrame({ t: "pong" }));
			}
		});
	}

	/** The joined machine's entry once the hello proves the secret and passes the loop and binding checks; otherwise why not. */
	private handshake(hello: Extract<LinkFrame, { t: "hello" }>, nonce: string, socket: Socket): Live | LinkRefusal {
		const record = listHubMachines(this.agentDir).find((machine) => machine.name === hello.name);
		if (!record) return "unknown_machine";
		const expected = joinProof(record.secret, nonce, hello.machineId, hello.name, hello.nonce);
		if (!proofsMatch(expected, hello.proof)) return "bad_proof";
		if (record.revoked) return "revoked";
		if (record.machineId !== undefined && record.machineId !== hello.machineId) return "machine_changed";
		if (hello.machineId === this.identity.machineId || hello.subtree.includes(this.identity.machineId))
			return "would_loop";
		if (hello.depth + 1 > MAX_LINK_DEPTH) return "too_deep";
		if (record.machineId === undefined) updateHubMachine(this.agentDir, record.name, { machineId: hello.machineId });
		socket.write(encodeFrame({ t: "welcome", proof: hubProof(record.secret, hello.nonce, this.identity.machineId) }));
		return { socket, machineId: hello.machineId, subtree: hello.subtree, depth: hello.depth, lastSeen: Date.now() };
	}

	private admit(name: string, entry: Live): void {
		harnessLog.info("link", "a machine joined this hub", { machine: name, depth: entry.depth });
		this.live.get(name)?.socket.destroy();
		this.live.set(name, entry);
		this.events.presence(name, true);
	}

	/** What this hub reports upward: the ids of its joiners (see the constructor). */
	upSubtree(): readonly string[] {
		return [...this.onUp(), ...this.reachableIds()];
	}
}
