/**
 * Custom message types and transformers for the agent kernel.
 *
 * Extends the base AgentMessage type with the kernel's custom message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { ImageContent, Message, TextContent } from "@caupulican/pi-ai";
import type { AgentMessage } from "./types.ts";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	/** Trusted bounded compaction metadata retained for host-owned provider gates. */
	details?: unknown;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "./types.ts" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	details?: unknown,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}

/**
 * AgentMessage roles that are ALSO valid wire `Message` roles - the ones `convertToLlm` above
 * passes through completely unchanged (its `case "user": case "assistant": case "toolResult":
 * return m;` branch). Every other AgentMessage kind (custom, bashExecution, branchSummary,
 * compactionSummary) needs real conversion before it can reach a provider; it is never already a
 * `Message`.
 *
 * Exhaustively checked against `AgentMessage["role"]` so a newly added AgentMessage kind forces
 * this decision to be revisited, rather than silently landing outside a hand-rolled allowlist. This
 * is the third time in one day a hand-rolled `role === "user" || "assistant" || "toolResult"`
 * allowlist has drifted out of date against a since-added AgentMessage kind (see
 * `defaultConvertToLlm`'s history in agent.ts, and the two test-fixture `identityConverter`s this
 * shape broke in packages/agent/test/{mandatory-tool-failure-recovery,runaway-loop}.test.ts) -
 * exported so a caller that genuinely only wants "is this already Message-shaped" (a pass-through
 * filter, not a full conversion) has one canonical, drift-proof answer instead of writing a fourth.
 *
 * NOT the right predicate for "is this valid PERSISTED conversation content" - see
 * `isCoreConversationMessageRole` below for that distinct question, which deliberately answers
 * `"custom"` differently.
 */
export function isWireNativeAgentMessageRole(role: AgentMessage["role"]): role is Message["role"] {
	switch (role) {
		case "user":
		case "assistant":
		case "toolResult":
			return true;
		case "custom":
		case "bashExecution":
		case "branchSummary":
		case "compactionSummary":
			return false;
		default: {
			const _exhaustiveCheck: never = role;
			return _exhaustiveCheck;
		}
	}
}

/**
 * AgentMessage roles that represent a real, independent conversational turn - content any durable
 * transcript (the main session's, or a worker's own) should be able to hold and later read back as
 * itself, never converted or dropped. This is a DIFFERENT question from
 * `isWireNativeAgentMessageRole` above, and deliberately disagrees with it on `"custom"`: a
 * durable, append-on-change transient record (transient-records.ts - the tool-failure ledger, a
 * verification obligation) is genuine conversation content once committed, even though it still
 * needs `convertToLlm`'s conversion before it can reach a provider on the wire. The other three
 * excluded kinds (`bashExecution`, `branchSummary`, `compactionSummary`) are host-computed
 * annotations injected into the FOREGROUND session's own history for display/context - `/bash` and
 * extension-driven bash (packages/coding-agent's `bash-execution-controller.ts`, its own
 * `SessionManager`) and branch/compaction summarization (packages/agent's `compaction/` machinery,
 * wired only into a top-level `Agent`'s own `AgentLoopConfig`) - neither mechanism is reachable from
 * an isolated/child completion (see `runIsolatedCompletion` in packages/coding-agent's
 * `reflection-controller.ts`, whose hand-built child `loopConfig` never wires compaction hooks, and
 * which has no bash-slash-command surface of its own), so a worker's own transcript can never
 * legitimately contain one - excluding them here is not special-casing what happens to be reachable
 * today, it is the correct, verified answer for what a worker conversation can ever hold.
 *
 * Exhaustively checked for the same reason as `isWireNativeAgentMessageRole`.
 */
export function isCoreConversationMessageRole(
	role: AgentMessage["role"],
): role is "user" | "assistant" | "toolResult" | "custom" {
	switch (role) {
		case "user":
		case "assistant":
		case "toolResult":
		case "custom":
			return true;
		case "bashExecution":
		case "branchSummary":
		case "compactionSummary":
			return false;
		default: {
			const _exhaustiveCheck: never = role;
			return _exhaustiveCheck;
		}
	}
}
