/**
 * The wire between a hub and a machine joined to it: one JSON frame per line over a TCP stream, each side proving
 * the shared secret by HMAC (neither side ever sends it). Any machine can be a hub, join a hub, or do both; a machine
 * is told apart by an id its own install generated, never by where it runs. `challenge`, `hello` and `welcome` may
 * list optional features; a peer that lists none speaks the first version of the link, and once both sides list
 * `sealed/1` every frame after the welcome travels sealed (`session-keys.ts`).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isPlainRecord } from "../util/value-guards.ts";
import type { JobFrame } from "./job-protocol.ts";

export const LINK_PROTOCOL_VERSION = 1;
/** A frame longer than this many UTF-8 bytes closes the connection; a sender refuses to write one. */
export const MAX_FRAME_BYTES = 128 * 1024;
/** The longest message text one frame carries. */
export const MAX_MESSAGE_CHARS = 32_000;
/** How deep a chain of hubs may go (a joined machine that is itself a hub counts one more). */
export const MAX_LINK_DEPTH = 3;
const MAX_SUBTREE = 64;
const MAX_FEATURES = 16;
const FEATURE = /^[a-z0-9][a-z0-9./-]{0,31}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type LinkFrame =
	| {
			readonly t: "challenge";
			readonly proto: number;
			readonly nonce: string;
			readonly hubId: string;
			readonly hubName: string;
			/** What the hub offers; absent from a hub on the first version of the link. */
			readonly features?: readonly string[];
	  }
	| {
			readonly t: "hello";
			readonly machineId: string;
			readonly name: string;
			readonly nonce: string;
			readonly proof: string;
			/** Ids of the machines joined (directly or not) to the sender: a hub refuses a machine whose subtree holds it. */
			readonly subtree: readonly string[];
			readonly depth: number;
			/** What the joiner offers; absent from a joiner on the first version of the link. */
			readonly features?: readonly string[];
	  }
	/** `features` is present exactly when the hello listed features: the active ones, bound into the proof. */
	| { readonly t: "welcome"; readonly proof: string; readonly features?: readonly string[] }
	| { readonly t: "refuse"; readonly reason: LinkRefusal }
	| { readonly t: "msg"; readonly id: string; readonly text: string }
	/**
	 * `final: false` is an interim answer under the id: it reaches the chat and leaves an ask's lane open. Absent is final,
	 * so a build that never sends the field ends a lane on its first reply, as it always did.
	 */
	| { readonly t: "reply"; readonly id: string; readonly text: string; readonly final?: boolean }
	| { readonly t: "ping" }
	| { readonly t: "pong" }
	/** A frame after the welcome on a sealed link: `s` counts this direction's frames from 1, `c` is the sealed inner frame. */
	| { readonly t: "sealed"; readonly s: number; readonly c: string };

/** The chat frames every version of the link carries after the welcome. */
export type LinkChatFrame = Extract<LinkFrame, { t: "msg" | "reply" | "ping" | "pong" }>;

/**
 * The frames carried after the welcome: chat, and on a sealed link that negotiated them the capability and job frames
 * (`job-protocol.ts`). The handshake never travels sealed.
 */
export type LinkInnerFrame = LinkChatFrame | JobFrame;

export function isChatFrame(frame: LinkFrame | LinkInnerFrame): frame is LinkChatFrame {
	return frame.t === "msg" || frame.t === "reply" || frame.t === "ping" || frame.t === "pong";
}

/** Fixed phrases: a refusal never carries the other side's text. */
export type LinkRefusal =
	| "unknown_machine"
	| "bad_proof"
	| "revoked"
	| "machine_changed"
	| "would_loop"
	| "too_deep"
	| "machine_taken"
	| "protocol";

export const REFUSAL_TEXT: Readonly<Record<LinkRefusal, string>> = {
	unknown_machine: "the hub does not know this machine name (create it there with /remote add)",
	bad_proof: "the join token does not match",
	revoked: "the hub revoked this machine",
	machine_changed: "the hub has this name bound to another install",
	would_loop: "joining would make a loop of hubs",
	too_deep: "the chain of hubs is too deep",
	machine_taken: "this install already joined the hub under another name",
	protocol: "the hub speaks another version of the link, or requires a sealed link this machine did not offer",
};

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isMachineName(value: unknown): value is string {
	return typeof value === "string" && NAME.test(value);
}

function text(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** An optional feature list: absent stays absent; a malformed one makes the whole frame malformed (`null`). */
function features(value: unknown): readonly string[] | undefined | null {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_FEATURES) return null;
	return value.every((entry) => typeof entry === "string" && FEATURE.test(entry)) ? (value as string[]) : null;
}

/** The features both lists name, in the order of `ours`. */
export function commonFeatures(ours: readonly string[], theirs: readonly string[]): string[] {
	return ours.filter((feature) => theirs.includes(feature));
}

/** One frame from a line, or undefined for anything that is not a well-formed frame. */
export function parseFrame(line: string): LinkFrame | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isPlainRecord(value) || typeof value.t !== "string") return undefined;
	switch (value.t) {
		case "challenge": {
			const offered = features(value.features);
			return value.proto === LINK_PROTOCOL_VERSION &&
				offered !== null &&
				text(value.nonce, 128) &&
				typeof value.hubId === "string" &&
				ID.test(value.hubId) &&
				isMachineName(value.hubName)
				? {
						t: "challenge",
						proto: value.proto,
						nonce: value.nonce,
						hubId: value.hubId,
						hubName: value.hubName,
						...(offered ? { features: offered } : {}),
					}
				: undefined;
		}
		case "hello": {
			const subtree = Array.isArray(value.subtree) ? value.subtree : undefined;
			const offered = features(value.features);
			if (
				offered === null ||
				typeof value.machineId !== "string" ||
				!ID.test(value.machineId) ||
				!isMachineName(value.name) ||
				!text(value.nonce, 128) ||
				!text(value.proof, 128) ||
				!subtree ||
				subtree.length > MAX_SUBTREE ||
				!subtree.every((id) => typeof id === "string" && ID.test(id)) ||
				typeof value.depth !== "number" ||
				!Number.isInteger(value.depth) ||
				value.depth < 0 ||
				value.depth > 16
			)
				return undefined;
			return {
				t: "hello",
				machineId: value.machineId,
				name: value.name,
				nonce: value.nonce,
				proof: value.proof,
				subtree: subtree as string[],
				depth: value.depth,
				...(offered ? { features: offered } : {}),
			};
		}
		case "welcome": {
			const active = features(value.features);
			return text(value.proof, 128) && active !== null
				? { t: "welcome", proof: value.proof, ...(active ? { features: active } : {}) }
				: undefined;
		}
		case "refuse":
			return typeof value.reason === "string" && value.reason in REFUSAL_TEXT
				? { t: "refuse", reason: value.reason as LinkRefusal }
				: undefined;
		case "msg":
			return typeof value.id === "string" && ID.test(value.id) && text(value.text, MAX_MESSAGE_CHARS)
				? { t: "msg", id: value.id, text: value.text }
				: undefined;
		case "reply": {
			// A present `final` must be a boolean; an absent one is left absent (a final reply), so the parsed frame says what was sent.
			if (value.final !== undefined && typeof value.final !== "boolean") return undefined;
			return typeof value.id === "string" && ID.test(value.id) && text(value.text, MAX_MESSAGE_CHARS)
				? {
						t: "reply",
						id: value.id,
						text: value.text,
						...(typeof value.final === "boolean" ? { final: value.final } : {}),
					}
				: undefined;
		}
		case "ping":
			return { t: "ping" };
		case "pong":
			return { t: "pong" };
		case "sealed":
			// The bound is checked on the text before anything is decoded from it.
			return typeof value.s === "number" &&
				Number.isSafeInteger(value.s) &&
				value.s >= 1 &&
				text(value.c, MAX_FRAME_BYTES) &&
				BASE64URL.test(value.c)
				? { t: "sealed", s: value.s, c: value.c }
				: undefined;
		default:
			return undefined;
	}
}

export function encodeFrame(frame: LinkFrame): string {
	return `${JSON.stringify(frame)}\n`;
}

export function newNonce(): string {
	return randomBytes(24).toString("base64url");
}

export function newSecret(): string {
	return randomBytes(32).toString("base64url");
}

/** The joiner's proof of the secret for this hub nonce, machine and name; it binds the proof to one handshake. */
export function joinProof(secret: string, hubNonce: string, machineId: string, name: string, ownNonce: string): string {
	return createHmac("sha256", secret).update(`join|${hubNonce}|${machineId}|${name}|${ownNonce}`).digest("base64url");
}

/** The hub's proof, answering the joiner's own nonce: the joiner learns it reached a hub that holds the secret. */
export function hubProof(secret: string, ownNonce: string, hubId: string): string {
	return createHmac("sha256", secret).update(`hub|${ownNonce}|${hubId}`).digest("base64url");
}

/**
 * The hub's proof when the joiner listed features: it also binds the active features, so a welcome whose list was cut
 * or changed on the way fails as a bad proof. A joiner that listed none gets {@link hubProof}.
 */
export function hubFeatureProof(secret: string, ownNonce: string, hubId: string, active: readonly string[]): string {
	return createHmac("sha256", secret)
		.update(`hub-features|${ownNonce}|${hubId}|${[...active].sort().join(",")}`)
		.digest("base64url");
}

export function proofsMatch(expected: string, given: string): boolean {
	const a = Buffer.from(expected);
	const b = Buffer.from(given);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Splits a decoded stream into lines. A line past the frame bound in UTF-8 bytes makes `push` return undefined (the
 * caller closes); the bound is checked on each piece before it is added to the unfinished line, so an endless line
 * never grows the buffer past the bound.
 */
export class LineBuffer {
	private pending = "";
	private pendingBytes = 0;

	push(chunk: string): string[] | undefined {
		const lines: string[] = [];
		let start = 0;
		while (start <= chunk.length) {
			const end = chunk.indexOf("\n", start);
			const piece = chunk.slice(start, end < 0 ? chunk.length : end);
			const bytes = this.pendingBytes + Buffer.byteLength(piece, "utf8");
			if (bytes > MAX_FRAME_BYTES) return undefined;
			if (end < 0) {
				this.pending += piece;
				this.pendingBytes = bytes;
				break;
			}
			const line = this.pending + piece;
			this.pending = "";
			this.pendingBytes = 0;
			if (line.length > 0) lines.push(line);
			start = end + 1;
		}
		return lines;
	}
}
