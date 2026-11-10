import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH, MAX_WORKER_AUTHORITY_PATH_LENGTH } from "./session/agent-identity.ts";
import {
	normalizeSpecialistContextOwnership,
	type SpecialistContextClaim,
} from "./session/specialist-context-ownership.ts";
import { isPlainRecord } from "./utils/value-guards.ts";

type NodeCrypto = typeof import("node:crypto");

/**
 * Node-only digest source, reached lazily so the browser bundle never imports `node:crypto` statically (see
 * `scripts/check-browser-smoke.mjs`). In a browser `nodeCrypto()` returns undefined and `hostEventBindingDigest`
 * throws; that is acceptable because only the Node-side host-event transport and runtime create or verify these
 * records, so the browser never asks for a digest.
 */
function nodeCrypto(): NodeCrypto | undefined {
	if (typeof process === "undefined" || typeof process.getBuiltinModule !== "function") return undefined;
	return process.getBuiltinModule("node:crypto") as NodeCrypto;
}

/** Exact started execution allowed to receive one operational event. This never grants execution authority. */
export interface HostEventExecutionIdentity {
	readonly taskId: string;
	readonly attemptId: string;
	readonly agentId: string;
	readonly leaseId: string;
	readonly fencingToken: number;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly contextClaim?: SpecialistContextClaim;
}

/** Persisted beside an event message, so recovery proves the original delivery without parsing its text. */
export interface WorkerHostEventRecord {
	readonly deliveryId: string;
	readonly eventId: string;
	readonly payloadDigest: string;
	readonly subscriptionId: string;
	readonly subscriptionRevision: number;
	readonly generation: number;
	readonly sourceGeneration: number;
	readonly scopeVersion: number;
	readonly sourceSealDigest: string;
	readonly messageId: string;
	readonly contentDigest: string;
	readonly bindingDigest: string;
	readonly execution: HostEventExecutionIdentity;
}

const MAX_STAMP_BYTES = 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const EXECUTION_FIELDS = [
	"taskId",
	"attemptId",
	"agentId",
	"leaseId",
	"fencingToken",
	"sessionId",
	"sessionFile",
	"contextClaim",
];
const BINDING_FIELDS = [
	"deliveryId",
	"eventId",
	"payloadDigest",
	"subscriptionId",
	"subscriptionRevision",
	"generation",
	"sourceGeneration",
	"scopeVersion",
	"sourceSealDigest",
	"messageId",
	"contentDigest",
	"bindingDigest",
	"execution",
];

function identifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.trim() === value &&
		!value.includes("\0") &&
		value.length <= MAX_ORCHESTRATION_IDENTIFIER_LENGTH
	);
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function digest(value: unknown): value is string {
	return typeof value === "string" && DIGEST.test(value);
}

let utf8ByteLengthEncoder: TextEncoder | undefined;

/** UTF-8 byte length without the Node `Buffer` global; TextEncoder exists in browsers and Node and counts the same bytes. */
function utf8ByteLength(text: string): number {
	utf8ByteLengthEncoder ??= new TextEncoder();
	return utf8ByteLengthEncoder.encode(text).length;
}

export function parseHostEventExecutionIdentity(value: unknown): HostEventExecutionIdentity | undefined {
	if (!isPlainRecord(value) || !Object.keys(value).every((field) => EXECUTION_FIELDS.includes(field)))
		return undefined;
	if (
		!identifier(value.taskId) ||
		!identifier(value.attemptId) ||
		!identifier(value.agentId) ||
		!identifier(value.leaseId) ||
		!identifier(value.sessionId) ||
		!positiveInteger(value.fencingToken) ||
		typeof value.sessionFile !== "string" ||
		!value.sessionFile.trim() ||
		value.sessionFile.length > MAX_WORKER_AUTHORITY_PATH_LENGTH ||
		value.sessionFile.includes("\0")
	)
		return undefined;
	let contextClaim: SpecialistContextClaim | undefined;
	if (value.contextClaim !== undefined) {
		try {
			contextClaim = normalizeSpecialistContextOwnership({
				schemaVersion: 1,
				state: "busy",
				claim: value.contextClaim,
			}).claim;
		} catch {
			return undefined;
		}
	}
	const execution = {
		taskId: value.taskId,
		attemptId: value.attemptId,
		agentId: value.agentId,
		leaseId: value.leaseId,
		fencingToken: value.fencingToken,
		sessionId: value.sessionId,
		sessionFile: value.sessionFile,
		...(contextClaim ? { contextClaim: Object.freeze(contextClaim) } : {}),
	};
	return utf8ByteLength(JSON.stringify(execution)) <= MAX_STAMP_BYTES ? Object.freeze(execution) : undefined;
}

function parseBindingBody(value: unknown): Omit<WorkerHostEventRecord, "bindingDigest"> | undefined {
	if (!isPlainRecord(value) || !Object.keys(value).every((field) => BINDING_FIELDS.includes(field))) return undefined;
	const execution = parseHostEventExecutionIdentity(value.execution);
	if (
		!execution ||
		!identifier(value.deliveryId) ||
		!identifier(value.eventId) ||
		!identifier(value.subscriptionId) ||
		!identifier(value.messageId) ||
		!positiveInteger(value.subscriptionRevision) ||
		!positiveInteger(value.generation) ||
		!positiveInteger(value.sourceGeneration) ||
		!positiveInteger(value.scopeVersion) ||
		!digest(value.payloadDigest) ||
		!digest(value.sourceSealDigest) ||
		!digest(value.contentDigest)
	)
		return undefined;
	const body = {
		deliveryId: value.deliveryId,
		eventId: value.eventId,
		payloadDigest: value.payloadDigest,
		subscriptionId: value.subscriptionId,
		subscriptionRevision: value.subscriptionRevision,
		generation: value.generation,
		sourceGeneration: value.sourceGeneration,
		scopeVersion: value.scopeVersion,
		sourceSealDigest: value.sourceSealDigest,
		messageId: value.messageId,
		contentDigest: value.contentDigest,
		execution,
	};
	return utf8ByteLength(JSON.stringify(body)) <= MAX_STAMP_BYTES - 96 ? body : undefined;
}

/** Canonical ordered serialization is shared by creation and persisted proof validation. */
export function hostEventBindingDigest(value: Omit<WorkerHostEventRecord, "bindingDigest">): string {
	const body = parseBindingBody(value);
	if (!body) throw new TypeError("Host event binding is invalid.");
	const crypto = nodeCrypto();
	if (!crypto) throw new Error("Host event binding digests are unavailable in this runtime");
	return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

export function createWorkerHostEventRecord(
	value: Omit<WorkerHostEventRecord, "bindingDigest">,
): WorkerHostEventRecord {
	const body = parseBindingBody(value);
	if (!body) throw new TypeError("Host event binding is invalid.");
	return Object.freeze({ ...body, bindingDigest: hostEventBindingDigest(body) });
}

export function parseWorkerHostEventRecord(value: unknown): WorkerHostEventRecord | undefined {
	const body = parseBindingBody(value);
	if (
		!body ||
		!isPlainRecord(value) ||
		!digest(value.bindingDigest) ||
		hostEventBindingDigest(body) !== value.bindingDigest
	)
		return undefined;
	return Object.freeze({ ...body, bindingDigest: value.bindingDigest });
}
