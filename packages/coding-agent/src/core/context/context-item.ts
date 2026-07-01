/**
 * Pure, provider-free context contracts.
 *
 * These types describe the curated working state the prompt builder will eventually
 * consume, distinct from the immutable session transcript. Adding this module makes no
 * behavior change: nothing here is wired into prompt construction yet.
 */

export type ContextItemKind =
	| "user_instruction"
	| "approval"
	| "denial"
	| "safety_constraint"
	| "goal_state"
	| "requirement"
	| "plan"
	| "blocker"
	| "evidence"
	| "invalidated_assumption"
	| "tool_output"
	| "tool_output_digest"
	| "file_snapshot"
	| "diff_summary"
	| "test_result"
	| "conversation_tail"
	| "retrieved_artifact"
	| "memory_item"
	| "memory_digest";

export type ContextRetentionClass = "pinned" | "active" | "decision_bearing" | "useful" | "ephemeral" | "expired";

export type ContextSource = "user" | "assistant" | "tool" | "runtime" | "session" | "memory" | "external_provider";

export interface ContextArtifactRef {
	id: string;
	kind: "tool_output" | "file_snapshot" | "test_output" | "diff" | "transcript_slice";
	storagePath?: string;
	sessionEntryId?: string;
	toolName?: string;
	command?: string;
	path?: string;
	byteLength: number;
	lineCount?: number;
	createdAtTurn: number;
	reproducible: boolean;
}

export type MemoryScope = "session" | "project" | "user" | "global";

export interface ContextMemoryRef {
	providerId: string;
	itemId: string;
	scope: MemoryScope;
	kind: string;
	uri?: string;
}

export interface ContextTranscriptRef {
	sessionEntryId: string;
	branchId?: string;
	messageIndex?: number;
}

export type ContextEvidenceRef =
	| { type: "artifact"; ref: ContextArtifactRef }
	| { type: "memory"; ref: ContextMemoryRef }
	| { type: "transcript"; ref: ContextTranscriptRef }
	| { type: "runtime"; id: string; description: string };

export interface ContextItem {
	id: string;
	kind: ContextItemKind;
	retentionClass: ContextRetentionClass;
	source: ContextSource;
	createdAtTurn: number;
	lastUsedAtTurn?: number;
	summary?: string;
	content?: string;
	primaryRef?: ContextEvidenceRef;
	evidenceRefs?: ContextEvidenceRef[];
	tokenEstimate: number;
	byteEstimate: number;
	supersededBy?: string;
	invalidates?: string[];
	pinReason?: string;
	expiresAfterGoalId?: string;
}

export interface InvalidatedAssumptionItem {
	id: string;
	kind: "invalidated_assumption";
	retentionClass: "decision_bearing" | "useful";
	summary: string;
	reason: string;
	evidenceRefs: ContextEvidenceRef[];
	expiresAfterGoalId?: string;
}

export type ModelRetentionAction =
	| { action: "keep"; itemId: string; reason: string }
	| { action: "summarize"; itemId: string; summary: string; reason: string; evidenceRefs?: ContextEvidenceRef[] }
	| { action: "drop_from_prompt"; itemId: string; reason: string }
	| { action: "invalidate"; itemId: string; summary: string; reason: string; evidenceRefs: ContextEvidenceRef[] }
	| { action: "pin_request"; itemId: string; reason: string };

/**
 * Kinds that are hard-retained regardless of retentionClass: their semantics must remain
 * present in prompt context per the contracts-and-retention.md hard retention rules.
 */
export const HARD_RETAINED_CONTEXT_KINDS: ReadonlySet<ContextItemKind> = new Set([
	"user_instruction",
	"approval",
	"denial",
	"safety_constraint",
]);

const NO_TOKENIZER_CHARS_PER_TOKEN = 4;

/** UTF-8 byte length, matching how the runtime measures raw payload size elsewhere. */
export function estimateByteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

export function estimateLineCount(text: string): number {
	return text.length === 0 ? 0 : text.split("\n").length;
}

/**
 * No-tokenizer sizing rule from policy-engine-spec.md: estimatedTokens = ceil(chars / 4).
 * Calibrate against provider-reported usage post-call; never treat this as semantic criticality.
 */
export function estimateTokensFromChars(charCount: number): number {
	return Math.ceil(Math.max(0, charCount) / NO_TOKENIZER_CHARS_PER_TOKEN);
}

export function estimateTokensFromText(text: string): number {
	return estimateTokensFromChars(text.length);
}
