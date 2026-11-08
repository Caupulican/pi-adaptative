/**
 * The listening side of the link: one session per agent directory hosts it (`host-lock.ts`). A machine joins under a
 * name the owner added here with a secret only the two of them hold; the hub tells the session when a machine arrives,
 * leaves or answers, and sends it messages. Joined machines are kept by the id their own install generated, so two
 * machines that share a hostname never take each other's place; the name is the label the owner gave.
 */

import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { type HubMachineLinkState, reportHubMachines } from "./link-context.ts";
import {
	commonFeatures,
	encodeFrame,
	hubFeatureProof,
	hubProof,
	joinProof,
	LINK_PROTOCOL_VERSION,
	LineBuffer,
	type LinkFrame,
	type LinkInnerFrame,
	type LinkRefusal,
	MAX_LINK_DEPTH,
	MAX_MESSAGE_CHARS,
	newNonce,
	parseFrame,
	proofsMatch,
} from "./protocol.ts";
import { listHubMachines, loadLinkSettings, type MachineIdentity, nameBoundTo, updateHubMachine } from "./registry.ts";
import { LINK_FEATURES, LinkFraming, SEALED_FEATURE, SealedLink } from "./session-keys.ts";

const HANDSHAKE_MS = 10_000;
const PING_EVERY_MS = 20_000;
const SILENCE_MS = 60_000;
const MAX_QUEUED_BYTES = 1024 * 1024;

export interface RemoteHubEvents {
	/** A machine's answer to a message this hub sent; `machine` is its name, `id` the message's id. */
	reply(machine: string, id: string, text: string): void;
	/** A machine arrived (true) or left (false), by name. */
	presence(machine: string, connected: boolean): void;
}

interface Live {
	readonly socket: Socket;
	readonly machineId: string;
	/** The name the owner gave the machine here: its bot's id and its label. */
	readonly name: string;
	readonly subtree: readonly string[];
	readonly depth: number;
	readonly features: readonly string[];
	readonly framing: LinkFraming;
	lastSeen: number;
}

export class RemoteHub {
	private readonly agentDir: string;
	private readonly identity: MachineIdentity;
	private readonly events: RemoteHubEvents;
	private readonly onUp: () => readonly string[];
	private server: Server | undefined;
	/** Joined machines by install id. */
	private readonly live = new Map<string, Live>();
	private ticker: ReturnType<typeof setInterval> | undefined;
	private recordsWatcher: FSWatcher | undefined;

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
				this.watchRecords();
				const address = server.address();
				this.report();
				resolve(typeof address === "object" && address ? address.port : port);
			});
		});
	}

	async close(): Promise<void> {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
		this.recordsWatcher?.close();
		this.recordsWatcher = undefined;
		for (const [machineId, entry] of this.live) {
			entry.socket.destroy();
			this.live.delete(machineId);
		}
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			this.report();
		}
	}

	private byName(name: string): Live | undefined {
		for (const entry of this.live.values()) if (entry.name === name) return entry;
		return undefined;
	}

	isConnected(name: string): boolean {
		return this.byName(name) !== undefined;
	}

	/** Whether the link to a joined machine is sealed. */
	isSealed(name: string): boolean {
		return this.byName(name)?.framing.isSealed === true;
	}

	connected(): string[] {
		return [...this.live.values()].map((entry) => entry.name);
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
		const entry = this.byName(name);
		if (!entry) throw new Error(`${name} is not connected.`);
		if (text.length === 0 || text.length > MAX_MESSAGE_CHARS)
			throw new Error(`A message to ${name} is 1 to ${MAX_MESSAGE_CHARS} characters.`);
		if (entry.socket.writableLength > MAX_QUEUED_BYTES)
			throw new Error(`${name} is not keeping up; try again later.`);
		const id = randomUUID();
		if (!this.write(entry, { t: "msg", id, text }))
			throw new Error(`The message to ${name} is too long for the link once encoded; send it in parts.`);
		return id;
	}

	/** Cuts a machine's connection now (a revoke). */
	disconnect(name: string): void {
		this.byName(name)?.socket.destroy();
	}

	/**
	 * Cuts a joined machine whose record was revoked, removed or bound to another install, whichever session changed
	 * `machines.json`: the hosting session holds the connections, the owner may revoke from any session.
	 */
	private watchRecords(): void {
		try {
			this.recordsWatcher = watch(join(this.agentDir, "remote"), { persistent: false }, (_event, filename) => {
				if (filename !== null && filename.toString() !== "machines.json") return;
				const records = listHubMachines(this.agentDir);
				for (const entry of this.live.values()) {
					const record = records.find((machine) => machine.name === entry.name);
					if (
						!record ||
						record.revoked ||
						(record.machineId !== undefined && record.machineId !== entry.machineId)
					)
						entry.socket.destroy();
				}
			});
			this.recordsWatcher.on("error", () => {
				this.recordsWatcher?.close();
				this.recordsWatcher = undefined;
			});
		} catch (error) {
			harnessLog.warn(
				"link",
				"the hub cannot watch its machine records; a revoke from another session cuts at reconnect",
				{
					reason: error instanceof Error ? error.name : "unknown",
				},
			);
		}
	}

	/** Writes one frame the way the link to `entry` was negotiated; false when it would pass the frame bound. */
	private write(entry: Live, frame: LinkInnerFrame): boolean {
		const line = entry.framing.encode(frame);
		if (line === undefined) return false;
		entry.socket.write(line);
		return true;
	}

	private tick(): void {
		const now = Date.now();
		for (const entry of this.live.values()) {
			if (now - entry.lastSeen > SILENCE_MS) entry.socket.destroy();
			else this.write(entry, { t: "ping" });
		}
	}

	private accept(socket: Socket): void {
		socket.setEncoding("utf8");
		socket.setNoDelay(true);
		const lines = new LineBuffer();
		const nonce = newNonce();
		let entry: Live | undefined;
		const timer = setTimeout(() => {
			if (!entry) socket.destroy();
		}, HANDSHAKE_MS);
		const refuse = (reason: LinkRefusal, machine?: string): void => {
			harnessLog.warn("link", "a machine was refused", { reason, machine });
			socket.end(encodeFrame({ t: "refuse", reason }));
		};
		socket.on("error", () => {});
		socket.on("close", () => {
			clearTimeout(timer);
			if (entry !== undefined && this.live.get(entry.machineId)?.socket === socket) {
				this.live.delete(entry.machineId);
				this.report();
				this.events.presence(entry.name, false);
			}
		});
		socket.write(
			encodeFrame({
				t: "challenge",
				proto: LINK_PROTOCOL_VERSION,
				nonce,
				hubId: this.identity.machineId,
				hubName: this.identity.name,
				features: LINK_FEATURES,
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
				if (!entry) {
					if (frame?.t !== "hello") return refuse("protocol");
					const joined = this.handshake(frame, nonce, socket);
					if (typeof joined === "string") return refuse(joined, frame.name);
					entry = joined;
					clearTimeout(timer);
					this.admit(joined);
					continue;
				}
				if (this.live.get(entry.machineId)?.socket !== socket) return;
				const inner = frame ? entry.framing.decode(frame) : "inner";
				if (typeof inner === "string") {
					// Category and label only: nothing of the frame, the keys or the secret is logged.
					harnessLog.warn("link", "a frame from a joined machine was refused; the connection was closed", {
						machine: entry.name,
						reason: inner,
						sealed: entry.framing.isSealed,
					});
					socket.destroy();
					return;
				}
				entry.lastSeen = Date.now();
				if (inner.t === "reply") this.events.reply(entry.name, inner.id, inner.text);
				else if (inner.t === "ping") this.write(entry, { t: "pong" });
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
		// One install is one machine here: a second name for it would make two bots fight over one connection.
		if (nameBoundTo(this.agentDir, hello.machineId, record.name) !== undefined) return "machine_taken";
		if (hello.machineId === this.identity.machineId || hello.subtree.includes(this.identity.machineId))
			return "would_loop";
		if (hello.depth + 1 > MAX_LINK_DEPTH) return "too_deep";
		const active = hello.features ? commonFeatures(LINK_FEATURES, hello.features) : [];
		const sealed = active.includes(SEALED_FEATURE);
		// "protocol" is a refusal every build can read, so a machine on an older build still says why.
		if (!sealed && loadLinkSettings(this.agentDir).requireSealed) return "protocol";
		if (record.machineId === undefined) updateHubMachine(this.agentDir, record.name, { machineId: hello.machineId });
		socket.write(
			encodeFrame(
				hello.features
					? {
							t: "welcome",
							proof: hubFeatureProof(record.secret, hello.nonce, this.identity.machineId, active),
							features: active,
						}
					: { t: "welcome", proof: hubProof(record.secret, hello.nonce, this.identity.machineId) },
			),
		);
		const framing = new LinkFraming(
			sealed
				? new SealedLink(
						{
							secret: record.secret,
							hubNonce: nonce,
							joinerNonce: hello.nonce,
							hubId: this.identity.machineId,
							machineId: hello.machineId,
							hubFeatures: LINK_FEATURES,
							joinerFeatures: hello.features ?? [],
						},
						"hub",
					)
				: undefined,
		);
		return {
			socket,
			machineId: hello.machineId,
			name: record.name,
			subtree: hello.subtree,
			depth: hello.depth,
			features: active,
			framing,
			lastSeen: Date.now(),
		};
	}

	private admit(entry: Live): void {
		harnessLog.info("link", "a machine joined this hub", {
			machine: entry.name,
			depth: entry.depth,
			sealed: entry.framing.isSealed,
		});
		this.live.get(entry.machineId)?.socket.destroy();
		this.live.set(entry.machineId, entry);
		this.report();
		this.events.presence(entry.name, true);
	}

	/** Writes the joined machines, by install id, where the owner's status and other sessions read them. */
	private report(): void {
		const machines: Record<string, HubMachineLinkState> = {};
		for (const entry of this.live.values())
			machines[entry.machineId] = {
				name: entry.name,
				connected: true,
				features: entry.features,
				subtree: entry.subtree,
				depth: entry.depth,
			};
		reportHubMachines(this.agentDir, machines);
	}

	/** What this hub reports upward: the ids of its joiners (see the constructor). */
	upSubtree(): readonly string[] {
		return [...this.onUp(), ...this.reachableIds()];
	}
}
