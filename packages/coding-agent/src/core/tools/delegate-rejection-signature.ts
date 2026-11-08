/**
 * Repeated rejections of the same `delegate` call, detected by code.
 *
 * A refusal that judges only the call's own input (see `isInputRejection`) answers the identical call identically,
 * whatever else happens in the session. The kernel's recovery gate already refuses an identical retry until the
 * world advances (a successful tool result or an owner turn); this detector covers what that gate admits again: the
 * same refused input sent after unrelated work moved the world. A rejection's signature is the action, the skip code,
 * the refused field and a digest of the arguments. The window holds the last {@link MAX_TRACKED_REJECTIONS}
 * rejections of one session and caller for {@link REJECTION_WINDOW_MS}. The second occurrence is told it repeats a
 * refused call; the third and later are blocked with a plain reason. A changed argument is a new signature, and an
 * entry leaves the window when it expires or is displaced.
 */

import { createHash } from "node:crypto";

export const REJECTION_WINDOW_MS = 10 * 60_000;
export const MAX_TRACKED_REJECTIONS = 16;
/** The occurrence at which an identical refused call is blocked instead of refused again. */
export const BLOCK_AT_OCCURRENCE = 3;

export interface RejectionSignatureInput {
	readonly action: string;
	readonly skipReason: string;
	readonly field?: string;
	readonly input: unknown;
}

/** JSON with object keys in a fixed order and absent members dropped, so key order never changes a digest. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, member]) => member !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** 16 hex characters of sha256 over the action, skip code, field and argument digest. */
export function rejectionSignature(rejection: RejectionSignatureInput): string {
	const digest = createHash("sha256").update(canonicalJson(rejection.input)).digest("hex");
	return createHash("sha256")
		.update(JSON.stringify([rejection.action, rejection.skipReason, rejection.field ?? "", digest]))
		.digest("hex")
		.slice(0, 16);
}

/** How many times a signature was refused inside the window, this occurrence included. */
export interface RejectionOccurrence {
	readonly signature: string;
	readonly occurrence: number;
}

export class RepeatedRejectionDetector {
	private readonly entries: { signature: string; at: number }[] = [];
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** Records one refusal of `signature` and returns its occurrence count inside the window. */
	note(signature: string): RejectionOccurrence {
		const at = this.now();
		this.expire(at);
		this.entries.push({ signature, at });
		if (this.entries.length > MAX_TRACKED_REJECTIONS)
			this.entries.splice(0, this.entries.length - MAX_TRACKED_REJECTIONS);
		return { signature, occurrence: this.count(signature) };
	}

	private count(signature: string): number {
		return this.entries.filter((entry) => entry.signature === signature).length;
	}

	private expire(at: number): void {
		const first = this.entries.findIndex((entry) => at - entry.at < REJECTION_WINDOW_MS);
		this.entries.splice(0, first < 0 ? this.entries.length : first);
	}
}
