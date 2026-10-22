import { closeSync, openSync, readSync } from "node:fs";
import { isValidSessionId, MAX_SESSION_HEADER_BYTES } from "./session-identity.ts";

export interface SessionHeader {
	type: "session";
	version?: number; // v1 sessions don't have this
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

/**
 * Outcome of reading a session file's first line. `unreadable` carries the I/O error so a caller can
 * tell a file it could not open from a file that is simply not a session (`not_a_header`: empty,
 * longer than the byte bound, malformed JSON, or not a `session` record with a string id).
 */
export type SessionHeaderReadResult =
	| { ok: true; header: SessionHeader }
	| { ok: false; reason: "unreadable"; cause: unknown }
	| { ok: false; reason: "not_a_header" }
	/** A session header whose id is not a valid session id: the file is not adopted, and nothing is derived from the id. */
	| { ok: false; reason: "invalid_session_id"; header: SessionHeader };

/** Read and parse the header line of a session file, looking at no more than `maxBytes` of it. */
export function readSessionHeaderResult(
	filePath: string,
	maxBytes: number = MAX_SESSION_HEADER_BYTES,
): SessionHeaderReadResult {
	try {
		const fd = openSync(filePath, "r");
		try {
			return readSessionHeaderFromDescriptor(fd, maxBytes);
		} finally {
			closeSync(fd);
		}
	} catch (cause) {
		return { ok: false, reason: "unreadable", cause };
	}
}

/** Header identity is validated on the same descriptor as the caller's remaining read. */
export function readSessionHeaderFromDescriptor(fd: number, maxBytes: number): SessionHeaderReadResult {
	const buffer = Buffer.alloc(maxBytes + 1);
	const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
	const newlineIndex = buffer.subarray(0, bytesRead).indexOf(0x0a);
	if (newlineIndex < 0 && bytesRead > maxBytes) return { ok: false, reason: "not_a_header" };
	const line = buffer.toString("utf8", 0, newlineIndex >= 0 ? newlineIndex : bytesRead);
	if (!line) return { ok: false, reason: "not_a_header" };
	let header: Record<string, unknown>;
	try {
		header = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return { ok: false, reason: "not_a_header" };
	}
	if (header === null || typeof header !== "object" || header.type !== "session" || typeof header.id !== "string") {
		return { ok: false, reason: "not_a_header" };
	}
	// The header's fields are returned for diagnostics only: its id is not a valid session id, so nothing may use it as a handle.
	if (!isValidSessionId(header.id)) {
		return { ok: false, reason: "invalid_session_id", header: header as unknown as SessionHeader };
	}
	return { ok: true, header: header as unknown as SessionHeader };
}
