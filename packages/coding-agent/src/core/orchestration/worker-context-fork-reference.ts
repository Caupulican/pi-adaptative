import { DEFAULT_MAX_BYTES } from "../../kernel/utils/truncate.ts";
import { CONTINUOUS_CHAT_TURN_VIEW_HIGH_BYTES } from "../memory/continuous-chat-view.ts";
import { isPlainRecord } from "../util/value-guards.ts";

export const WORKER_CONTEXT_FORK_REFERENCE_SCHEMA_VERSION = 1 as const;
/** Matches the maximum bounded transcript page exposed to worker context selection. */
export const MAX_WORKER_CONTEXT_FORK_MESSAGES = 64;
/** Reuses Pi's established hard ceiling for one model-visible bounded text projection. */
export const MAX_WORKER_CONTEXT_FORK_BYTES = DEFAULT_MAX_BYTES;
/** Aggregate ceiling of text blocks that context selection may emit. */
export const MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS = 1024;

/**
 * ICM's turn-view high-water mark in UTF-8 bytes. A target, not a hard cap: pending lines that cannot merge yet can
 * push the view past it.
 */
export const MAX_WORKER_BIRTH_VIEW_BYTES = CONTINUOUS_CHAT_TURN_VIEW_HIGH_BYTES;
/** JSON.stringify writes a control character as a six-byte \u00XX escape, the largest growth of any UTF-8 byte. */
const MAX_JSON_BYTE_EXPANSION = 6;
/**
 * Exact serialized cap for the view message: its text at worst-case JSON encoding, plus the message's own JSON envelope.
 * Capacity is separate from the selected history, which keeps its own exact cap below.
 */
export const MAX_WORKER_BIRTH_VIEW_MESSAGE_BYTES =
	MAX_JSON_BYTE_EXPANSION * MAX_WORKER_BIRTH_VIEW_BYTES +
	Buffer.byteLength(JSON.stringify({ role: "user", content: "", timestamp: Number.MAX_SAFE_INTEGER }));
/** The array separator between the view message and the selected history. */
const BIRTH_ARRAY_SEPARATOR_BYTES = 1;
/**
 * Serialized ceiling for a whole birth snapshot: the view capacity, the separator, then the unchanged selected-history
 * ceiling. A snapshot that declares its view is validated part by part against these exact caps.
 */
export const MAX_WORKER_BIRTH_SNAPSHOT_BYTES =
	MAX_WORKER_BIRTH_VIEW_MESSAGE_BYTES + BIRTH_ARRAY_SEPARATOR_BYTES + MAX_WORKER_CONTEXT_FORK_BYTES;
/** Selected history plus at most one view message. */
export const MAX_WORKER_BIRTH_SNAPSHOT_MESSAGES = MAX_WORKER_CONTEXT_FORK_MESSAGES + 1;
/** Selected history plus the view's single text block. */
export const MAX_WORKER_BIRTH_SNAPSHOT_TEXT_BLOCKS = MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS + 1;
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
		value.messageCount > MAX_WORKER_BIRTH_SNAPSHOT_MESSAGES
	) {
		throw new TypeError("Worker context fork reference message count is invalid.");
	}
	if (
		typeof value.messageBytes !== "number" ||
		!Number.isSafeInteger(value.messageBytes) ||
		value.messageBytes < 2 ||
		value.messageBytes > MAX_WORKER_BIRTH_SNAPSHOT_BYTES ||
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
