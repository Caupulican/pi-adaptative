/**
 * The joining side of the link: one connection to one hub, kept up with backoff. It proves the shared secret, checks
 * the hub proves it back, then hands the hub's messages to the session and sends the session's answers.
 */

import { createConnection, type Socket } from "node:net";
import { harnessLog } from "../../kernel/harness-log.ts";
import {
	encodeFrame,
	hubProof,
	joinProof,
	LineBuffer,
	type LinkRefusal,
	MAX_LINK_DEPTH,
	newNonce,
	parseFrame,
	proofsMatch,
	REFUSAL_TEXT,
} from "./protocol.ts";
import { type JoinRecord, type MachineIdentity, parseAddress } from "./registry.ts";

const HANDSHAKE_MS = 10_000;
const SILENCE_MS = 60_000;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60_000;

export type LinkState =
	| { readonly state: "connected"; readonly hubName: string; readonly hubId: string }
	| { readonly state: "waiting"; readonly reason: string };

export interface LinkClientEvents {
	state(state: LinkState): void;
	/** A message from the hub; `id` is what the answer must carry. */
	message(hubId: string, hubName: string, id: string, text: string): void;
}

export class LinkClient {
	private readonly join: JoinRecord;
	private readonly identity: MachineIdentity;
	private readonly events: LinkClientEvents;
	private readonly subtree: () => readonly string[];
	private readonly depth: () => number;
	private socket: Socket | undefined;
	private stopped = false;
	private attempt = 0;
	private retry: ReturnType<typeof setTimeout> | undefined;
	private hub: { id: string; name: string } | undefined;

	constructor(options: {
		join: JoinRecord;
		identity: MachineIdentity;
		events: LinkClientEvents;
		/** The ids of the machines joined to this one, reported to the hub so it can refuse a loop. */
		subtree?: () => readonly string[];
		depth?: () => number;
	}) {
		this.join = options.join;
		this.identity = options.identity;
		this.events = options.events;
		this.subtree = options.subtree ?? (() => []);
		this.depth = options.depth ?? (() => 0);
	}

	get address(): string {
		return this.join.address;
	}

	start(): void {
		this.stopped = false;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		if (this.retry) clearTimeout(this.retry);
		this.retry = undefined;
		this.socket?.destroy();
		this.socket = undefined;
	}

	/** Answers a hub message; false when the connection is gone (the answer is lost, never queued). */
	reply(id: string, text: string): boolean {
		const socket = this.socket;
		if (!socket || !this.hub || socket.destroyed) return false;
		socket.write(encodeFrame({ t: "reply", id, text }));
		return true;
	}

	private wait(reason: string, permanent = false): void {
		harnessLog.info("link", "the link is waiting", {
			address: this.join.address,
			reason,
			permanent,
			attempt: this.attempt,
		});
		this.hub = undefined;
		this.events.state({ state: "waiting", reason });
		if (this.stopped || permanent) return;
		this.attempt++;
		const step = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(this.attempt - 1, 10));
		this.retry = setTimeout(() => this.connect(), Math.round(step / 2 + Math.random() * (step / 2)));
		this.retry.unref();
	}

	private connect(): void {
		const address = parseAddress(this.join.address);
		if (!address) {
			this.wait("the hub address is not host:port", true);
			return;
		}
		const socket = createConnection({ host: address.host, port: address.port });
		this.socket = socket;
		socket.setEncoding("utf8");
		socket.setNoDelay(true);
		const lines = new LineBuffer();
		let ownNonce = "";
		let welcomed = false;
		let lastSeen = Date.now();
		const handshake = setTimeout(() => {
			if (!welcomed) socket.destroy();
		}, HANDSHAKE_MS);
		const watchdog = setInterval(() => {
			if (welcomed && Date.now() - lastSeen > SILENCE_MS) socket.destroy();
		}, 10_000);
		watchdog.unref();
		let refusal: LinkRefusal | undefined;
		socket.on("error", () => {});
		socket.on("close", () => {
			clearTimeout(handshake);
			clearInterval(watchdog);
			if (this.socket === socket) this.socket = undefined;
			if (this.stopped) return;
			// A refusal that retrying cannot change waits for the owner; a lost connection is retried.
			if (
				refusal === "unknown_machine" ||
				refusal === "bad_proof" ||
				refusal === "revoked" ||
				refusal === "would_loop"
			)
				this.wait(REFUSAL_TEXT[refusal], true);
			else
				this.wait(
					refusal
						? REFUSAL_TEXT[refusal]
						: welcomed
							? "the connection to the hub was lost"
							: "the hub could not be reached",
				);
		});
		socket.on("data", (chunk: string) => {
			lastSeen = Date.now();
			const received = lines.push(chunk);
			if (!received) {
				socket.destroy();
				return;
			}
			for (const line of received) {
				const frame = parseFrame(line);
				if (!frame) {
					socket.destroy();
					return;
				}
				switch (frame.t) {
					case "challenge": {
						if (frame.hubId === this.identity.machineId) {
							refusal = "would_loop";
							socket.destroy();
							return;
						}
						ownNonce = newNonce();
						this.hub = { id: frame.hubId, name: frame.hubName };
						const depth = this.depth();
						if (depth + 1 > MAX_LINK_DEPTH) {
							refusal = "too_deep";
							socket.destroy();
							return;
						}
						socket.write(
							encodeFrame({
								t: "hello",
								machineId: this.identity.machineId,
								name: this.join.name,
								nonce: ownNonce,
								proof: joinProof(
									this.join.secret,
									frame.nonce,
									this.identity.machineId,
									this.join.name,
									ownNonce,
								),
								subtree: this.subtree(),
								depth,
							}),
						);
						break;
					}
					case "welcome": {
						if (!this.hub || !proofsMatch(hubProof(this.join.secret, ownNonce, this.hub.id), frame.proof)) {
							refusal = "bad_proof";
							socket.destroy();
							return;
						}
						welcomed = true;
						this.attempt = 0;
						clearTimeout(handshake);
						harnessLog.info("link", "joined a hub", { address: this.join.address, hub: this.hub.name });
						this.events.state({ state: "connected", hubName: this.hub.name, hubId: this.hub.id });
						break;
					}
					case "refuse":
						refusal = frame.reason;
						socket.destroy();
						return;
					case "msg":
						if (welcomed && this.hub) this.events.message(this.hub.id, this.hub.name, frame.id, frame.text);
						break;
					case "ping":
						socket.write(encodeFrame({ t: "pong" }));
						break;
					default:
						break;
				}
			}
		});
	}
}
