import { DEFAULT_MAX_BYTES } from "@caupulican/pi-agent-core/truncate";
import { isPlainRecord } from "../util/value-guards.ts";

export const WORKER_CONTEXT_FORK_REFERENCE_SCHEMA_VERSION = 1 as const;
/** Matches the maximum bounded transcript page exposed to worker context selection. */
export const MAX_WORKER_CONTEXT_FORK_MESSAGES = 64;
/** Reuses Pi's established hard ceiling for one model-visible bounded text projection. */
export const MAX_WORKER_CONTEXT_FORK_BYTES = DEFAULT_MAX_BYTES;
/** Aggregate ceiling shared by context selection and durable snapshot validation. */
export const MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS = 1024;
/** API transport identifiers are short protocol names, not model identifiers. */
export const MAX_WORKER_CONTEXT_FORK_API_LENGTH = 128;

/** Provider-neutral identity for one immutable, content-addressed worker birth snapshot. */
export interface WorkerContextForkReference {
	schemaVersion: typeof WORKER_CONTEXT_FORK_REFERENCE_SCHEMA_VERSION;
	identityDigest: string;
	contentDigest: string;
	messageCount: number;
	messageBytes: number;
}

const REFERENCE_FIELDS = ["schemaVersion", "identityDigest", "contentDigest", "messageCount", "messageBytes"] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Sole shape, bounds, canonicalization, and detached-copy owner for durable fork references. */
export function normalizeWorkerContextForkReference(value: unknown): WorkerContextForkReference {
	if (!isPlainRecord(value)) throw new TypeError("Worker context fork reference must be an object.");
	const actualFields = Object.keys(value);
	if (
		actualFields.length !== REFERENCE_FIELDS.length ||
		REFERENCE_FIELDS.some((field) => !Object.hasOwn(value, field))
	) {
		throw new TypeError("Worker context fork reference has an unsupported shape.");
	}
	if (value.schemaVersion !== WORKER_CONTEXT_FORK_REFERENCE_SCHEMA_VERSION) {
		throw new TypeError("Worker context fork reference schema is unsupported.");
	}
	if (
		typeof value.identityDigest !== "string" ||
		typeof value.contentDigest !== "string" ||
		!SHA256_PATTERN.test(value.identityDigest) ||
		!SHA256_PATTERN.test(value.contentDigest)
	) {
		throw new TypeError("Worker context fork reference digests are invalid.");
	}
	if (
		typeof value.messageCount !== "number" ||
		!Number.isSafeInteger(value.messageCount) ||
		value.messageCount < 0 ||
		value.messageCount > MAX_WORKER_CONTEXT_FORK_MESSAGES
	) {
		throw new TypeError("Worker context fork reference message count is invalid.");
	}
	if (
		typeof value.messageBytes !== "number" ||
		!Number.isSafeInteger(value.messageBytes) ||
		value.messageBytes < 2 ||
		value.messageBytes > MAX_WORKER_CONTEXT_FORK_BYTES ||
		(value.messageCount > 0 && value.messageBytes === 2)
	) {
		throw new TypeError("Worker context fork reference byte count is invalid.");
	}
	return {
		schemaVersion: WORKER_CONTEXT_FORK_REFERENCE_SCHEMA_VERSION,
		identityDigest: value.identityDigest,
		contentDigest: value.contentDigest,
		messageCount: value.messageCount,
		messageBytes: value.messageBytes,
	};
}
