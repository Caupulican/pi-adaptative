import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { AssistantMessage, TextContent, UserMessage } from "@caupulican/pi-ai";
import { isAssistantCommentary } from "../message-phase.ts";
import {
	MAX_WORKER_CONTEXT_FORK_BYTES,
	MAX_WORKER_CONTEXT_FORK_MESSAGES,
	MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS,
} from "../orchestration/worker-context-fork-reference.ts";

export const SANITIZED_CONTEXT_FORK_COMPACTION_PREFIX =
	"The parent conversation history before this point was compacted into the following checkpoint:\n\n<summary>\n";
export const SANITIZED_CONTEXT_FORK_COMPACTION_SUFFIX = "\n</summary>\n\n";

export type SanitizedContextForkMode = { kind: "none" } | { kind: "all" } | { kind: "last_user_turns"; count: number };

export type SanitizedContextForkMessage = UserMessage | AssistantMessage;

type ContextTextCandidate = AssistantMessage["content"][number] | Exclude<UserMessage["content"], string>[number];

type SanitizedCompactionCheckpoint = { kind: "valid"; text: string } | { kind: "invalid" };
type SanitizedMessageResult<T> = { kind: "ok"; message: T } | { kind: "drop" } | { kind: "oversized" };
type UserBoundaryKind = "eligible" | "worker_control" | "unsupported" | "oversized";

const WORKER_CONTROL_PREFIX = /^\[Worker control worker-message-[^\]\s]+(?: [^\]]+)?\]\r?\n/;
const MAX_WORKER_CONTROL_PREFIX_CHARS = 2048;

function invalidMode(): TypeError {
	return new TypeError("Context fork mode must be none, all, or a positive safe-integer string.");
}

/** Parse the eventual tool-facing `fork_turns` wire value without choosing a default policy. */
export function parseSanitizedContextForkMode(value: string): SanitizedContextForkMode {
	const normalized = value.trim().toLowerCase();
	if (normalized === "none") return { kind: "none" };
	if (normalized === "all") return { kind: "all" };
	if (!/^\d+$/.test(normalized)) throw invalidMode();
	const count = Number(normalized);
	if (!Number.isSafeInteger(count) || count <= 0) throw invalidMode();
	return { kind: "last_user_turns", count };
}

function sanitizedTextBlocks(
	content: readonly ContextTextCandidate[],
	dropCommentary: boolean,
): { kind: "ok"; blocks: TextContent[] } | { kind: "oversized" } {
	if (content.length > MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS) return { kind: "oversized" };
	const blocks: TextContent[] = [];
	let textBytes = 0;
	for (const block of content) {
		if (block.type !== "text" || !block.text.trim()) continue;
		if (dropCommentary && isAssistantCommentary(block)) continue;
		textBytes += Buffer.byteLength(block.text, "utf-8");
		if (textBytes > MAX_WORKER_CONTEXT_FORK_BYTES) return { kind: "oversized" };
		blocks.push({ type: "text", text: block.text });
	}
	return { kind: "ok", blocks };
}

function isWorkerControlUserMessage(message: UserMessage): boolean {
	if (typeof message.content === "string") {
		const newline = message.content.indexOf("\n", 0);
		const prefixEnd = newline >= 0 ? newline + 1 : MAX_WORKER_CONTROL_PREFIX_CHARS;
		return WORKER_CONTROL_PREFIX.test(message.content.slice(0, Math.min(prefixEnd, MAX_WORKER_CONTROL_PREFIX_CHARS)));
	}
	let prefix = "";
	for (const block of message.content) {
		if (block.type !== "text") continue;
		const remaining = MAX_WORKER_CONTROL_PREFIX_CHARS - prefix.length;
		if (remaining <= 0) return false;
		const newline = block.text.indexOf("\n");
		const blockPrefixEnd = newline >= 0 ? newline + 1 : block.text.length;
		prefix += block.text.slice(0, Math.min(blockPrefixEnd, remaining));
		if (newline >= 0) break;
	}
	return WORKER_CONTROL_PREFIX.test(prefix);
}

function userBoundaryKind(message: UserMessage): UserBoundaryKind {
	if (isWorkerControlUserMessage(message)) return "worker_control";
	if (typeof message.content === "string") {
		if (!message.content.trim()) return "unsupported";
		return Buffer.byteLength(message.content, "utf-8") > MAX_WORKER_CONTEXT_FORK_BYTES ? "oversized" : "eligible";
	}
	if (message.content.length > MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS) return "oversized";
	let hasText = false;
	let textBytes = 0;
	for (const block of message.content) {
		if (block.type !== "text" || !block.text.trim()) continue;
		hasText = true;
		textBytes += Buffer.byteLength(block.text, "utf-8");
		if (textBytes > MAX_WORKER_CONTEXT_FORK_BYTES) return "oversized";
	}
	return hasText ? "eligible" : "unsupported";
}

function sanitizeUserMessage(message: UserMessage): SanitizedMessageResult<UserMessage> {
	const boundary = userBoundaryKind(message);
	if (boundary === "worker_control" || boundary === "unsupported") return { kind: "drop" };
	if (boundary === "oversized") return { kind: "oversized" };
	if (typeof message.content === "string") {
		return { kind: "ok", message: { role: "user", content: message.content, timestamp: message.timestamp } };
	}
	const sanitized = sanitizedTextBlocks(message.content, false);
	if (sanitized.kind === "oversized") return sanitized;
	if (sanitized.blocks.length === 0) return { kind: "drop" };
	return { kind: "ok", message: { role: "user", content: sanitized.blocks, timestamp: message.timestamp } };
}

function sanitizeCompactionCheckpoint(
	message: Extract<AgentMessage, { role: "compactionSummary" }>,
): SanitizedCompactionCheckpoint {
	if (typeof message.summary !== "string" || !message.summary.trim()) return { kind: "invalid" };
	const wrapperBytes = Buffer.byteLength(
		SANITIZED_CONTEXT_FORK_COMPACTION_PREFIX + SANITIZED_CONTEXT_FORK_COMPACTION_SUFFIX,
		"utf-8",
	);
	if (Buffer.byteLength(message.summary, "utf-8") > MAX_WORKER_CONTEXT_FORK_BYTES - wrapperBytes) {
		return { kind: "invalid" };
	}
	return {
		kind: "valid",
		text: SANITIZED_CONTEXT_FORK_COMPACTION_PREFIX + message.summary + SANITIZED_CONTEXT_FORK_COMPACTION_SUFFIX,
	};
}

function attachCompactionCheckpoint(
	message: UserMessage,
	checkpoint: Extract<SanitizedCompactionCheckpoint, { kind: "valid" }>,
): UserMessage {
	const checkpointBlock: TextContent = { type: "text", text: checkpoint.text };
	return {
		role: "user",
		content:
			typeof message.content === "string"
				? [checkpointBlock, { type: "text", text: message.content }]
				: [checkpointBlock, ...message.content],
		timestamp: message.timestamp,
	};
}

/**
 * Resolve each durable compaction replacement onto its following real user turn. The map is capped
 * at the maximum output size: an older association cannot be selected once that many newer mapped
 * user messages exist, even when every selected turn contains only its user message.
 */
function compactionCheckpointsByUserIndex(
	messages: readonly AgentMessage[],
): ReadonlyMap<number, SanitizedCompactionCheckpoint> {
	const checkpoints = new Map<number, SanitizedCompactionCheckpoint>();
	let pending: SanitizedCompactionCheckpoint | undefined;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role === "compactionSummary") {
			pending = sanitizeCompactionCheckpoint(message);
			continue;
		}
		if (message.role !== "user" || !pending) continue;
		const boundary = userBoundaryKind(message);
		if (boundary === "worker_control") continue;
		if (boundary === "eligible") checkpoints.set(index, pending);
		pending = undefined;
		if (checkpoints.size > MAX_WORKER_CONTEXT_FORK_MESSAGES) {
			const oldest = checkpoints.keys().next().value;
			if (oldest !== undefined) checkpoints.delete(oldest);
		}
	}
	return checkpoints;
}

function sanitizeAssistantMessage(message: AssistantMessage): SanitizedMessageResult<AssistantMessage> {
	// A length stop, tool request, failure, or abort is not a complete assistant answer.
	if (message.stopReason !== "stop") return { kind: "drop" };
	const sanitized = sanitizedTextBlocks(message.content, true);
	if (sanitized.kind === "oversized") return sanitized;
	if (sanitized.blocks.length === 0) return { kind: "drop" };
	return {
		kind: "ok",
		message: {
			role: "assistant",
			content: sanitized.blocks,
			api: message.api,
			provider: message.provider,
			model: message.model,
			usage: {
				input: message.usage.input,
				output: message.usage.output,
				cacheRead: message.usage.cacheRead,
				cacheWrite: message.usage.cacheWrite,
				totalTokens: message.usage.totalTokens,
				cost: {
					input: message.usage.cost.input,
					output: message.usage.cost.output,
					cacheRead: message.usage.cost.cacheRead,
					cacheWrite: message.usage.cost.cacheWrite,
					total: message.usage.cost.total,
				},
			},
			stopReason: "stop",
			timestamp: message.timestamp,
		},
	};
}

function serializedBytes(messages: readonly SanitizedContextForkMessage[]): number {
	return Buffer.byteLength(JSON.stringify(messages), "utf-8");
}

function textBlockCount(message: SanitizedContextForkMessage): number {
	return typeof message.content === "string" ? 1 : message.content.length;
}

function requestedTurnCount(mode: SanitizedContextForkMode): number {
	if (mode.kind === "none") return 0;
	if (mode.kind === "all") return Number.POSITIVE_INFINITY;
	if (!Number.isSafeInteger(mode.count) || mode.count <= 0) {
		throw new TypeError("Last-N context fork count must be a positive safe integer.");
	}
	return mode.count;
}

/**
 * Select a bounded suffix of complete, sanitized user turns.
 *
 * Selection walks backward so an arbitrarily long source transcript never creates an unbounded
 * second projection. Bounds drop whole oldest turns; no message text is truncated. The result is a
 * detached chronological copy containing no tool protocol, tool results, reasoning, provider
 * signatures, custom/system/developer messages, mailbox controls, or incomplete assistant output.
 */
export function selectSanitizedContextFork(
	messages: readonly AgentMessage[],
	mode: SanitizedContextForkMode,
): SanitizedContextForkMessage[] {
	const maxTurns = requestedTurnCount(mode);
	if (maxTurns === 0) return [];
	const compactionCheckpoints = compactionCheckpointsByUserIndex(messages);

	let selected: SanitizedContextForkMessage[] = [];
	let selectedTurns = 0;
	let selectedTextBlocks = 0;
	let reversedAssistantSuffix: AssistantMessage[] = [];
	let reversedAssistantTextBlocks = 0;
	let currentTurnOversized = false;

	for (let index = messages.length - 1; index >= 0; index--) {
		const source = messages[index]!;
		if (source.role === "assistant") {
			const sanitized = sanitizeAssistantMessage(source);
			if (sanitized.kind === "oversized") {
				currentTurnOversized = true;
				reversedAssistantSuffix = [];
				reversedAssistantTextBlocks = 0;
				continue;
			}
			if (sanitized.kind === "drop") continue;
			if (currentTurnOversized) continue;
			const candidate = [sanitized.message, ...reversedAssistantSuffix];
			const candidateTextBlocks = textBlockCount(sanitized.message) + reversedAssistantTextBlocks;
			if (
				candidate.length >= MAX_WORKER_CONTEXT_FORK_MESSAGES ||
				serializedBytes(candidate) >= MAX_WORKER_CONTEXT_FORK_BYTES ||
				candidateTextBlocks >= MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS
			) {
				currentTurnOversized = true;
				reversedAssistantSuffix = [];
				reversedAssistantTextBlocks = 0;
				continue;
			}
			reversedAssistantSuffix = candidate;
			reversedAssistantTextBlocks = candidateTextBlocks;
			continue;
		}
		if (source.role !== "user") continue;
		const sanitized = sanitizeUserMessage(source);
		if (sanitized.kind === "drop") {
			reversedAssistantSuffix = [];
			reversedAssistantTextBlocks = 0;
			currentTurnOversized = false;
			continue;
		}
		if (sanitized.kind === "oversized") break;

		const checkpoint = compactionCheckpoints.get(index);
		if (checkpoint?.kind === "invalid") break;
		const userMessage = checkpoint ? attachCompactionCheckpoint(sanitized.message, checkpoint) : sanitized.message;
		if (currentTurnOversized) break;
		const turn: SanitizedContextForkMessage[] = [userMessage, ...reversedAssistantSuffix];
		const turnTextBlocks = textBlockCount(userMessage) + reversedAssistantTextBlocks;
		const candidate = [...turn, ...selected];
		if (
			candidate.length > MAX_WORKER_CONTEXT_FORK_MESSAGES ||
			serializedBytes(candidate) > MAX_WORKER_CONTEXT_FORK_BYTES ||
			turnTextBlocks + selectedTextBlocks > MAX_WORKER_CONTEXT_FORK_TEXT_BLOCKS
		) {
			break;
		}
		selected = candidate;
		selectedTurns += 1;
		selectedTextBlocks += turnTextBlocks;
		if (selectedTurns >= maxTurns) break;
		reversedAssistantSuffix = [];
		reversedAssistantTextBlocks = 0;
	}

	return selected;
}
