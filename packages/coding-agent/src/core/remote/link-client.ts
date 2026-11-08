/**
 * The joining side of the link: one connection to one hub, kept up with backoff. It proves the shared secret, checks
 * the hub proves it back, then hands the hub's messages to the session and sends the session's answers, sealed when
 * the hub offered and confirmed `sealed/1` (`session-keys.ts`), plain with a hub on the first version of the link.
 */

import { createConnection, type Socket } from "node:net";
import { harnessLog } from "../../kernel/harness-log.ts";
import {
	commonFeatures,
	encodeFrame,
	hubFeatureProof,
	hubProof,
	joinProof,
	LineBuffer,
	type LinkFrame,
	type LinkInnerFrame,
	type LinkRefusal,
	MAX_LINK_DEPTH,
	newNonce,
	parseFrame,
	proofsMatch,
	REFUSAL_TEXT,
} from "./protocol.ts";
import { type JoinRecord, type MachineIdentity, parseAddress } from "./registry.ts";
import { LINK_FEATURES, LinkFraming, SEALED_FEATURE, SealedLink } from "./session-keys.ts";

const HANDSHAKE_MS = 10_000;
const SILENCE_MS = 60_000;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 60_000;

export type LinkState =
	| {
			readonly state: "connected";
			readonly hubName: string;
			readonly hubId: string;
			/** The features active on this connection: `sealed/1` when it is sealed, empty with an older hub. */
			readonly features: readonly string[];
	  }
	| { readonly state: "waiting"; readonly reason: string };

/** Why a connection closed, in the owner's words, and whether retrying can change it. */
interface CloseReason {
	readonly text: string;
	readonly permanent: boolean;
}

/** Refusals that retrying cannot change: they wait for the owner. */
const PERMANENT_REFUSALS: ReadonlySet<LinkRefusal> = new Set([
	"unknown_machine",
	"bad_proof",
	"revoked",
	"would_loop",
	"machine_taken",
]);

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
	private readonly requireSealed: () => boolean;
	private socket: Socket | undefined;
	private stopped = false;
	private attempt = 0;
	private retry: ReturnType<typeof setTimeout> | undefined;
	/** The hub of the current connection once it proved the shared secret; set only at the proven welcome, never at the challenge. */
	private hub: { id: string; name: string } | undefined;
	/** How the current connection's frames are written and read; set with {@link hub}. */
	private framing: LinkFraming | undefined;

	constructor(options: {
		join: JoinRecord;
		identity: MachineIdentity;
		events: LinkClientEvents;
		/** The ids of the machines joined to this one, reported to the hub so it can refuse a loop. */
		subtree?: () => readonly string[];
		depth?: () => number;
		/** Whether this machine refuses a hub that does not seal the link (read at each welcome). */
		requireSealed?: () => boolean;
	}) {
		this.join = options.join;
		this.identity = options.identity;
		this.events = options.events;
		this.subtree = options.subtree ?? (() => []);
		this.depth = options.depth ?? (() => 0);
		this.requireSealed = options.requireSealed ?? (() => false);
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

	/**
	 * Answers a hub message; false when the connection is gone or its hub has not proven the secret (the answer is lost,
	 * never queued: an answer must not reach whoever answers at the address before that proof). Throws when the answer
	 * is too long for the link once encoded.
	 */
	reply(id: string, text: string): boolean {
		const socket = this.socket;
		if (!socket || socket.destroyed) return false;
		if (!this.hub || !this.framing) {
			harnessLog.info("link", "a reply was not sent: the hub has not proven the secret on this connection", {
				address: this.join.address,
			});
			return false;
		}
		const line = this.framing.encode({ t: "reply", id, text });
		if (line === undefined) throw new Error("the answer is too long for the link once encoded");
		socket.write(line);
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
		this.framing = undefined;
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
		// A hub proven on an earlier connection says nothing about this one.
		this.hub = undefined;
		this.framing = undefined;
		socket.setEncoding("utf8");
		socket.setNoDelay(true);
		const lines = new LineBuffer();
		let ownNonce = "";
		// Who answered this connection's challenge: unproven until its welcome carries the proof.
		let challenger: { id: string; name: string; nonce: string; features: readonly string[] } | undefined;
		let welcomed = false;
		let lastSeen = Date.now();
		const handshake = setTimeout(() => {
			if (!welcomed) socket.destroy();
		}, HANDSHAKE_MS);
		const watchdog = setInterval(() => {
			if (welcomed && Date.now() - lastSeen > SILENCE_MS) socket.destroy();
		}, 10_000);
		watchdog.unref();
		let closeReason: CloseReason | undefined;
		const refused = (reason: LinkRefusal): void => {
			closeReason = { text: REFUSAL_TEXT[reason], permanent: PERMANENT_REFUSALS.has(reason) };
			socket.destroy();
		};
		const failed = (text: string, permanent = false): void => {
			closeReason = { text, permanent };
			socket.destroy();
		};
		socket.on("error", () => {});
		socket.on("close", () => {
			clearTimeout(handshake);
			clearInterval(watchdog);
			// A superseded connection closing must not clear the hub the current one proved or schedule a second retry.
			const current = this.socket === socket;
			if (current) this.socket = undefined;
			if (this.stopped || !current) return;
			// A refusal that retrying cannot change waits for the owner; a lost connection is retried.
			if (closeReason) this.wait(closeReason.text, closeReason.permanent);
			else this.wait(welcomed ? "the connection to the hub was lost" : "the hub could not be reached");
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
				if (welcomed) {
					if (!this.afterWelcome(frame, socket)) return;
					continue;
				}
				switch (frame.t) {
					case "challenge": {
						// One challenge opens a connection; a second one would rebind the hub the join has proven or is proving.
						if (challenger) return refused("protocol");
						if (frame.hubId === this.identity.machineId) return refused("would_loop");
						ownNonce = newNonce();
						challenger = {
							id: frame.hubId,
							name: frame.hubName,
							nonce: frame.nonce,
							features: frame.features ?? [],
						};
						const depth = this.depth();
						if (depth + 1 > MAX_LINK_DEPTH) return refused("too_deep");
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
								features: LINK_FEATURES,
							}),
						);
						break;
					}
					case "welcome": {
						// This build always lists features, so a hub that read them answers with the proof that binds the
						// active ones; a hub on the first version of the link answers without features and its first proof.
						const proven =
							challenger !== undefined &&
							proofsMatch(
								frame.features
									? hubFeatureProof(this.join.secret, ownNonce, challenger.id, frame.features)
									: hubProof(this.join.secret, ownNonce, challenger.id),
								frame.proof,
							);
						if (!proven || !challenger) return refused("bad_proof");
						const active = frame.features ?? [];
						// The hub may confirm only what both offered; a hub that offered sealing confirms it.
						if (
							commonFeatures(active, commonFeatures(LINK_FEATURES, challenger.features)).length !== active.length
						)
							return failed("the hub confirmed a feature that was not offered");
						const sealed = active.includes(SEALED_FEATURE);
						if (!sealed && challenger.features.includes(SEALED_FEATURE)) {
							harnessLog.warn(
								"link",
								"a hub offered a sealed link and did not confirm it; the connection was closed",
								{
									address: this.join.address,
								},
							);
							return failed("the hub offered a sealed link and its answer did not confirm it");
						}
						if (!sealed && this.requireSealed())
							return failed("the hub does not seal the link, and this machine requires a sealed link", true);
						this.framing = new LinkFraming(
							sealed
								? new SealedLink(
										{
											secret: this.join.secret,
											hubNonce: challenger.nonce,
											joinerNonce: ownNonce,
											hubId: challenger.id,
											machineId: this.identity.machineId,
											hubFeatures: challenger.features,
											joinerFeatures: LINK_FEATURES,
										},
										"joiner",
									)
								: undefined,
						);
						this.hub = { id: challenger.id, name: challenger.name };
						welcomed = true;
						this.attempt = 0;
						clearTimeout(handshake);
						harnessLog.info("link", "joined a hub", { address: this.join.address, hub: this.hub.name, sealed });
						this.events.state({
							state: "connected",
							hubName: this.hub.name,
							hubId: this.hub.id,
							features: active,
						});
						break;
					}
					case "refuse":
						return refused(frame.reason);
					default:
						// Nothing but the handshake comes before the welcome.
						socket.destroy();
						return;
				}
			}
		});
	}

	/** Handles one frame after the proven welcome; false when it was refused and the connection is closing. */
	private afterWelcome(frame: LinkFrame, socket: Socket): boolean {
		const framing = this.framing;
		const hub = this.hub;
		const inner: LinkInnerFrame | string = framing ? framing.decode(frame) : "inner";
		if (typeof inner === "string" || !hub || !framing) {
			// Category and address only: nothing of the frame, the keys or the secret is logged.
			harnessLog.warn("link", "a frame from the hub was refused; the connection was closed", {
				address: this.join.address,
				reason: inner,
				sealed: framing?.isSealed === true,
			});
			socket.destroy();
			return false;
		}
		if (inner.t === "msg") this.events.message(hub.id, hub.name, inner.id, inner.text);
		else if (inner.t === "ping") {
			const pong = framing.encode({ t: "pong" });
			if (pong !== undefined) socket.write(pong);
		}
		return true;
	}
}
