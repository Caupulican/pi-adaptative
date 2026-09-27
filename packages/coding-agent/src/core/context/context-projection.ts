import { createHash } from "node:crypto";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { ContextItemKind, ContextSource } from "./context-item.ts";

export const CONTEXT_PROJECTION_SCHEMA_VERSION = 1 as const;

export type ContextProjectionProvenance =
	| { kind: "session_entry"; sourceId: string }
	| { kind: "request_derived"; sourceId: string };

export interface ContextProjectionFreshness {
	/** Request turn on which this exact projection was observed. Not part of its revision. */
	observedAtTurn: number;
	/** Immutable source timestamp carried by the message. */
	sourceTimestamp: number;
}

export interface ContextProjectionEntry {
	/** Logical identity. Content changes update `revision`, never this id. */
	id: string;
	/** Content-addressed version of the complete source message. */
	revision: string;
	messageIndex: number;
	role: AgentMessage["role"];
	kind: ContextItemKind;
	source: ContextSource;
	provenance: ContextProjectionProvenance;
	freshness: ContextProjectionFreshness;
}

export interface ContextProjection {
	schemaVersion: typeof CONTEXT_PROJECTION_SCHEMA_VERSION;
	/** Content- and order-sensitive version of the complete provider-visible context. */
	revision: string;
	observedAtTurn: number;
	entries: ContextProjectionEntry[];
}

export interface ContextProjectionOptions {
	turnIndex: number;
	/** Persisted provenance currently exists for tool results captured by the session branch. */
	sessionEntryIdForToolCallId?: (toolCallId: string) => string | undefined;
}

interface ContextProjectionEntryBase {
	revision: string;
	logicalSourceId: string;
	role: AgentMessage["role"];
	kind: ContextItemKind;
	source: ContextSource;
	sourceTimestamp: number;
}

/**
 * Per-message content-hash memo. Agent messages are immutable records: replacement creates a new
 * object, matching the same contract used by the audit and token-estimate memos.
 */
export type ContextProjectionMemo = Map<AgentMessage, ContextProjectionEntryBase>;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function assertNever(value: never): never {
	throw new Error(`Unsupported context projection role: ${String(value)}`);
}

function roleMetadata(message: AgentMessage): {
	logicalSourceId: string;
	kind: ContextItemKind;
	source: ContextSource;
} {
	switch (message.role) {
		case "user":
			return { logicalSourceId: `user:${message.timestamp}`, kind: "conversation_tail", source: "user" };
		case "assistant":
			return {
				logicalSourceId: `assistant:${message.timestamp}`,
				kind: "conversation_tail",
				source: "assistant",
			};
		case "toolResult":
			return { logicalSourceId: `tool:${message.toolCallId}`, kind: "tool_output", source: "tool" };
		case "custom":
			return {
				logicalSourceId: `custom:${message.customType}:${message.timestamp}`,
				kind: "conversation_tail",
				source: "runtime",
			};
		case "bashExecution":
			return {
				logicalSourceId: `bash:${message.timestamp}`,
				kind: "tool_output",
				source: "tool",
			};
		case "branchSummary":
			return {
				logicalSourceId: `branch-summary:${message.fromId}:${message.timestamp}`,
				kind: "conversation_tail",
				source: "session",
			};
		case "compactionSummary":
			return {
				logicalSourceId: `compaction-summary:${message.timestamp}:${message.tokensBefore}`,
				kind: "conversation_tail",
				source: "session",
			};
		default:
			return assertNever(message);
	}
}

function buildEntryBase(message: AgentMessage): ContextProjectionEntryBase {
	const metadata = roleMetadata(message);
	return {
		...metadata,
		revision: sha256(JSON.stringify(message)),
		role: message.role,
		sourceTimestamp: message.timestamp,
	};
}

/**
 * Build the typed, versioned view of one provider request. The projection owns identities and
 * versions only; the immutable transcript/provider messages remain the content authority.
 */
export function buildContextProjection(
	messages: readonly AgentMessage[],
	options: ContextProjectionOptions,
	memo?: ContextProjectionMemo,
): ContextProjection {
	const entries: ContextProjectionEntry[] = [];
	const liveMemoEntries: [AgentMessage, ContextProjectionEntryBase][] = [];
	const identityOccurrences = new Map<string, number>();

	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex];
		let base = memo?.get(message);
		if (!base) {
			base = buildEntryBase(message);
			memo?.set(message, base);
		}
		if (memo) liveMemoEntries.push([message, base]);

		const sessionEntryId =
			message.role === "toolResult" ? options.sessionEntryIdForToolCallId?.(message.toolCallId) : undefined;
		const provenance: ContextProjectionProvenance = sessionEntryId
			? { kind: "session_entry", sourceId: sessionEntryId }
			: { kind: "request_derived", sourceId: base.logicalSourceId };
		const identitySeed = `${provenance.kind}:${provenance.sourceId}`;
		const occurrence = (identityOccurrences.get(identitySeed) ?? 0) + 1;
		identityOccurrences.set(identitySeed, occurrence);
		const identity = `context:${sha256(identitySeed).slice(0, 24)}`;

		entries.push({
			id: occurrence === 1 ? identity : `${identity}:${occurrence}`,
			revision: base.revision,
			messageIndex,
			role: base.role,
			kind: base.kind,
			source: base.source,
			provenance,
			freshness: {
				observedAtTurn: options.turnIndex,
				sourceTimestamp: base.sourceTimestamp,
			},
		});
	}

	if (memo) {
		memo.clear();
		for (const [message, base] of liveMemoEntries) memo.set(message, base);
	}

	return {
		schemaVersion: CONTEXT_PROJECTION_SCHEMA_VERSION,
		revision: sha256(
			`${CONTEXT_PROJECTION_SCHEMA_VERSION}\n${entries.map((entry) => `${entry.id}:${entry.revision}`).join("\n")}`,
		),
		observedAtTurn: options.turnIndex,
		entries,
	};
}

export function emptyContextProjection(turnIndex: number): ContextProjection {
	return buildContextProjection([], { turnIndex });
}
