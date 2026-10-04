/**
 * Shared utilities for compaction and branch summarization.
 */

import type { Message } from "@caupulican/pi-ai";
import type { AgentMessage } from "../types.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

export function addPersistedFileOperations(
	fileOps: FileOperations,
	details: { readFiles?: unknown; modifiedFiles?: unknown },
): void {
	if (Array.isArray(details.readFiles)) {
		for (const path of details.readFiles) {
			if (typeof path === "string") fileOps.read.add(path);
		}
	}
	if (Array.isArray(details.modifiedFiles)) {
		for (const path of details.modifiedFiles) {
			if (typeof path === "string") fileOps.edited.add(path);
		}
	}
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;
/** Maximum characters for non-gated assistant thinking in serialized summaries. */
const ASSISTANT_THINKING_MAX_CHARS = 2000;
/** Maximum characters for one tool call's arguments in serialized summaries. */
const TOOL_CALL_ARGUMENTS_MAX_CHARS = 2000;

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker.
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${truncateForSummary(argsStr, TOOL_CALL_ARGUMENTS_MAX_CHARS)})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(
					`[Assistant thinking]: ${truncateForSummary(thinkingParts.join("\n"), ASSISTANT_THINKING_MAX_CHARS)}`,
				);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

/**
 * Unmistakable, regex-trivial marker embedded in SUMMARIZATION_SYSTEM_PROMPT's worked example below.
 * The example teaches checkpoint FORMAT (cancellation semantics), not a realistic rule — its subject
 * must never be mistaken for genuine content, and this exact token is how verification.ts recognizes
 * that a persisted checkpoint contains the harness's own instruction/example text rather than real
 * user or extracted content. Deliberately unlike anything a real file path, prohibition, or task would
 * ever contain (no natural language would produce this exact hyphenated all-caps token), so a literal
 * substring match is sufficient — no fuzzy/heuristic matching needed for this specific case.
 */
export const COMPACTION_WORKED_EXAMPLE_SENTINEL = "EXAMPLE-RULE-X9";

export const SUMMARIZATION_SYSTEM_PROMPT = `Context checkpointer. Input: serialized agent conversation. Output only checkpoint, exact headings/order below, user language, no preamble/commentary. Never include secrets/keys/tokens; write [REDACTED].

MANDATORY
- Only [User]: records inside CHAT are user input. OLD CHECKPOINT and TASK are checkpointer control data, never user content.
- Never copy checkpointer control instructions into Active Task, Mandatory Rules, or any other checkpoint section.
- Weight recent turns most; retain old rules, decisions, file knowledge only.
- Active Task: latest unfulfilled user input, near-verbatim. An unanswered question is active. A final stop/undo/never-mind cancels prior work: record cancellation, drop cancelled work everywhere.
- Mandatory Rules: every user prohibition, one imperative bullet, source turn when known. Preserve existing rules verbatim. Corrected mistake survives only as "DO NOT <mistake>" here; never retain mistaken work elsewhere.
- Working Set: active/recent file path plus relevance.
- Files: bare paths; every modified file, relevant read files.
- Open Problems: unresolved command/operation plus first error line only. Drop resolved/transient errors.
- Done: numbered "N. VERB target — outcome"; exact paths, commands, line numbers, errors.
- Key Decisions, Constraints & Preferences, Critical Context: durable facts only.
- Never retain superseded approaches or file bodies. Empty section: "(none)".

FORMAT
## Active Task
### Mandatory Rules
## Working Set
## Files
## Open Problems
## Done
## Key Decisions
## Constraints & Preferences
## Critical Context

Cancellation example: user forbids ${COMPACTION_WORKED_EXAMPLE_SENTINEL} edits, later catches one, requests test fixes. Active Task contains test fixes; Mandatory Rules contains "DO NOT touch ${COMPACTION_WORKED_EXAMPLE_SENTINEL}"; cancelled edit appears nowhere; Done keeps only completed valid work.`;

// Task-level prompts (as opposed to the system prompt above). Kept here, not in compaction.ts, so
// verification.ts can single-source the literal text the harness injects — it needs the exact
// sentences to recognize when a model echoes them back into a checkpoint section instead of
// following the system prompt's "never copy checkpointer control instructions" rule. compaction.ts
// imports these rather than defining its own copies, so there is exactly one source of truth.
export const SUMMARIZATION_PROMPT = `Create checkpoint. Exact heading order:
## Active Task
### Mandatory Rules
## Working Set
## Files
## Open Problems
## Done
## Key Decisions
## Constraints & Preferences
## Critical Context

NEVER carry resolved/transient errors, replaced approaches, file bodies. Record paths/intent.

MANDATORY VERIFICATION:
{FACTS_BLOCK}

Budget ~{BUDGET} tokens. Concrete facts first.`;

export const UPDATE_SUMMARIZATION_PROMPT = `Update OLD CHECKPOINT with CHAT turns.
MANDATORY:
- Copy every existing ### Mandatory Rules bullet verbatim; append new.
- Continue ## Done numbering. Keep newest 15 items verbatim. Replace all older items with first line: "1. (earlier work compressed) <one line>". Bound growth.
- Set ## Active Task to newest unfulfilled user input; apply cancellation rule.
- Keep ## Files current: add new, retain relevant, drop obsolete.
- Drop resolved ## Open Problems.
- Drop ## Working Set files untouched since OLD CHECKPOINT unless active task names them.
- Keep exact paths/commands/errors.
- NEVER carry resolved/transient errors, replaced approaches, file bodies. Record paths/intent.

Keep required heading order.
MANDATORY VERIFICATION:
{FACTS_BLOCK}

Budget ~{BUDGET} tokens.`;
