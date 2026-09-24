import type { SessionEntry } from "@caupulican/pi-agent-core/session";
import type { AgentToolCall } from "@caupulican/pi-agent-core/types";
import type { AssistantMessage } from "@caupulican/pi-ai";
import type { SessionEntryIndex } from "../session-entry-index.ts";

export const SELF_COMPACT_TOOL_NAME = "self_compact";
export const SELF_COMPACTION_GUIDANCE_CUSTOM_TYPE = "self_compaction_guidance";
export const SELF_COMPACTION_REQUEST_CUSTOM_TYPE = "self_compaction_request";
export const SELF_COMPACTION_HANDOFF_CUSTOM_TYPE = "self_compaction_handoff";
export const SELF_COMPACTION_ABANDONED_CUSTOM_TYPE = "self_compaction_abandoned";
export const SELF_COMPACTION_OWNER_REQUEST_CUSTOM_TYPE = "self_compaction_owner_request";
export const SELF_COMPACTION_NOTE_MAX_CHARS = 24_000;
export const SELF_COMPACTION_MAX_ATTEMPTS = 3;

export const SELF_COMPACTION_PROMPT_KINDS = ["notice", "warning", "summary"] as const;
export type SelfCompactionPromptKind = (typeof SELF_COMPACTION_PROMPT_KINDS)[number];
export type SelfCompactionPrompts = Readonly<Partial<Record<SelfCompactionPromptKind, string>>>;
export const SELF_COMPACTION_PROMPT_MAX_CHARS = 8_000;

export const SELF_COMPACTION_TEMPLATE_KEYS = [
	"used_tokens",
	"used_percent",
	"context_window",
	"notice_tokens",
	"warning_tokens",
	"forced_tokens",
	"hard_tokens",
	"early_tokens",
	"tokens_until_warning",
	"tokens_until_forced",
	"cycle",
	"note_max_chars",
] as const;
export type SelfCompactionTemplateKey = (typeof SELF_COMPACTION_TEMPLATE_KEYS)[number];
export type SelfCompactionTemplateValues = Readonly<Record<SelfCompactionTemplateKey, string>>;

const TEMPLATE_PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

export interface SelfCompactionSettings {
	readonly enabled: boolean;
	readonly notice: number;
	readonly warning: number;
	readonly forced: number;
	readonly prompts: SelfCompactionPrompts;
	readonly error?: string;
}

export const DEFAULT_SELF_COMPACTION_SETTINGS: SelfCompactionSettings = {
	enabled: true,
	notice: 0.7,
	warning: 0.85,
	forced: 0.95,
	prompts: {},
};

function promptsError(raw: unknown): string | undefined {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return "compaction.selfMonitor.prompts must be an object with optional notice, warning and summary strings";
	}
	for (const [kind, text] of Object.entries(raw)) {
		if (!(SELF_COMPACTION_PROMPT_KINDS as readonly string[]).includes(kind)) {
			return `compaction.selfMonitor.prompts.${kind} is not a prompt; use ${SELF_COMPACTION_PROMPT_KINDS.join(", ")}`;
		}
		if (typeof text !== "string" || text.trim().length === 0 || text.length > SELF_COMPACTION_PROMPT_MAX_CHARS) {
			return `compaction.selfMonitor.prompts.${kind} must be non-blank text of at most ${SELF_COMPACTION_PROMPT_MAX_CHARS} characters`;
		}
		const unknown = [...text.matchAll(TEMPLATE_PLACEHOLDER)]
			.map((match) => match[1]!)
			.filter((key) => !(SELF_COMPACTION_TEMPLATE_KEYS as readonly string[]).includes(key));
		if (unknown.length > 0) {
			return `compaction.selfMonitor.prompts.${kind} uses unknown placeholders ${[...new Set(unknown)].map((key) => `{{${key}}}`).join(", ")}; known: ${SELF_COMPACTION_TEMPLATE_KEYS.join(", ")}`;
		}
	}
	return undefined;
}

export function renderSelfCompactionTemplate(text: string, values: SelfCompactionTemplateValues): string {
	return text.replace(TEMPLATE_PLACEHOLDER, (whole, key: string) =>
		key in values ? values[key as SelfCompactionTemplateKey] : whole,
	);
}

export function resolveSelfCompactionSettings(raw: {
	enabled?: unknown;
	notice?: unknown;
	warning?: unknown;
	forced?: unknown;
	prompts?: unknown;
}): SelfCompactionSettings {
	const pick = (value: unknown, fallback: number) => (value === undefined ? fallback : value);
	const notice = pick(raw.notice, DEFAULT_SELF_COMPACTION_SETTINGS.notice);
	const warning = pick(raw.warning, DEFAULT_SELF_COMPACTION_SETTINGS.warning);
	const forced = pick(raw.forced, DEFAULT_SELF_COMPACTION_SETTINGS.forced);
	const fraction = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
	let error: string | undefined;
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
		error = "compaction.selfMonitor.enabled must be true or false";
	} else if (![notice, warning, forced].every(fraction)) {
		error =
			"compaction.selfMonitor notice and warning must be fractions in (0, 1] of the first compaction trigger, and forced a fraction in (0, 1] of the hard trigger";
	} else if ((notice as number) > (warning as number)) {
		error = "compaction.selfMonitor must satisfy notice <= warning";
	} else {
		error = promptsError(raw.prompts);
	}
	if (error) return { ...DEFAULT_SELF_COMPACTION_SETTINGS, enabled: false, error };
	return {
		enabled: raw.enabled === undefined ? DEFAULT_SELF_COMPACTION_SETTINGS.enabled : raw.enabled === true,
		notice: notice as number,
		warning: warning as number,
		forced: forced as number,
		prompts: { ...((raw.prompts as SelfCompactionPrompts | undefined) ?? {}) },
	};
}

export type SelfCompactionLevel = "unknown" | "idle" | "notice" | "warning" | "forced";

export interface SelfCompactionThresholds {
	readonly contextWindow: number;
	readonly hardTokens: number;
	readonly earlyTokens: number | null;
	readonly noticeTokens: number;
	readonly warningTokens: number;
	readonly forcedTokens: number;
}

export function resolveSelfCompactionThresholds(
	contextWindow: number,
	hardTokens: number | undefined,
	earlyTokens: number | undefined,
	settings: SelfCompactionSettings,
): SelfCompactionThresholds | undefined {
	if (!settings.enabled || !(contextWindow > 0) || hardTokens === undefined || !(hardTokens > 0)) return undefined;
	const early = earlyTokens !== undefined && earlyTokens > 0 && earlyTokens < hardTokens ? earlyTokens : undefined;
	const firstTrigger = early ?? hardTokens;
	const noticeTokens = Math.floor(firstTrigger * settings.notice);
	const warningTokens = Math.floor(firstTrigger * settings.warning);
	return {
		contextWindow,
		hardTokens,
		earlyTokens: early ?? null,
		noticeTokens,
		warningTokens,
		forcedTokens: Math.max(warningTokens, Math.floor(hardTokens * settings.forced)),
	};
}

export function selfCompactionLevel(
	tokens: number | null | undefined,
	thresholds: SelfCompactionThresholds | undefined,
): SelfCompactionLevel {
	if (!thresholds || tokens === null || tokens === undefined || !Number.isFinite(tokens)) return "unknown";
	if (tokens >= thresholds.forcedTokens) return "forced";
	if (tokens >= thresholds.warningTokens) return "warning";
	if (tokens >= thresholds.noticeTokens) return "notice";
	return "idle";
}

const LEVEL_RANK: Readonly<Record<SelfCompactionLevel, number>> = {
	unknown: -1,
	idle: 0,
	notice: 1,
	warning: 2,
	forced: 3,
};

export function isSelfCompactionLevelAtLeast(level: SelfCompactionLevel, floor: SelfCompactionLevel): boolean {
	return LEVEL_RANK[level] >= LEVEL_RANK[floor];
}

const NOTE_CONTENTS =
	"goal, done work with exact paths and commands, in-progress state, key decisions, verified results, and the exact NEXT ACTION as the last line";

function formatTokens(tokens: number): string {
	return tokens.toLocaleString("en-US");
}

export function selfCompactionTemplateValues(
	thresholds: SelfCompactionThresholds,
	usedTokens: number | null,
	cycles: number,
): SelfCompactionTemplateValues {
	const count = (tokens: number | null) => (tokens === null ? "unknown" : formatTokens(tokens));
	return {
		used_tokens: count(usedTokens),
		used_percent: usedTokens === null ? "unknown" : `${((usedTokens / thresholds.contextWindow) * 100).toFixed(1)}%`,
		context_window: formatTokens(thresholds.contextWindow),
		notice_tokens: formatTokens(thresholds.noticeTokens),
		warning_tokens: formatTokens(thresholds.warningTokens),
		forced_tokens: formatTokens(thresholds.forcedTokens),
		hard_tokens: formatTokens(thresholds.hardTokens),
		early_tokens: thresholds.earlyTokens === null ? "off" : formatTokens(thresholds.earlyTokens),
		tokens_until_warning: count(usedTokens === null ? null : Math.max(0, thresholds.warningTokens - usedTokens)),
		tokens_until_forced: count(usedTokens === null ? null : Math.max(0, thresholds.forcedTokens - usedTokens)),
		cycle: String(cycles),
		note_max_chars: formatTokens(SELF_COMPACTION_NOTE_MAX_CHARS),
	};
}

export function selfCompactionGuidance(
	level: SelfCompactionLevel,
	thresholds: SelfCompactionThresholds,
	prompts: SelfCompactionPrompts = {},
	values?: SelfCompactionTemplateValues,
): string | undefined {
	if ((level === "notice" || level === "warning") && prompts[level] !== undefined) {
		return renderSelfCompactionTemplate(prompts[level], values ?? selfCompactionTemplateValues(thresholds, null, 0));
	}
	const host =
		thresholds.earlyTokens === null
			? `the host compacts on its own at ${formatTokens(thresholds.hardTokens)}`
			: `the host may compact on its own from ${formatTokens(thresholds.earlyTokens)} when that is cheaper and always at ${formatTokens(thresholds.hardTokens)}`;
	const lines = `notice ${formatTokens(thresholds.noticeTokens)}, warning ${formatTokens(thresholds.warningTokens)}, forced ${formatTokens(thresholds.forcedTokens)} tokens of a ${formatTokens(thresholds.contextWindow)}-token window; ${host}`;
	switch (level) {
		case "notice":
			return `[self-compaction · notice] Context passed the notice line (${lines}). Nothing is required; keep working. At a clean checkpoint you may call ${SELF_COMPACT_TOOL_NAME} with note_to_self (${NOTE_CONTENTS}). Call ${SELF_COMPACT_TOOL_NAME} without a note for live numbers.`;
		case "warning":
			return `[self-compaction · warning] Context passed the warning line (${lines}). Finish only the current atomic step, then call ${SELF_COMPACT_TOOL_NAME} with note_to_self (${NOTE_CONTENTS}). At the forced line every tool except ${SELF_COMPACT_TOOL_NAME} is refused.`;
		case "forced":
			return `[self-compaction · forced] Context reached the forced line (${lines}). Every tool except ${SELF_COMPACT_TOOL_NAME} is refused until the context is compacted. Write note_to_self (${NOTE_CONTENTS}) and call ${SELF_COMPACT_TOOL_NAME} now.`;
		default:
			return undefined;
	}
}

export const SELF_COMPACTION_GUIDANCE_CLEARED_TEXT =
	"[self-compaction] Context is below the notice line; no self-compaction action is needed.";

export const SELF_COMPACTION_SUMMARY_INSTRUCTIONS =
	"The agent wrote its own note_to_self before this compaction. The note is delivered verbatim as the next message after this summary; do not reproduce or replace it. Summarize everything else the agent needs to continue, keeping pending work pending.";

export const SELF_COMPACTION_OWNER_REQUEST_TEXT = `[self-compaction · owner request] The owner asked you to compact now. Finish only the current atomic step, then write note_to_self (${NOTE_CONTENTS}) and call ${SELF_COMPACT_TOOL_NAME} as your only tool call.`;

export function selfCompactionPromptSource(settings: SelfCompactionSettings, kind: SelfCompactionPromptKind): string {
	return settings.prompts[kind] === undefined ? "built-in" : `settings (compaction.selfMonitor.prompts.${kind})`;
}

export interface SelfCompactionRequestRecord {
	readonly id: string;
	readonly note: string;
	readonly requestedAt: string;
	readonly level: SelfCompactionLevel;
	readonly tokens: number | null;
}

export type SelfCompactionStatus = "none" | "pending" | "compacted" | "delivered" | "answered" | "abandoned";

export interface SelfCompactionState {
	readonly status: SelfCompactionStatus;
	readonly request?: SelfCompactionRequestRecord;
	readonly attempts: number;
	readonly lastError?: string;
	readonly cycles: number;
	readonly ownerRequested: boolean;
}

const NO_REQUEST: SelfCompactionState = { status: "none", attempts: 0, cycles: 0, ownerRequested: false };

const MAX_HANDOFF_ID_CHARS = 128;
const RECORD_LEVELS: ReadonlySet<unknown> = new Set(["unknown", "idle", "notice", "warning", "forced"]);

function isRequestRecord(value: unknown): value is SelfCompactionRequestRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<Record<keyof SelfCompactionRequestRecord, unknown>>;
	return (
		typeof record.id === "string" &&
		record.id.length > 0 &&
		record.id.length <= MAX_HANDOFF_ID_CHARS &&
		validateSelfCompactionNote(record.note).ok &&
		typeof record.requestedAt === "string" &&
		Number.isFinite(Date.parse(record.requestedAt)) &&
		RECORD_LEVELS.has(record.level) &&
		(record.tokens === null || (typeof record.tokens === "number" && Number.isFinite(record.tokens)))
	);
}

function handoffIdOf(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const id = (value as { handoffId?: unknown }).handoffId;
	return typeof id === "string" ? id : undefined;
}

function compactionHandoffId(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined;
	return handoffIdOf((details as { selfCompaction?: unknown }).selfCompaction);
}

export function applySelfCompactionEntry(state: SelfCompactionState, entry: SessionEntry): SelfCompactionState {
	if (entry.type === "custom" && entry.customType === SELF_COMPACTION_REQUEST_CUSTOM_TYPE) {
		return isRequestRecord(entry.data)
			? { status: "pending", request: entry.data, attempts: 0, cycles: state.cycles, ownerRequested: false }
			: state;
	}
	if (entry.type === "custom_message" && entry.customType === SELF_COMPACTION_OWNER_REQUEST_CUSTOM_TYPE) {
		return isActiveSelfCompactionStatus(state.status) ? state : { ...state, ownerRequested: true };
	}
	const request = state.request;
	if (
		entry.type === "compaction" &&
		!(state.status === "pending" && compactionHandoffId(entry.details) === request?.id)
	) {
		return state.ownerRequested ? { ...state, ownerRequested: false } : state;
	}
	if (
		state.ownerRequested &&
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		entry.message.stopReason !== "toolUse" &&
		entry.message.stopReason !== "error"
	) {
		return { ...state, ownerRequested: false };
	}
	if (!request) return state;
	if (entry.type === "custom" && entry.customType === SELF_COMPACTION_ABANDONED_CUSTOM_TYPE) {
		return handoffIdOf(entry.data) === request.id && state.status !== "answered"
			? { ...state, status: "abandoned" }
			: state;
	}
	switch (state.status) {
		case "pending":
			if (entry.type === "compaction" && compactionHandoffId(entry.details) === request.id) {
				return { ...state, status: "compacted", cycles: state.cycles + 1, lastError: undefined };
			}
			if (entry.type === "compaction_end" && (entry.outcome === "failure" || entry.outcome === "cancelled")) {
				return {
					...state,
					attempts: state.attempts + 1,
					lastError:
						entry.outcome === "cancelled" ? "compaction was cancelled" : (entry.error ?? "compaction failed"),
				};
			}
			return state;
		case "compacted":
			if (
				entry.type === "custom_message" &&
				entry.customType === SELF_COMPACTION_HANDOFF_CUSTOM_TYPE &&
				handoffIdOf(entry.details) === request.id
			) {
				return { ...state, status: "delivered" };
			}
			return state;
		case "delivered":
			if (entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason !== "error") {
				return { ...state, status: "answered" };
			}
			return state;
		default:
			return state;
	}
}

export function deriveSelfCompactionState(branch: readonly SessionEntry[]): SelfCompactionState {
	let state = NO_REQUEST;
	for (const entry of branch) state = applySelfCompactionEntry(state, entry);
	return state;
}

export class SelfCompactionStateScan {
	private remembered: { leafId: string; state: SelfCompactionState } | undefined;

	reset(): void {
		this.remembered = undefined;
	}

	find(index: SessionEntryIndex): SelfCompactionState {
		const leafId = index.leafId;
		if (leafId === null) {
			this.remembered = undefined;
			return NO_REQUEST;
		}
		const remembered = this.remembered;
		if (remembered?.leafId === leafId) return remembered.state;
		const appended: SessionEntry[] = [];
		let entry = index.getEntry(leafId);
		let base: SelfCompactionState | undefined;
		while (entry) {
			if (remembered && entry.id === remembered.leafId) {
				base = remembered.state;
				break;
			}
			appended.push(entry);
			entry = entry.parentId === null ? undefined : index.getEntry(entry.parentId);
		}
		let state = base ?? NO_REQUEST;
		for (let position = appended.length - 1; position >= 0; position--) {
			state = applySelfCompactionEntry(state, appended[position]!);
		}
		this.remembered = { leafId, state };
		return state;
	}
}

export function isActiveSelfCompactionStatus(status: SelfCompactionStatus): boolean {
	return status === "pending" || status === "compacted" || status === "delivered";
}

export type SelfCompactionNoteValidation = { ok: true; note: string } | { ok: false; reason: string };

export function validateSelfCompactionNote(value: unknown): SelfCompactionNoteValidation {
	if (typeof value !== "string" || value.trim().length === 0) {
		return {
			ok: false,
			reason: `note_to_self must be a non-blank string: ${NOTE_CONTENTS}.`,
		};
	}
	if (value.length > SELF_COMPACTION_NOTE_MAX_CHARS) {
		return {
			ok: false,
			reason: `note_to_self is ${value.length.toLocaleString("en-US")} characters; the limit is ${SELF_COMPACTION_NOTE_MAX_CHARS.toLocaleString("en-US")}. Shorten it and call ${SELF_COMPACT_TOOL_NAME} again.`,
		};
	}
	return { ok: true, note: value };
}

export function batchSelfCompactCalls(assistantMessage: AssistantMessage): AgentToolCall[] {
	return assistantMessage.content.filter(
		(block): block is AgentToolCall => block.type === "toolCall" && block.name === SELF_COMPACT_TOOL_NAME,
	);
}

export function batchSelfCompactionNote(assistantMessage: AssistantMessage): string | undefined {
	for (const call of batchSelfCompactCalls(assistantMessage)) {
		const note = (call.arguments as { note_to_self?: unknown } | undefined)?.note_to_self;
		if (validateSelfCompactionNote(note).ok) return note as string;
	}
	return undefined;
}
