/**
 * Sealed frames (`sealed/1`): after the handshake proves the shared secret both ways, each connection derives two
 * keys from that secret and both handshake nonces, one per direction, and every later frame travels as AES-256-GCM
 * ciphertext. The nonce of each frame is its per-direction count, which also sits in the authenticated data, so a
 * replayed, reordered, dropped or reflected frame fails to open and the connection closes. Fresh nonces from both
 * sides make every connection's keys new, so no nonce is ever used twice under one key.
 *
 * Nothing here logs: callers log a category and a machine label only, never a key, a secret or a frame.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync } from "node:crypto";
import { encodeFrame, type LinkFrame, type LinkInnerFrame, MAX_FRAME_BYTES, parseFrame } from "./protocol.ts";

export const SEALED_FEATURE = "sealed/1";
/** What this build offers in `challenge` and `hello`. */
export const LINK_FEATURES: readonly string[] = [SEALED_FEATURE];

const KEY_BYTES = 32;
const TAG_BYTES = 16;
const IV_BYTES = 12;
const LABEL = "pi-link/1 sealed";
/** Room for the `{"t":"sealed","s":<count>,"c":""}` wrapper and the newline around the ciphertext. */
const WRAPPER_BYTES = 64;

type Direction = "h2j" | "j2h";

/** What both ends of one connection know after the handshake; any difference gives different keys and a failed open. */
export interface SealedHandshake {
	readonly secret: string;
	readonly hubNonce: string;
	readonly joinerNonce: string;
	readonly hubId: string;
	readonly machineId: string;
	/** The hub's offer exactly as the challenge carried it (absent: empty). */
	readonly hubFeatures: readonly string[];
	/** The joiner's offer exactly as the hello carried it. */
	readonly joinerFeatures: readonly string[];
}

function directionKey(handshake: SealedHandshake, direction: Direction): Buffer {
	// Both offers are bound, so a list changed on the way gives the two ends different keys. A digest keeps `info`
	// short whatever the ids and lists hold; the salt separates the nonces because their lengths vary.
	const transcript = createHash("sha256")
		.update(
			JSON.stringify([
				handshake.hubId,
				handshake.machineId,
				[...handshake.hubFeatures].sort(),
				[...handshake.joinerFeatures].sort(),
			]),
		)
		.digest("hex");
	return Buffer.from(
		hkdfSync(
			"sha256",
			Buffer.from(handshake.secret, "utf8"),
			Buffer.from(`${handshake.hubNonce}|${handshake.joinerNonce}`, "utf8"),
			Buffer.from(`${LABEL}|${direction}|${transcript}`, "utf8"),
			KEY_BYTES,
		),
	);
}

function ivFor(count: number): Buffer {
	const iv = Buffer.alloc(IV_BYTES);
	iv.writeBigUInt64BE(BigInt(count), 4);
	return iv;
}

function aadFor(direction: Direction, count: number): Buffer {
	return Buffer.from(`${LABEL}|${direction}|${count}`, "utf8");
}

/** Why a sealed frame did not open; the caller closes the connection either way. */
export type SealedOpenFailure = "unsealed" | "sequence" | "tag" | "inner";

/** One connection's sealing, from one end's side: writes seal with this end's key, reads open with the other's. */
export class SealedLink {
	private readonly sendKey: Buffer;
	private readonly receiveKey: Buffer;
	private readonly sendDirection: Direction;
	private readonly receiveDirection: Direction;
	private sent = 0;
	private received = 0;

	constructor(handshake: SealedHandshake, side: "hub" | "joiner") {
		this.sendDirection = side === "hub" ? "h2j" : "j2h";
		this.receiveDirection = side === "hub" ? "j2h" : "h2j";
		this.sendKey = directionKey(handshake, this.sendDirection);
		this.receiveKey = directionKey(handshake, this.receiveDirection);
	}

	/**
	 * The sealed line for one frame, or undefined when it would pass the frame bound. The size is known before
	 * encrypting, so a refused frame takes no count and no nonce.
	 */
	seal(frame: LinkInnerFrame): string | undefined {
		const plain = Buffer.from(JSON.stringify(frame), "utf8");
		const sealedChars = Math.ceil(((plain.length + TAG_BYTES) * 4) / 3);
		if (sealedChars + WRAPPER_BYTES > MAX_FRAME_BYTES) return undefined;
		if (this.sent >= Number.MAX_SAFE_INTEGER) throw new Error("the sealed link ran out of frame numbers");
		const count = this.sent + 1;
		const cipher = createCipheriv("aes-256-gcm", this.sendKey, ivFor(count), { authTagLength: TAG_BYTES });
		cipher.setAAD(aadFor(this.sendDirection, count));
		const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
		this.sent = count;
		return encodeFrame({ t: "sealed", s: count, c: body.toString("base64url") });
	}

	/** The inner frame of the next sealed frame, or why it does not open. Only the very next count opens. */
	open(frame: LinkFrame): LinkInnerFrame | SealedOpenFailure {
		if (frame.t !== "sealed") return "unsealed";
		if (frame.s !== this.received + 1) return "sequence";
		const body = Buffer.from(frame.c, "base64url");
		if (body.length <= TAG_BYTES) return "tag";
		let plain: Buffer;
		try {
			const decipher = createDecipheriv("aes-256-gcm", this.receiveKey, ivFor(frame.s), {
				authTagLength: TAG_BYTES,
			});
			decipher.setAAD(aadFor(this.receiveDirection, frame.s));
			decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
			plain = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
		} catch {
			return "tag";
		}
		this.received = frame.s;
		const inner = parseFrame(plain.toString("utf8"));
		return inner && (inner.t === "msg" || inner.t === "reply" || inner.t === "ping" || inner.t === "pong")
			? inner
			: "inner";
	}
}

/**
 * How one end writes and reads the frames after the welcome: sealed when both sides negotiated `sealed/1`, plain for
 * a peer on the first version of the link. A sealed link refuses every plain frame, and a plain one every sealed frame.
 */
export class LinkFraming {
	private readonly sealed: SealedLink | undefined;

	constructor(sealed: SealedLink | undefined) {
		this.sealed = sealed;
	}

	get isSealed(): boolean {
		return this.sealed !== undefined;
	}

	/** The line to write for one frame, or undefined when it would pass the frame bound. */
	encode(frame: LinkInnerFrame): string | undefined {
		if (this.sealed) return this.sealed.seal(frame);
		const line = encodeFrame(frame);
		// The bound the reading side enforces, in UTF-8 bytes (the newline included).
		return Buffer.byteLength(line, "utf8") <= MAX_FRAME_BYTES ? line : undefined;
	}

	/** The frame a received one carries, or why it is refused. */
	decode(frame: LinkFrame): LinkInnerFrame | SealedOpenFailure {
		if (this.sealed) return this.sealed.open(frame);
		return frame.t === "msg" || frame.t === "reply" || frame.t === "ping" || frame.t === "pong" ? frame : "inner";
	}
}
