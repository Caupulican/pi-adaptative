/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import { completeSimple } from "@caupulican/pi-ai/stream";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@caupulican/pi-ai/types";
import { uuidv7 } from "@caupulican/pi-ai/uuid";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import { buildSessionContext, type CompactionEntry, type SessionEntry } from "../session/session-manager.ts";
import type { AgentMessage, StreamFn, ThinkingLevel } from "../types.ts";
import { addUsage, combineUsage, createEmptyUsage } from "../usage.ts";
import { type CompactionFacts, extractCompactionFacts, renderFactsBlock } from "./extraction.ts";
import {
	addPersistedFileOperations,
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	isPlainRecord,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";
import {
	buildRetryPrompt,
	CompactionVerificationError,
	deterministicallyFillSummaryGaps,
	isCompactionSummaryStructurallyUsable,
	type VerificationReport,
	verifySummary,
} from "./verification.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionVerificationCheckStats {
	failures: number;
	minScore?: number;
	maxScore?: number;
	threshold?: number;
	comparator?: "minimum" | "maximum";
}

export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
	verificationGateFailures?: number;
	verificationGateChecks?: Record<string, CompactionVerificationCheckStats>;
	deterministicGapFills?: number;
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if pi-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook field kept for session file compatibility
			addPersistedFileOperations(fileOps, prevCompaction.details as CompactionDetails);
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Provider usage spent generating this checkpoint, including chunk and verification retries. */
	usage?: Usage;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
	verification?: VerificationReport;
	verificationGateFailures?: VerificationReport[];
	deterministicGapFills?: number;
}

/** Host-owned provider boundary for shared compaction request enforcement and accounting. */
export type CompactionCompletion = (
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
) => Promise<AssistantMessage>;

/**
 * Carry failed LLM verification attempts into the result that the retry ladder eventually applies.
 * Only bounded numeric/check identifiers are persisted in details; raw facts stay in the in-memory reports.
 */
export function mergeCompactionVerificationReports(
	result: CompactionResult,
	reports: readonly VerificationReport[],
): CompactionResult {
	if (reports.length === 0) return result;

	const combinedReports = [
		...reports.map(cloneVerificationReport),
		...(result.verificationGateFailures ?? []).map(cloneVerificationReport),
	];
	result.verificationGateFailures = combinedReports;

	if (result.details === undefined || isPlainRecord(result.details)) {
		const details = result.details ?? {};
		result.details = {
			...details,
			verificationGateFailures: combinedReports.length,
			verificationGateChecks: aggregateVerificationChecks(combinedReports),
		};
	}

	return result;
}

function cloneVerificationReport(report: VerificationReport): VerificationReport {
	return {
		ok: report.ok,
		failures: report.failures.map((failure) => ({ ...failure })),
	};
}

function aggregateVerificationChecks(
	reports: readonly VerificationReport[],
): Record<string, CompactionVerificationCheckStats> {
	const checks = new Map<string, CompactionVerificationCheckStats>();
	for (const report of reports) {
		for (const failure of report.failures) {
			const current = checks.get(failure.check) ?? { failures: 0 };
			current.failures++;
			if (failure.score !== undefined && Number.isFinite(failure.score)) {
				current.minScore = Math.min(current.minScore ?? failure.score, failure.score);
				current.maxScore = Math.max(current.maxScore ?? failure.score, failure.score);
			}
			if (failure.threshold !== undefined && Number.isFinite(failure.threshold)) {
				current.threshold = failure.threshold;
			}
			if (failure.comparator) current.comparator = failure.comparator;
			checks.set(failure.check, current);
		}
	}
	return Object.fromEntries(checks);
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	/**
	 * Compaction also triggers once context exceeds this fraction of the model's window — not only when
	 * it's nearly full (`contextWindow - reserveTokens`). On large-window models, waiting until nearly
	 * full means every turn pays a huge input cost; a fractional cap keeps per-turn input bounded
	 * (cost guard). The effective trigger is the LOWER of the two, so small-window models keep the
	 * reserve-based behavior while large windows compact earlier. `0`/`1`+ disables the fractional cap.
	 */
	triggerPercent?: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	triggerPercent: 0.6,
};

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

/**
 * Find the newest assistant usage that still describes the current message prefix.
 *
 * Compaction can insert a newer summary before retained older messages. Usage recorded by an
 * assistant before that inserted message describes the pre-compaction prefix and must not anchor
 * the rebuilt context estimate. Walking forward lets the newest timestamp in the prefix invalidate
 * those stale usage blocks while still accepting the first response produced after compaction.
 */
export function getApplicableAssistantUsageInfo(
	messages: readonly AgentMessage[],
): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		const usage = getAssistantUsage(message);
		if (usage && message.timestamp >= latestPrefixTimestamp) {
			usageInfo = { usage, index: i };
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}

	return usageInfo;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages: readonly AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getApplicableAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * Minimum projected space saving for the EARLY (fractional) compaction trigger to fire. Anti-thrashing
 * (cost guard, #30): an early compaction whose summary would barely shrink the context (mostly recent,
 * protected content) just burns a summarization call for little gain — skip it and let the context grow
 * until either the saving is worthwhile or the hard (near-full) trigger forces it. Does NOT gate the
 * hard trigger, so overflow is always avoided.
 */
export const MIN_COMPACTION_SAVINGS = 0.12;

/**
 * Check if compaction should trigger based on context usage.
 *
 * Two triggers:
 * - HARD: context exceeds `contextWindow - reserveTokens` (near-full) or an explicit `triggerTokens`
 *   override — always compact (prevents overflow).
 * - EARLY (fractional, context-efficiency guard): context exceeds `contextWindow * triggerPercent` — compact only if
 *   the summary would actually save enough (`MIN_COMPACTION_SAVINGS`), so we don't thrash for tiny gains.
 */
export function shouldCompact(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
	triggerTokens?: number,
): boolean {
	if (!settings.enabled) return false;

	// Hard trigger: near-full, or a caller-supplied lower override. Always compacts (avoid overflow).
	const reserveTrigger = contextWindow - settings.reserveTokens;
	const hardTrigger = triggerTokens === undefined ? reserveTrigger : Math.min(reserveTrigger, triggerTokens);
	if (contextTokens > hardTrigger) return true;

	// Early fractional trigger: bounds per-turn input cost on large-window models, gated by anti-thrashing.
	const pct = settings.triggerPercent ?? 0;
	if (pct > 0 && pct < 1) {
		const fractionalTrigger = Math.floor(contextWindow * pct);
		if (contextTokens > fractionalTrigger) {
			// Projected saving ≈ the non-protected fraction (everything but the recent tail we keep).
			const projectedSavings = contextTokens > 0 ? 1 - settings.keepRecentTokens / contextTokens : 0;
			return projectedSavings >= MIN_COMPACTION_SAVINGS;
		}
	}
	return false;
}

// ============================================================================
// Cut point detection
// ============================================================================

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is a rough planning heuristic; code and structured text can be denser than 4 chars/token,
 * so callers that must stay under a provider bound need additional headroom.
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}

/**
 * Find valid cut points: indices of user, assistant, custom, or bashExecution messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 * BashExecutionMessage is treated like a user message (user-initiated context).
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
			case "session_info":
				break;
		}

		// branch_summary and custom_message are user-role messages, valid cut points
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the user message (or bashExecution) that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 * BashExecutionMessage is treated like a user message for turn boundaries.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		// branch_summary and custom_message are user-role messages, can start a turn
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		// Estimate this message's size
		const messageTokens = estimateTokens(entry.message);
		accumulatedTokens += messageTokens;

		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			// Find the closest valid cut point at or after this entry
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}

	// Scan backwards from cutIndex to include any non-message entries (bash, settings, etc.)
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at session header or compaction boundaries
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			// Stop if we hit any message
			break;
		}
		// Include this non-message entry (bash, settings change, etc.)
		cutIndex--;
	}

	// Determine if this is a split turn
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = `Checkpoint the conversation above. Format from your instructions, sections in this order:
## Active Task
### Mandatory Rules
## Working Set
## Files
## Open Problems
## Done
## Key Decisions
## Constraints & Preferences
## Critical Context

Do NOT carry resolved/transient errors, superseded approaches, or file contents. Record paths and intent, never bodies.

Verification checklist (the verifier checks exactly these channels; satisfy every listed include/drop demand):
<facts>
{FACTS_BLOCK}
</facts>

Budget: ~{BUDGET} tokens. Concrete beats complete.`;

const UPDATE_SUMMARIZATION_PROMPT = `Update the checkpoint in <previous-summary> with the NEW turns above. RULES:
- PRESERVE every existing ### Mandatory Rules bullet VERBATIM; append new ones.
- Continue the ## Done numbering. Keep the 15 most recent numbered items verbatim; compress everything older into the single first line "1. (earlier work compressed) <one line>". The checkpoint must not grow without bound across updates.
- Update ## Active Task to the newest unfulfilled user input; apply the cancellation rule.
- Keep ## Files current (add new, keep still-relevant, drop obsolete).
- Drop previous ## Open Problems resolved by the new turns.
- Drop ## Working Set files untouched since the previous checkpoint unless the active task references them.
- Preserve exact paths, commands, errors.
- Do NOT carry resolved/transient errors, superseded approaches, or file contents. Record paths and intent, never bodies.

Same section order. Verification checklist (the verifier checks exactly these channels; satisfy every listed include/drop demand):
<facts>
{FACTS_BLOCK}
</facts>

Budget: ~{BUDGET} tokens.`;

function createSummarizationOptions(
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
	// Summaries are one-shot prompts. A fresh affinity identity prevents them from contaminating the
	// foreground continuation cache, while "none" prevents cache writes that cannot be reused.
	const options: SimpleStreamOptions = {
		maxTokens,
		signal,
		apiKey,
		headers,
		cacheRetention: "none",
		sessionId: uuidv7(),
	};
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

async function completeSummarization(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
	completion?: CompactionCompletion,
): Promise<AssistantMessage> {
	if (completion) return completion(model, context, options);
	if (!streamFn) {
		return completeSimple(model, context, options);
	}
	const stream = await streamFn(model, context, options);
	return stream.result();
}

async function completeSummarizationPrompt(
	promptText: string,
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	streamFn: StreamFn | undefined,
	completion: CompactionCompletion | undefined,
	usage?: Usage,
	failureLabel = "Summarization",
): Promise<AssistantMessage> {
	const response = await completeSummarization(
		model,
		{
			systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: promptText }],
					timestamp: Date.now(),
				},
			],
		},
		createSummarizationOptions(model, maxTokens, apiKey, headers, signal, thinkingLevel),
		streamFn,
		completion,
	);
	if (usage) addUsage(usage, response.usage);
	if (response.stopReason === "error") {
		throw new Error(`${failureLabel} failed: ${response.errorMessage || "Unknown error"}`);
	}
	return response;
}

/**
 * Serialize messages to conversation text and, if a `preDigest` callback is supplied, run it
 * through that pass (a cheaper curation-model call that compresses older chunks — see
 * brain-curator.ts's `preDigestConversationText`; it makes real model completions, it is not a
 * local/mechanical transform). Split out of {@link generateSummary} so callers that summarize the
 * SAME message span more than once within one compaction attempt (the structurally-broken-summary
 * retry in `compact()`) can compute this ONCE and reuse the result via `generateSummary`'s
 * `precomputedConversationText` parameter, instead of re-running the pre-digest LLM calls (and
 * re-serializing) for an unchanged span on every retry.
 */
async function prepareSummarizationConversationText(
	currentMessages: AgentMessage[],
	preDigest?: (conversationText: string, signal?: AbortSignal) => Promise<string>,
	signal?: AbortSignal,
): Promise<string> {
	const llmMessages = convertToLlm(currentMessages);
	let conversationText = serializeConversation(llmMessages);
	if (preDigest) {
		try {
			conversationText = await preDigest(conversationText, signal);
		} catch {
			// Keep the verbatim conversation when an optional pre-digest fails.
		}
	}
	return conversationText;
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 *
 * @param precomputedConversationText - When provided, skips re-serializing `currentMessages` and
 *   re-running `preDigest` on them, using this text directly instead. For a caller that summarizes
 *   the same message span across multiple attempts (a verification-gate retry), compute this once
 *   via {@link prepareSummarizationConversationText} and pass it to every attempt.
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	preDigest?: (conversationText: string, signal?: AbortSignal) => Promise<string>,
	factsBlock = "verification demands:\nfiles-modified-recall (must appear in ## Files):\nfiles-read-recall (must appear as exact paths in ## Files, path recall threshold applies):\nworking-set-recall (must appear in ## Working Set):\nopen-errors-recall (must appear in ## Open Problems):\nactions-recall (must appear in ## Done):\nmandatory-rules-recall (must appear in ### Mandatory Rules):\nactive-task-containment (must appear in ## Active Task):\ncancelled-work-dropped (must NOT appear outside ### Mandatory Rules):",
	chunked = false,
	precomputedConversationText?: string,
	completion?: CompactionCompletion,
): Promise<string> {
	return (
		await generateSummaryWithUsage(
			currentMessages,
			model,
			reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			preDigest,
			factsBlock,
			chunked,
			precomputedConversationText,
			completion,
		)
	).text;
}

export async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	preDigest?: (conversationText: string, signal?: AbortSignal) => Promise<string>,
	factsBlock = "verification demands:\nfiles-modified-recall (must appear in ## Files):\nfiles-read-recall (must appear as exact paths in ## Files, path recall threshold applies):\nworking-set-recall (must appear in ## Working Set):\nopen-errors-recall (must appear in ## Open Problems):\nactions-recall (must appear in ## Done):\nmandatory-rules-recall (must appear in ### Mandatory Rules):\nactive-task-containment (must appear in ## Active Task):\ncancelled-work-dropped (must NOT appear outside ### Mandatory Rules):",
	chunked = false,
	precomputedConversationText?: string,
	completion?: CompactionCompletion,
): Promise<{ text: string; usage: Usage }> {
	const usage = createEmptyUsage();
	const summaryBudget = getSummaryBudget(reserveTokens, model, factsBlock);
	const maxTokens = summaryBudget;

	let promptSuffix = fillPromptTemplate(
		previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT,
		factsBlock,
		summaryBudget,
	);
	if (customInstructions) {
		promptSuffix = `${promptSuffix}\n\nAdditional focus: ${customInstructions}`;
	}

	let conversationText =
		precomputedConversationText !== undefined
			? precomputedConversationText
			: await prepareSummarizationConversationText(currentMessages, preDigest, signal);

	const inputBound = getSummarizerInputBound(model, maxTokens);
	const initialPromptText = buildSummarizationPrompt(conversationText, previousSummary, promptSuffix);
	if (estimateStringTokens(initialPromptText) > inputBound) {
		if (!chunked) {
			throw new Error("input-overflow: summarization request exceeds summarizer window");
		}
		conversationText = await summarizeChunks(
			conversationText,
			model,
			maxTokens,
			apiKey,
			headers,
			signal,
			thinkingLevel,
			streamFn,
			inputBound,
			previousSummary,
			promptSuffix,
			usage,
			completion,
		);
	}

	const promptText = buildSummarizationPrompt(conversationText, previousSummary, promptSuffix);
	if (estimateStringTokens(promptText) > inputBound) {
		throw new Error("input-overflow: chunked summarization merge still exceeds summarizer window");
	}
	const response = await completeSummarizationPrompt(
		promptText,
		model,
		maxTokens,
		apiKey,
		headers,
		signal,
		thinkingLevel,
		streamFn,
		completion,
		usage,
	);
	// A length-stopped checkpoint silently lost its tail sections — gating it as if complete
	// guarantees a verification failure. Fail loudly so the compaction ladder escalates instead.
	if (response.stopReason === "length") {
		throw new Error("summary-length-stop: summarizer hit its output cap before completing the checkpoint");
	}

	return { text: truncateSummaryToBudget(extractTextContent(response), summaryBudget), usage };
}

function fillPromptTemplate(template: string, factsBlock: string, budget: number): string {
	return template.replaceAll("{FACTS_BLOCK}", factsBlock).replaceAll("{BUDGET}", String(budget));
}

const SUMMARY_BUDGET_BASE_TOKENS = 1_500;
/** Worst-case selection assumption for summary output when exact bounded facts are not available. */
export const SUMMARY_BUDGET_MAX_TOKENS = 4_000;
/** Prompt-side margin beyond the raw conversation input (system prompt, tags, instructions). */
const SUMMARIZER_PROMPT_MARGIN_TOKENS = 2_000;

function getSummaryBudget(reserveTokens: number, model: Model<any>, factsBlock?: string): number {
	const modelMaxTokens = model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
	// Verification demand is bounded at extraction time, so the summary budget can be derived from
	// the actual gate demand instead of a blind hard cap. If the demanded facts cannot fit inside the
	// caller's reserve budget, deterministic compaction is the only honest path.
	const factsTokens = factsBlock ? estimateStringTokens(factsBlock) : 0;
	const gateDemandBudget = factsTokens + 500;
	const demandBudget = Math.max(SUMMARY_BUDGET_BASE_TOKENS, gateDemandBudget);
	const reserveBudget = Math.floor(0.8 * reserveTokens);
	if (factsTokens > reserveBudget || gateDemandBudget > modelMaxTokens) {
		throw new Error(
			`summary-demand-exceeds-reserve: required ${factsTokens} fact tokens, reserve budget ${reserveBudget}, model max ${modelMaxTokens}`,
		);
	}
	return Math.max(1, Math.min(demandBudget, modelMaxTokens));
}

function getEffectiveContextWindow(model: Model<any>): number {
	const registered = model.contextWindow > 0 ? model.contextWindow : Number.POSITIVE_INFINITY;
	const served = (model as { servedContextWindow?: unknown }).servedContextWindow;
	return typeof served === "number" && served > 0 ? Math.min(registered, served) : registered;
}

function getSummarizerInputBound(model: Model<any>, maxTokens: number): number {
	const contextWindow = getEffectiveContextWindow(model);
	return contextWindow === Number.POSITIVE_INFINITY
		? contextWindow
		: Math.max(1, contextWindow - maxTokens - SUMMARIZER_PROMPT_MARGIN_TOKENS);
}

/**
 * Whether a candidate summarizer can ingest a summarization input of the given size in ONE
 * request (unchunked), using the same window arithmetic as {@link getSummarizerInputBound} with
 * the worst-case (facts-scaled) summary budget. Hosts use this at SELECTION time: a model that
 * fails this must not be handed the job — chunking cannot rescue recall-gated summarization, and
 * local servers silently truncate over-window prompts instead of erroring.
 */
export function summarizerCanIngest(model: Model<any>, estimatedInputTokens: number): boolean {
	const contextWindow = getEffectiveContextWindow(model);
	if (contextWindow === Number.POSITIVE_INFINITY) return true;
	return estimatedInputTokens <= contextWindow - SUMMARY_BUDGET_MAX_TOKENS - SUMMARIZER_PROMPT_MARGIN_TOKENS;
}

function buildSummarizationPrompt(
	conversationText: string,
	previousSummary: string | undefined,
	promptSuffix: string,
): string {
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	return promptText + promptSuffix;
}

const CHUNK_SUMMARIZATION_HEADROOM_TOKENS = 1000;

export function getChunkSummarizationTokenBudget(inputBound: number): number {
	return Math.max(1, inputBound - CHUNK_SUMMARIZATION_HEADROOM_TOKENS);
}

export function buildChunkSummarizationPrompt(chunk: string, index: number, total: number): string {
	return `<conversation-chunk index="${index}" total="${total}">\n${chunk}\n</conversation-chunk>\n\nSummarize this chunk for a later checkpoint merge. Preserve exact file paths, commands, errors, user prohibitions, and active work. Output concise notes only.`;
}

async function summarizeChunks(
	conversationText: string,
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	streamFn: StreamFn | undefined,
	inputBound: number,
	previousSummary: string | undefined,
	promptSuffix: string,
	usage: Usage,
	completion: CompactionCompletion | undefined,
): Promise<string> {
	let reducedText = conversationText;
	for (let pass = 0; pass < 3; pass++) {
		const summary = await summarizeChunkPass(
			reducedText,
			model,
			maxTokens,
			apiKey,
			headers,
			signal,
			thinkingLevel,
			streamFn,
			inputBound,
			usage,
			completion,
		);
		if (estimateStringTokens(buildSummarizationPrompt(summary, previousSummary, promptSuffix)) <= inputBound) {
			return summary;
		}
		reducedText = summary;
	}
	throw new Error("input-overflow: chunked summarization merge still exceeds summarizer window");
}

async function summarizeChunkPass(
	conversationText: string,
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	streamFn: StreamFn | undefined,
	inputBound: number,
	usage: Usage,
	completion: CompactionCompletion | undefined,
): Promise<string> {
	const maxChunkTokens = getChunkSummarizationTokenBudget(inputBound);
	const maxChunkChars = Math.max(1, maxChunkTokens * 4);
	const chunks = splitText(conversationText, maxChunkChars);
	const summaries: string[] = [];

	for (let i = 0; i < chunks.length; i++) {
		const promptText = buildChunkSummarizationPrompt(chunks[i], i + 1, chunks.length);
		const response = await completeSummarizationPrompt(
			promptText,
			model,
			maxTokens,
			apiKey,
			headers,
			signal,
			thinkingLevel,
			streamFn,
			completion,
			usage,
		);
		summaries.push(extractTextContent(response));
	}

	return summaries.join("\n\n");
}

function splitText(text: string, maxChars: number): string[] {
	const chunks: string[] = [];
	for (let start = 0; start < text.length; start += maxChars) {
		chunks.push(text.slice(start, start + maxChars));
	}
	return chunks.length > 0 ? chunks : [""];
}

function extractTextContent(message: AssistantMessage): string {
	return message.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

function truncateSummaryToBudget(summary: string, budget: number): string {
	const maxTokens = Math.floor(budget * 1.3);
	if (estimateStringTokens(summary) <= maxTokens) {
		return summary;
	}

	let current = summary;
	// Never drop "Files" or "Done" here: the verification gate checks exactly those sections
	// (files-modified/read-recall, actions-overlap), so deleting them guarantees gate failure.
	for (const heading of ["Critical Context", "Blocked / Open", "Key Decisions", "Constraints & Preferences"]) {
		const next = removeSummarySection(current, heading);
		if (next === current) {
			continue;
		}
		current = next;
		if (estimateStringTokens(current) <= maxTokens) {
			return current;
		}
	}
	return current;
}

function removeSummarySection(summary: string, heading: string): string {
	const lines = summary.split(/\r?\n/);
	const kept: string[] = [];
	let skipping = false;
	for (const line of lines) {
		const match = /^(?:##|###)\s+(.+?)\s*$/.exec(line);
		if (match) {
			skipping = match[1].trim().toLowerCase() === heading.toLowerCase();
			if (skipping) {
				continue;
			}
		}
		if (!skipping) {
			kept.push(line);
		}
	}
	return kept.join("\n").trim();
}

export function estimateStringTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// ============================================================================
// Compaction Preparation (for extensions)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Facts extracted from the compacted span for verification gating */
	facts?: CompactionFacts;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	options?: { allowTrailingCompactionAsPrevious?: boolean },
): CompactionPreparation | undefined {
	const trailingEntry = pathEntries[pathEntries.length - 1];
	if (trailingEntry?.type === "compaction" && !options?.allowTrailingCompactionAsPrevious) {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd =
		options?.allowTrailingCompactionAsPrevious && pathEntries[pathEntries.length - 1]?.type === "compaction"
			? pathEntries.length - 1
			: pathEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	// Get UUID of first kept entry
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// Messages to summarize (will be discarded after summary)
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	// Messages for turn prefix summary (if splitting a turn)
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// Extract file operations from messages and previous compaction
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	const facts = extractCompactionFacts(pathEntries, boundaryStart, boundaryEnd);

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		facts,
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

interface VerifiedSummaryResult {
	summary: string;
	usage: Usage;
	verification: VerificationReport;
	verificationGateFailures: VerificationReport[];
	deterministicGapFills: number;
}

async function generateVerifiedSummary(options: {
	messages: AgentMessage[];
	model: Model<any>;
	reserveTokens: number;
	apiKey: string | undefined;
	headers: Record<string, string> | undefined;
	signal: AbortSignal | undefined;
	customInstructions: string | undefined;
	previousSummary: string | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	streamFn: StreamFn | undefined;
	completion: CompactionCompletion | undefined;
	preDigest: ((conversationText: string, signal?: AbortSignal) => Promise<string>) | undefined;
	facts: CompactionFacts;
	factsBlock: string;
	chunked: boolean;
}): Promise<VerifiedSummaryResult> {
	let retryInstructions = options.customInstructions;
	const usage = createEmptyUsage();
	const verificationGateFailures: VerificationReport[] = [];
	const precomputedConversationText = await prepareSummarizationConversationText(
		options.messages,
		options.preDigest,
		options.signal,
	);

	for (let attempt = 0; attempt < 2; attempt++) {
		const generated = await generateSummaryWithUsage(
			options.messages,
			options.model,
			options.reserveTokens,
			options.apiKey,
			options.headers,
			options.signal,
			retryInstructions,
			options.previousSummary,
			options.thinkingLevel,
			options.streamFn,
			options.preDigest,
			options.factsBlock,
			options.chunked,
			precomputedConversationText,
			options.completion,
		);
		addUsage(usage, generated.usage);
		const summary = generated.text;
		const verification = verifySummary(summary, options.facts);
		if (verification.ok) {
			return { summary, usage, verification, verificationGateFailures, deterministicGapFills: 0 };
		}

		verificationGateFailures.push(verification);
		if (!isCompactionSummaryStructurallyUsable(summary)) {
			if (attempt >= 1) throw new CompactionVerificationError(verificationGateFailures);
			retryInstructions = buildRetryPrompt(verification, summary);
			continue;
		}

		const filled = deterministicallyFillSummaryGaps(summary, options.facts);
		if (filled.verification.ok) {
			return {
				summary: filled.summary,
				usage,
				verification: filled.verification,
				verificationGateFailures,
				deterministicGapFills: filled.changed ? 1 : 0,
			};
		}

		throw new CompactionVerificationError(verificationGateFailures);
	}

	throw new CompactionVerificationError(verificationGateFailures);
}

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	preDigest?: (conversationText: string, signal?: AbortSignal) => Promise<string>,
	executionOptions?: { chunked?: boolean; completion?: CompactionCompletion },
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
		facts: factsFromPreparation,
	} = preparation;

	const facts = factsFromPreparation ?? {
		files: [],
		workingSet: [],
		actions: [],
		errorFacts: [],
		prohibitions: [],
		cancelledText: "",
		activeTaskSource: "",
		delegatedWorkerFacts: [],
	};
	const factsBlock = renderFactsBlock(facts);
	const verified =
		isSplitTurn && messagesToSummarize.length === 0
			? undefined
			: await generateVerifiedSummary({
					messages: messagesToSummarize,
					model,
					reserveTokens: settings.reserveTokens,
					apiKey,
					headers,
					signal,
					customInstructions,
					previousSummary,
					thinkingLevel,
					streamFn,
					completion: executionOptions?.completion,
					preDigest,
					facts,
					factsBlock,
					chunked: executionOptions?.chunked ?? false,
				});

	let summary = verified?.summary ?? "No prior history.";
	let summaryUsage = verified?.usage;
	if (isSplitTurn) {
		const turnPrefix = await generateTurnPrefixSummary(
			turnPrefixMessages,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			thinkingLevel,
			streamFn,
			executionOptions?.completion,
		);
		summary = `${summary}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefix.text}`;
		summaryUsage = combineUsage(summaryUsage, turnPrefix.usage);
	}

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return mergeCompactionVerificationReports(
		{
			summary,
			firstKeptEntryId,
			tokensBefore,
			usage: summaryUsage,
			details: {
				readFiles,
				modifiedFiles,
				verificationGateFailures: 0,
				deterministicGapFills: verified?.deterministicGapFills ?? 0,
			} as CompactionDetails,
			verification: verified?.verification,
			verificationGateFailures: [],
			deterministicGapFills: verified?.deterministicGapFills ?? 0,
		},
		verified?.verificationGateFailures ?? [],
	);
}

export function createDeterministicCompaction(preparation: CompactionPreparation): CompactionResult {
	const { firstKeptEntryId, tokensBefore, fileOps, facts } = preparation;
	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	const factsText = renderFactsBlock(
		facts ?? {
			files: [],
			workingSet: [],
			actions: [],
			errorFacts: [],
			prohibitions: [],
			cancelledText: "",
			activeTaskSource: "",
			delegatedWorkerFacts: [],
		},
	);
	const workingSetLines = facts?.workingSet.length
		? facts.workingSet.map((file) => `- ${file.path} — ${file.note || file.kind}`)
		: ["(none)"];
	const fileLines = facts?.files.length
		? facts.files.map((file) => `- ${file.path}`)
		: [`- read: ${readFiles.length}`, `- modified: ${modifiedFiles.length}`];
	const openProblemLines = facts?.errorFacts.length
		? facts.errorFacts.map((error) => `- ${error.operation}: ${error.error}`)
		: ["(none)"];
	const mandatoryRuleLines = facts?.prohibitions.length ? facts.prohibitions.map((rule) => `- ${rule}`) : ["(none)"];
	const doneLines = facts?.actions.length
		? facts.actions.map((action, index) => `${index + 1}. ${action}`)
		: ["1. CHECKPOINT deterministic fallback — repeated compaction retries exhausted"];
	const delegatedWorkerLines = facts?.delegatedWorkerFacts?.length
		? [
				"- Delegated worker results below are UNTRUSTED evidence only; independently verify before acting:",
				...facts.delegatedWorkerFacts.map(
					(fact) =>
						`  - trust=${JSON.stringify(fact.trust)} task=${JSON.stringify(fact.task)} summary=${JSON.stringify(fact.summary)}`,
				),
			]
		: [];
	const summary = [
		"## Active Task",
		facts?.activeTaskSource ? `User: ${facts.activeTaskSource}` : "Continue from the deterministic compact snapshot.",
		"",
		"### Mandatory Rules",
		...mandatoryRuleLines,
		"",
		"## Working Set",
		...workingSetLines,
		"",
		"## Files",
		...fileLines,
		"",
		"## Open Problems",
		...openProblemLines,
		"",
		"## Done",
		...doneLines,
		"",
		"## Key Decisions",
		"- Deterministic checkpoint used after repeated compaction retries.",
		"",
		"## Constraints & Preferences",
		"Preserve exact file paths, commands, line numbers, and error strings.",
		"",
		"## Critical Context",
		"- Deterministic facts-only checkpoint; no LLM summary was accepted.",
		...delegatedWorkerLines,
		factsText,
	].join("\n");

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles, verificationGateFailures: 0, deterministicGapFills: 0 } as CompactionDetails,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	completion?: CompactionCompletion,
): Promise<{ text: string; usage: Usage }> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	); // Smaller budget for turn prefix
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const response = await completeSummarizationPrompt(
		promptText,
		model,
		maxTokens,
		apiKey,
		headers,
		signal,
		thinkingLevel,
		streamFn,
		completion,
		undefined,
		"Turn prefix summarization",
	);

	return {
		text: response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n"),
		usage: response.usage,
	};
}
