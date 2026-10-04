import {
	DEFAULT_TIMEOUT_MS,
	MAX_ENVELOPE_BYTES,
	MAX_MESSAGE_BYTES,
	MAX_MESSAGE_ID_CHARS,
	MAX_METADATA_BYTES,
	MAX_TIMEOUT_MS,
	MESSAGE_ID_PATTERN,
} from "./constants.ts";

export type AgentSendInput = {
	to: string | string[];
	message: string;
	expectReply: boolean;
	timeoutMs: number;
	metadata?: Record<string, unknown>;
	/** Stable id of this send; a retry carries the same id so the receiver delivers it once. */
	messageId?: string;
};

const AGENT_SEND_KEYS = new Set(["to", "message", "expectReply", "timeoutMs", "metadata", "messageId"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeAgentSendInput(input: unknown): AgentSendInput {
	if (!isRecord(input)) throw new Error("agent_send input must be an object.");
	for (const key of Object.keys(input)) {
		if (!AGENT_SEND_KEYS.has(key)) throw new Error(`agent_send received unsupported field: ${key}`);
	}
	const to = input.to;
	if (typeof to !== "string" && !(Array.isArray(to) && to.every((item) => typeof item === "string"))) {
		throw new Error("agent_send.to must be a peer id/name/address, an array of targets, or '*'.");
	}
	if (typeof input.message !== "string") throw new Error("agent_send.message must be a string.");
	const message = input.message.trim();
	if (message.length === 0) throw new Error("agent_send.message must not be empty.");
	if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
		throw new Error(`agent_send.message is too large; max ${MAX_MESSAGE_BYTES} bytes.`);
	}
	const expectReply = input.expectReply === undefined ? false : input.expectReply;
	if (typeof expectReply !== "boolean") throw new Error("agent_send.expectReply must be a boolean when provided.");
	const timeoutMs = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error("agent_send.timeoutMs must be a positive number when provided.");
	}
	if (timeoutMs > MAX_TIMEOUT_MS) throw new Error(`agent_send.timeoutMs exceeds max ${MAX_TIMEOUT_MS}.`);
	const metadata = input.metadata;
	if (metadata !== undefined) {
		if (!isRecord(metadata)) throw new Error("agent_send.metadata must be a JSON object when provided.");
		if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_METADATA_BYTES) {
			throw new Error(`agent_send.metadata is too large; max ${MAX_METADATA_BYTES} bytes.`);
		}
	}
	const messageId = input.messageId;
	if (
		messageId !== undefined &&
		(typeof messageId !== "string" || messageId.length > MAX_MESSAGE_ID_CHARS || !MESSAGE_ID_PATTERN.test(messageId))
	) {
		throw new Error(
			`agent_send.messageId must be 1-${MAX_MESSAGE_ID_CHARS} letters, digits, '.', '_', ':' or '-' when provided.`,
		);
	}
	const normalized = { to, message, expectReply, timeoutMs, metadata, messageId };
	if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_ENVELOPE_BYTES) {
		throw new Error(`agent_send envelope is too large; max ${MAX_ENVELOPE_BYTES} bytes.`);
	}
	return normalized;
}
