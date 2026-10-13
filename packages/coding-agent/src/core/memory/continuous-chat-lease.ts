/**
 * Lifetime ownership of one project's ICM chat: a single durable lease file naming its owner by an unguessable token,
 * pid, host and start time. A lease is replaced only when its owner is proven dead on this host. Any other lease,
 * including one whose owner cannot be checked, refuses the new owner. Ownership is fenced by re-reading the token under
 * the writer lock, never by a timer.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { isPositiveSafePid, probeProcessLiveness } from "../../kernel/reliability/process-tree.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import { ContinuousChatCorruptError, readJsonFile } from "./continuous-chat-index.ts";

export const CONTINUOUS_CHAT_LEASE_SCHEMA_VERSION = 1;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_BYTES = 32;
const MAX_HOST_CHARACTERS = 253;
const MAX_LABEL_CHARACTERS = 256;
const LEASE_KEYS = ["schemaVersion", "token", "pid", "hostname", "startedAt", "label"];

export interface ContinuousChatLeaseRecord {
	schemaVersion: typeof CONTINUOUS_CHAT_LEASE_SCHEMA_VERSION;
	token: string;
	pid: number;
	hostname: string;
	startedAt: string;
	/** The session that owns the chat, as its caller named it. Shown to the next owner when the lease is refused. */
	label?: string;
}

function isBoundedLine(value: unknown, maxCharacters: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!/[\r\n\0]/.test(value) &&
		Array.from(value).length <= maxCharacters
	);
}

/** A new owner record with a fresh 256-bit token, for this process. */
export function createContinuousChatLeaseRecord(options: { label?: string; now: Date }): ContinuousChatLeaseRecord {
	if (options.label !== undefined && !isBoundedLine(options.label, MAX_LABEL_CHARACTERS)) {
		throw new TypeError("Continuous-chat session label must be a bounded single line.");
	}
	const record: ContinuousChatLeaseRecord = {
		schemaVersion: CONTINUOUS_CHAT_LEASE_SCHEMA_VERSION,
		token: randomBytes(TOKEN_BYTES).toString("hex"),
		pid: process.pid,
		hostname: hostname(),
		startedAt: options.now.toISOString(),
	};
	if (options.label !== undefined) record.label = options.label;
	return record;
}

export function parseContinuousChatLeaseRecord(value: unknown): ContinuousChatLeaseRecord | undefined {
	if (!isPlainRecord(value) || value.schemaVersion !== CONTINUOUS_CHAT_LEASE_SCHEMA_VERSION) return undefined;
	if (!hasOnlyKeys(value, LEASE_KEYS)) return undefined;
	if (typeof value.token !== "string" || !TOKEN_PATTERN.test(value.token)) return undefined;
	if (!isPositiveSafePid(value.pid)) return undefined;
	if (!isBoundedLine(value.hostname, MAX_HOST_CHARACTERS)) return undefined;
	if (typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt))) return undefined;
	const record: ContinuousChatLeaseRecord = {
		schemaVersion: CONTINUOUS_CHAT_LEASE_SCHEMA_VERSION,
		token: value.token,
		pid: value.pid,
		hostname: value.hostname,
		startedAt: value.startedAt,
	};
	const { label } = value;
	if (label !== undefined) {
		if (!isBoundedLine(label, MAX_LABEL_CHARACTERS)) return undefined;
		record.label = label;
	}
	return record;
}

/** The lease file, or undefined when no session holds the project. A malformed lease is never replaced silently. */
export async function readContinuousChatLease(filePath: string): Promise<ContinuousChatLeaseRecord | undefined> {
	const parsed = await readJsonFile(filePath, "continuous-chat runtime lease");
	if (parsed === undefined) return undefined;
	const record = parseContinuousChatLeaseRecord(parsed);
	if (record === undefined) throw new ContinuousChatCorruptError(filePath, "Invalid continuous-chat runtime lease");
	return record;
}

/**
 * Whether the owner is proven dead: it ran on this host and its pid answers ESRCH. A live pid, a pid on another host,
 * and a probe that cannot classify its failure are all unproven, and never authorize a takeover.
 */
export function isContinuousChatLeaseOwnerProvenDead(record: ContinuousChatLeaseRecord): boolean {
	return record.hostname === hostname() && probeProcessLiveness(record.pid) === "dead";
}

/** The owner as an operator sees it. The token is never shown. */
function describeOwner(record: ContinuousChatLeaseRecord): string {
	const session = record.label === undefined ? "" : `, session ${record.label}`;
	return `pid ${record.pid} on ${record.hostname}${session}, started ${record.startedAt}`;
}

function heldMessage(owner: ContinuousChatLeaseRecord): string {
	let state: string;
	if (owner.hostname !== hostname()) state = "on another host, which this session cannot check";
	else if (probeProcessLiveness(owner.pid) === "alive") state = "still running";
	else state = "whose state could not be checked";
	return (
		`The ICM chat for this project is owned by ${describeOwner(owner)}, ${state}. ` +
		"Only one session per project may run the ICM chat; close that session first."
	);
}

/** Another session owns the project's ICM chat, and this session's lease was refused. Raised once, never retried. */
export class ContinuousChatLeaseHeldError extends Error {
	readonly owner: ContinuousChatLeaseRecord;

	constructor(owner: ContinuousChatLeaseRecord) {
		super(heldMessage(owner));
		this.name = "ContinuousChatLeaseHeldError";
		this.owner = owner;
	}
}

/** This session's lease is no longer the one on disk. The runtime stops; nothing further is written. */
export class ContinuousChatLeaseLostError extends Error {
	constructor(filePath: string, reason: string) {
		super(`Continuous-chat runtime lease is no longer held: ${reason}. ${filePath}`);
		this.name = "ContinuousChatLeaseLostError";
	}
}

/**
 * Best-effort release at process exit. It is synchronous, and it removes the file only while the file still names
 * `token`. An unreadable lease stays on disk; the next owner's liveness proof decides it.
 */
export function releaseContinuousChatLeaseSync(filePath: string, token: string): void {
	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (parseContinuousChatLeaseRecord(parsed)?.token === token) unlinkSync(filePath);
	} catch {
		// Exit is best effort. A lease that cannot be read here is left in place for the next owner to prove dead.
	}
}
