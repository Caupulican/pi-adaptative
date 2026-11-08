/**
 * The wire between a hub and a machine joined to it: one JSON frame per line over a TCP stream, each side proving
 * the shared secret by HMAC (neither side ever sends it). Any machine can be a hub, join a hub, or do both; a machine
 * is told apart by an id its own install generated, never by where it runs.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isPlainRecord } from "../util/value-guards.ts";

export const LINK_PROTOCOL_VERSION = 1;
/** A frame longer than this closes the connection. */
export const MAX_FRAME_BYTES = 128 * 1024;
/** The longest message text one frame carries. */
export const MAX_MESSAGE_CHARS = 32_000;
/** How deep a chain of hubs may go (a joined machine that is itself a hub counts one more). */
export const MAX_LINK_DEPTH = 3;
const MAX_SUBTREE = 64;

export type LinkFrame =
	| {
			readonly t: "challenge";
			readonly proto: number;
			readonly nonce: string;
			readonly hubId: string;
			readonly hubName: string;
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
	  }
	| { readonly t: "welcome"; readonly proof: string }
	| { readonly t: "refuse"; readonly reason: LinkRefusal }
	| { readonly t: "msg"; readonly id: string; readonly text: string }
	| { readonly t: "reply"; readonly id: string; readonly text: string }
	| { readonly t: "ping" }
	| { readonly t: "pong" };

/** Fixed phrases: a refusal never carries the other side's text. */
export type LinkRefusal =
	| "unknown_machine"
	| "bad_proof"
	| "revoked"
	| "machine_changed"
	| "would_loop"
	| "too_deep"
	| "protocol";

export const REFUSAL_TEXT: Readonly<Record<LinkRefusal, string>> = {
	unknown_machine: "the hub does not know this machine name (create it there with /remote add)",
	bad_proof: "the join token does not match",
	revoked: "the hub revoked this machine",
	machine_changed: "the hub has this name bound to another install",
	would_loop: "joining would make a loop of hubs",
	too_deep: "the chain of hubs is too deep",
	protocol: "the hub speaks another version of the link",
};

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isMachineName(value: unknown): value is string {
	return typeof value === "string" && NAME.test(value);
}

function text(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
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
		case "challenge":
			return value.proto === LINK_PROTOCOL_VERSION &&
				text(value.nonce, 128) &&
				typeof value.hubId === "string" &&
				ID.test(value.hubId) &&
				isMachineName(value.hubName)
				? { t: "challenge", proto: value.proto, nonce: value.nonce, hubId: value.hubId, hubName: value.hubName }
				: undefined;
		case "hello": {
			const subtree = Array.isArray(value.subtree) ? value.subtree : undefined;
			if (
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
			};
		}
		case "welcome":
			return text(value.proof, 128) ? { t: "welcome", proof: value.proof } : undefined;
		case "refuse":
			return typeof value.reason === "string" && value.reason in REFUSAL_TEXT
				? { t: "refuse", reason: value.reason as LinkRefusal }
				: undefined;
		case "msg":
		case "reply":
			return typeof value.id === "string" && ID.test(value.id) && text(value.text, MAX_MESSAGE_CHARS)
				? { t: value.t, id: value.id, text: value.text }
				: undefined;
		case "ping":
			return { t: "ping" };
		case "pong":
			return { t: "pong" };
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

export function proofsMatch(expected: string, given: string): boolean {
	const a = Buffer.from(expected);
	const b = Buffer.from(given);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Splits a stream into lines; a line past the frame bound makes `push` return undefined (the caller closes). */
export class LineBuffer {
	private pending = "";

	push(chunk: string): string[] | undefined {
		this.pending += chunk;
		const lines = this.pending.split("\n");
		this.pending = lines.pop() ?? "";
		if (this.pending.length > MAX_FRAME_BYTES || lines.some((line) => line.length > MAX_FRAME_BYTES))
			return undefined;
		return lines.filter((line) => line.length > 0);
	}
}
