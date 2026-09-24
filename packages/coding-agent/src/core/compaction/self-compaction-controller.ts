import { randomUUID } from "node:crypto";
import type { BeforeToolCallResult } from "@caupulican/pi-agent-core";
import { AgentBusyError } from "@caupulican/pi-agent-core/agent";
import type { SessionManager } from "@caupulican/pi-agent-core/session";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { Type } from "typebox";
import type { ContextUsage, ToolDefinition } from "../extensions/types.ts";
import { resolveSessionEntryIndex } from "../session-entry-index.ts";
import {
	batchSelfCompactionNote,
	deriveSelfCompactionState,
	isActiveSelfCompactionStatus,
	isSelfCompactionLevelAtLeast,
	renderSelfCompactionTemplate,
	resolveSelfCompactionThresholds,
	SELF_COMPACT_TOOL_NAME,
	SELF_COMPACTION_ABANDONED_CUSTOM_TYPE,
	SELF_COMPACTION_GUIDANCE_CLEARED_TEXT,
	SELF_COMPACTION_HANDOFF_CUSTOM_TYPE,
	SELF_COMPACTION_MAX_ATTEMPTS,
	SELF_COMPACTION_NOTE_MAX_CHARS,
	SELF_COMPACTION_OWNER_REQUEST_CUSTOM_TYPE,
	SELF_COMPACTION_OWNER_REQUEST_TEXT,
	SELF_COMPACTION_PROMPT_KINDS,
	SELF_COMPACTION_REQUEST_CUSTOM_TYPE,
	SELF_COMPACTION_SUMMARY_INSTRUCTIONS,
	type SelfCompactionLevel,
	type SelfCompactionPromptKind,
	type SelfCompactionRequestRecord,
	type SelfCompactionSettings,
	type SelfCompactionState,
	SelfCompactionStateScan,
	type SelfCompactionThresholds,
	selfCompactionGuidance,
	selfCompactionLevel,
	selfCompactionPromptSource,
	selfCompactionTemplateValues,
	validateSelfCompactionNote,
} from "./self-compaction.ts";

export interface SelfCompactionControllerDeps {
	getSessionManager(): SessionManager;
	getSettings(): SelfCompactionSettings;
	getContextUsage(): ContextUsage | undefined;
	getCachedTokens(): number | null;
	getHardTriggerTokens(): number | undefined;
	getEarlyTriggerTokens(): number | undefined;
	hasCompactableHistory(): boolean;
	compact(customInstructions: string): Promise<unknown>;
	deliverNote(message: { customType: string; content: string; display: boolean; details: unknown }): Promise<void>;
	askForHandoff(message: { customType: string; content: string; display: boolean }): Promise<void>;
	continueFromHandoff(): Promise<void>;
	isForegroundBusy(): boolean;
	waitForForegroundIdle(): Promise<void>;
	isDisposed(): boolean;
	isAwaitingOwner(): boolean;
	onHandoffSettled(): void;
	warn(message: string): void;
}

export type SelfCompactionPhase =
	| "off"
	| "clear"
	| "notice"
	| "warning"
	| "forced"
	| "compacting"
	| "compacted"
	| "resuming";

export interface SelfCompactionView {
	readonly enabled: boolean;
	readonly settingsError: string | null;
	readonly level: SelfCompactionLevel;
	readonly phase: SelfCompactionPhase;
	readonly cycles: number;
	readonly usedTokens: number | null;
	readonly cachedTokens: number | null;
	readonly usedPercent: number | null;
	readonly contextWindow: number | null;
	readonly thresholds: SelfCompactionThresholds | null;
	readonly tokensUntilWarning: number | null;
	readonly tokensUntilForced: number | null;
	readonly toolsLocked: boolean;
	readonly handoff: {
		readonly status: SelfCompactionState["status"];
		readonly attempts: number;
		readonly noteChars: number | null;
		readonly lastError: string | null;
		readonly ownerRequested: boolean;
	};
}

export interface SelfCompactionInfo {
	readonly view: SelfCompactionView;
	readonly settings: SelfCompactionSettings;
	readonly promptSources: Readonly<Record<SelfCompactionPromptKind, string>>;
	readonly note: string | null;
	readonly running: boolean;
}

export type SelfCompactionNowOutcome =
	| { readonly kind: "resumed"; readonly noteChars: number }
	| { readonly kind: "asked" }
	| { readonly kind: "refused"; readonly reason: string };

export type SelfCompactionRequestOutcome =
	| { readonly accepted: true; readonly record: SelfCompactionRequestRecord; readonly replaced: boolean }
	| { readonly accepted: false; readonly reason: string };

export class SelfCompactionController {
	private readonly deps: SelfCompactionControllerDeps;
	private readonly scan = new SelfCompactionStateScan();
	private running: Promise<void> | undefined;
	private announcedLevel: SelfCompactionLevel = "idle";
	private renderedGuidance: { key: string; text: string | undefined } | undefined;
	private readonly activityListeners = new Set<() => void>();

	constructor(deps: SelfCompactionControllerDeps) {
		this.deps = deps;
	}

	thresholds(usage = this.deps.getContextUsage()): SelfCompactionThresholds | undefined {
		const settings = this.deps.getSettings();
		return resolveSelfCompactionThresholds(
			usage?.contextWindow ?? 0,
			this.deps.getHardTriggerTokens(),
			this.deps.getEarlyTriggerTokens(),
			settings,
		);
	}

	level(): SelfCompactionLevel {
		const usage = this.deps.getContextUsage();
		return selfCompactionLevel(usage?.tokens, this.thresholds(usage));
	}

	state(): SelfCompactionState {
		const manager = this.deps.getSessionManager();
		const index = resolveSessionEntryIndex(manager);
		return index ? this.scan.find(index) : deriveSelfCompactionState(manager.getBranch());
	}

	resetBranchState(): void {
		this.scan.reset();
		this.announcedLevel = "idle";
		this.renderedGuidance = undefined;
	}

	guidance(): string | undefined {
		const usage = this.deps.getContextUsage();
		const thresholds = this.thresholds(usage);
		if (!thresholds) return undefined;
		const state = this.state();
		if (isActiveSelfCompactionStatus(state.status)) return undefined;
		const level = selfCompactionLevel(usage?.tokens, thresholds);
		this.announce(level);
		const prompts = this.deps.getSettings().prompts;
		const key = JSON.stringify([
			level,
			thresholds,
			state.cycles,
			level === "notice" || level === "warning" ? prompts[level] : null,
		]);
		if (this.renderedGuidance?.key !== key) {
			this.renderedGuidance = {
				key,
				text: selfCompactionGuidance(
					level,
					thresholds,
					prompts,
					selfCompactionTemplateValues(thresholds, usage?.tokens ?? null, state.cycles),
				),
			};
		}
		return this.renderedGuidance.text;
	}

	guidanceClearedText(): string {
		return SELF_COMPACTION_GUIDANCE_CLEARED_TEXT;
	}

	private announce(level: SelfCompactionLevel): void {
		if (level === "unknown") return;
		if (!isSelfCompactionLevelAtLeast(level, "warning")) {
			if (level === "idle") this.announcedLevel = "idle";
			return;
		}
		if (isSelfCompactionLevelAtLeast(this.announcedLevel, level)) return;
		this.announcedLevel = level;
		const usage = this.deps.getContextUsage();
		const at =
			usage?.tokens === null || usage?.tokens === undefined ? "unknown" : usage.tokens.toLocaleString("en-US");
		this.deps.warn(
			level === "forced"
				? `self-compaction: context reached the forced line at ${at} tokens; every tool except ${SELF_COMPACT_TOOL_NAME} is refused until the agent compacts.`
				: `self-compaction: context passed the warning line at ${at} tokens; the agent was asked to write its note and compact.`,
		);
	}

	private toolsLocked(state: SelfCompactionState, level: SelfCompactionLevel): boolean {
		if (state.status === "pending") return true;
		return level === "forced" && !isActiveSelfCompactionStatus(state.status) && this.deps.hasCompactableHistory();
	}

	private phase(
		thresholds: SelfCompactionThresholds | undefined,
		state: SelfCompactionState,
		level: SelfCompactionLevel,
		toolsLocked: boolean,
	): SelfCompactionPhase {
		if (!thresholds) return "off";
		if (state.status === "pending") return "compacting";
		if (state.status === "compacted") return "compacted";
		if (state.status === "delivered") return "resuming";
		if (level === "forced") return toolsLocked ? "forced" : "warning";
		if (level === "warning" || level === "notice") return level;
		return "clear";
	}

	view(): SelfCompactionView {
		const settings = this.deps.getSettings();
		const usage = this.deps.getContextUsage();
		const thresholds = this.thresholds(usage);
		const level = selfCompactionLevel(usage?.tokens, thresholds);
		const state = this.state();
		const tokens = usage?.tokens ?? null;
		const toolsLocked = thresholds ? this.toolsLocked(state, level) : false;
		return {
			enabled: settings.enabled,
			settingsError: settings.error ?? null,
			level,
			phase: this.phase(thresholds, state, level, toolsLocked),
			cycles: state.cycles,
			usedTokens: tokens,
			cachedTokens: tokens === null ? null : this.deps.getCachedTokens(),
			usedPercent: usage?.percent === null || usage?.percent === undefined ? null : Number(usage.percent.toFixed(1)),
			contextWindow: usage?.contextWindow ?? null,
			thresholds: thresholds ?? null,
			tokensUntilWarning: thresholds && tokens !== null ? Math.max(0, thresholds.warningTokens - tokens) : null,
			tokensUntilForced: thresholds && tokens !== null ? Math.max(0, thresholds.forcedTokens - tokens) : null,
			toolsLocked,
			handoff: {
				status: state.status,
				attempts: state.attempts,
				noteChars: state.request && isActiveSelfCompactionStatus(state.status) ? state.request.note.length : null,
				lastError: state.lastError ?? null,
				ownerRequested: state.ownerRequested,
			},
		};
	}

	info(): SelfCompactionInfo {
		const settings = this.deps.getSettings();
		const state = this.state();
		const promptSources = Object.fromEntries(
			SELF_COMPACTION_PROMPT_KINDS.map((kind) => [kind, selfCompactionPromptSource(settings, kind)]),
		) as Record<SelfCompactionPromptKind, string>;
		return {
			view: this.view(),
			settings,
			promptSources,
			note: state.request && isActiveSelfCompactionStatus(state.status) ? state.request.note : null,
			running: this.running !== undefined,
		};
	}

	private summaryInstructions(): string {
		const summary = this.deps.getSettings().prompts.summary;
		if (summary === undefined) return SELF_COMPACTION_SUMMARY_INSTRUCTIONS;
		const usage = this.deps.getContextUsage();
		const thresholds = this.thresholds(usage);
		return thresholds
			? renderSelfCompactionTemplate(
					summary,
					selfCompactionTemplateValues(thresholds, usage?.tokens ?? null, this.state().cycles),
				)
			: summary;
	}

	async compactNow(): Promise<SelfCompactionNowOutcome> {
		if (!this.thresholds()) {
			const error = this.deps.getSettings().error;
			return {
				kind: "refused",
				reason: error
					? `self-compaction is disabled because its settings were rejected: ${error}`
					: "self-compaction is not available: compaction is disabled or the model has no known context window",
			};
		}
		const state = this.state();
		if (isActiveSelfCompactionStatus(state.status) && state.request) {
			if (!this.schedule()) {
				return {
					kind: "refused",
					reason: "the saved note waits for the pending owner question; it resumes once that question is answered",
				};
			}
			return { kind: "resumed", noteChars: state.request.note.length };
		}
		if (!this.deps.hasCompactableHistory()) {
			return {
				kind: "refused",
				reason: "nothing to compact yet: the recent history the host always keeps covers the whole context",
			};
		}
		await this.deps.askForHandoff({
			customType: SELF_COMPACTION_OWNER_REQUEST_CUSTOM_TYPE,
			content: SELF_COMPACTION_OWNER_REQUEST_TEXT,
			display: true,
		});
		return { kind: "asked" };
	}

	private refusal(
		note: unknown,
	): { reason: string } | { note: string; level: SelfCompactionLevel; state: SelfCompactionState } {
		const thresholds = this.thresholds();
		if (!thresholds) {
			const error = this.deps.getSettings().error;
			return {
				reason: error
					? `Self-compaction is disabled because its settings were rejected: ${error}.`
					: "Self-compaction is not available: compaction is disabled or the model has no known context window.",
			};
		}
		const validation = validateSelfCompactionNote(note);
		if (!validation.ok) return { reason: validation.reason };
		const state = this.state();
		if (state.status === "compacted" || state.status === "delivered") {
			return {
				reason: "The context was already compacted and your saved note is being returned; continue from it.",
			};
		}
		const usage = this.deps.getContextUsage();
		const level = selfCompactionLevel(usage?.tokens, thresholds);
		if (state.status !== "pending" && !state.ownerRequested && !isSelfCompactionLevelAtLeast(level, "notice")) {
			const left =
				usage?.tokens === null || usage?.tokens === undefined ? undefined : thresholds.noticeTokens - usage.tokens;
			return {
				reason: `Context is below the notice line${left === undefined ? "" : ` (${left.toLocaleString("en-US")} tokens left before it)`}; compacting now would pay for a summary the context does not need yet. Keep working. No note was saved and no tool is refused.`,
			};
		}
		if (!this.deps.hasCompactableHistory()) {
			return {
				reason: `Nothing to compact yet: the recent history the host always keeps covers the whole context. No note was saved and no tool is refused. Keep working and call ${SELF_COMPACT_TOOL_NAME} later.`,
			};
		}
		return { note: validation.note, level, state };
	}

	request(note: unknown): SelfCompactionRequestOutcome {
		const admission = this.refusal(note);
		if ("reason" in admission) return { accepted: false, reason: admission.reason };
		const record: SelfCompactionRequestRecord = {
			id: randomUUID(),
			note: admission.note,
			requestedAt: new Date().toISOString(),
			level: admission.level,
			tokens: this.deps.getContextUsage()?.tokens ?? null,
		};
		this.deps.getSessionManager().appendCustomEntry(SELF_COMPACTION_REQUEST_CUSTOM_TYPE, record);
		return { accepted: true, record, replaced: admission.state.status === "pending" };
	}

	private batchHandsOff(assistantMessage: AssistantMessage): boolean {
		const note = batchSelfCompactionNote(assistantMessage);
		return note !== undefined && !("reason" in this.refusal(note));
	}

	gateToolCall(toolName: string, assistantMessage: AssistantMessage): BeforeToolCallResult | undefined {
		if (toolName === SELF_COMPACT_TOOL_NAME) return undefined;
		const thresholds = this.thresholds();
		if (!thresholds) return undefined;
		const state = this.state();
		const level = this.level();
		const handsOff = batchSelfCompactionNote(assistantMessage) !== undefined;
		const terminate = handsOff ? { terminate: true } : {};
		if (state.status !== "pending" && handsOff && this.batchHandsOff(assistantMessage)) {
			return {
				block: true,
				reason: `Tool "${toolName}" was not run: ${SELF_COMPACT_TOOL_NAME} is in the same batch, so this turn ends at the handoff and your note must describe the state before this call. Call ${SELF_COMPACT_TOOL_NAME} alone; after compaction, run this call again if your note still needs it.`,
				terminate: true,
			};
		}
		if (state.status === "pending") {
			return {
				block: true,
				reason: `Tool "${toolName}" is refused: a ${SELF_COMPACT_TOOL_NAME} note is saved and the context is compacted when this turn ends. Stop here; the note comes back verbatim after compaction.`,
				...terminate,
			};
		}
		if (this.toolsLocked(state, level)) {
			return {
				block: true,
				reason: `Tool "${toolName}" is refused: context is at the forced self-compaction line (${thresholds.forcedTokens.toLocaleString("en-US")} tokens). Write note_to_self and call ${SELF_COMPACT_TOOL_NAME} now; every other tool is refused until the context is compacted.`,
				...terminate,
			};
		}
		return undefined;
	}

	hasPendingContinuation(): boolean {
		return this.running !== undefined;
	}

	async whenSettled(): Promise<void> {
		while (this.running) await this.running;
	}

	subscribeActivity(listener: () => void): () => void {
		this.activityListeners.add(listener);
		return () => {
			this.activityListeners.delete(listener);
		};
	}

	private notifyActivity(): void {
		for (const listener of [...this.activityListeners]) {
			try {
				listener();
			} catch (error) {
				this.deps.warn(
					`self-compaction: activity observer failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	schedule(): boolean {
		if (this.running) return true;
		if (this.deps.isDisposed() || this.deps.isAwaitingOwner()) return false;
		if (!isActiveSelfCompactionStatus(this.state().status)) return false;
		const run: Promise<void> = this.run().then((settled) => {
			if (this.running === run) this.running = undefined;
			this.notifyActivity();
			if (settled && !this.deps.isDisposed()) this.deps.onHandoffSettled();
		});
		this.running = run;
		this.notifyActivity();
		return true;
	}

	private async run(): Promise<boolean> {
		let settled = false;
		let continued = false;
		try {
			while (!this.deps.isDisposed()) {
				if (this.deps.isForegroundBusy()) await this.deps.waitForForegroundIdle();
				if (this.deps.isDisposed() || this.deps.isAwaitingOwner()) return settled;
				const state = this.state();
				const request = state.request;
				if (!request) return settled;
				if (state.status === "pending") {
					if (state.attempts >= SELF_COMPACTION_MAX_ATTEMPTS) {
						this.abandon(
							request,
							`compaction did not succeed after ${state.attempts} attempts (${state.lastError ?? "unknown error"})`,
						);
						return settled;
					}
					if (!this.deps.hasCompactableHistory()) {
						this.abandon(request, "there is nothing left to compact");
						return settled;
					}
					try {
						await this.deps.compact(this.summaryInstructions());
					} catch (error) {
						const after = this.state();
						this.deps.warn(
							`self-compaction: compaction attempt ${after.attempts} of ${SELF_COMPACTION_MAX_ATTEMPTS} did not finish (${error instanceof Error ? error.message : String(error)}). The saved note is kept; the next idle checkpoint retries, and /compact finishes it now.`,
						);
						return settled;
					}
					if (this.state().status === "pending") {
						this.abandon(request, "a compaction finished without carrying the saved note");
						return settled;
					}
					continue;
				}
				if (state.status === "compacted") {
					if (
						await this.hostTurn(() =>
							this.deps.deliverNote({
								customType: SELF_COMPACTION_HANDOFF_CUSTOM_TYPE,
								content: request.note,
								display: true,
								details: { handoffId: request.id },
							}),
						)
					) {
						settled = true;
						continued = true;
					}
					continue;
				}
				if (state.status === "delivered" && !continued) {
					if (await this.hostTurn(() => this.deps.continueFromHandoff())) {
						settled = true;
						continued = true;
					}
					continue;
				}
				return settled;
			}
		} catch (error) {
			this.deps.warn(`self-compaction: handoff failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		return settled;
	}

	private async hostTurn(turn: () => Promise<void>): Promise<boolean> {
		try {
			await turn();
			return true;
		} catch (error) {
			if (error instanceof AgentBusyError) return false;
			throw error;
		}
	}

	private abandon(request: SelfCompactionRequestRecord, why: string): void {
		this.deps.getSessionManager().appendCustomEntry(SELF_COMPACTION_ABANDONED_CUSTOM_TYPE, {
			handoffId: request.id,
			reason: why,
		});
		this.deps.warn(
			`self-compaction: the saved note (${request.note.length.toLocaleString("en-US")} chars) was released because ${why}. Tools are no longer refused; the host's own compaction still protects the context.`,
		);
	}
}

export function createSelfCompactToolDefinition(
	getController: () => SelfCompactionController | undefined,
): ToolDefinition {
	return {
		name: SELF_COMPACT_TOOL_NAME,
		label: "Self Compact",
		description: `Without note_to_self: your context usage and self-compaction lines as JSON. With note_to_self (1-${SELF_COMPACTION_NOTE_MAX_CHARS.toLocaleString("en-US")} chars: goal, done work with exact paths, in-progress state, decisions, verified results, exact NEXT ACTION last): saves the note, ends this turn, compacts the context, and returns the note verbatim as the next message; then continue its NEXT ACTION. Call it alone in its batch.`,
		parameters: Type.Object(
			{ note_to_self: Type.Optional(Type.String({ description: "Handoff note; omit to read usage" })) },
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params: { note_to_self?: unknown }) {
			const controller = getController();
			if (!controller) {
				return {
					content: [{ type: "text" as const, text: "Self-compaction is not available in this session." }],
					details: undefined,
					isError: true,
					errorKind: "operation_outcome" as const,
				};
			}
			if (params.note_to_self === undefined) {
				const view = controller.view();
				return { content: [{ type: "text" as const, text: JSON.stringify(view, null, 2) }], details: view };
			}
			const outcome = controller.request(params.note_to_self);
			if (!outcome.accepted) {
				return {
					content: [{ type: "text" as const, text: outcome.reason }],
					details: { accepted: false },
					isError: true,
					errorKind: "operation_outcome" as const,
				};
			}
			const at =
				outcome.record.tokens === null
					? "unknown usage"
					: `${outcome.record.tokens.toLocaleString("en-US")} tokens`;
			return {
				content: [
					{
						type: "text" as const,
						text: `Note saved (${outcome.record.note.length.toLocaleString("en-US")} chars) at ${at}${outcome.replaced ? ", replacing the earlier saved note" : ""}. Stop now: the context is compacted when this turn ends and your note comes back verbatim.`,
					},
				],
				details: { accepted: true, handoffId: outcome.record.id, noteChars: outcome.record.note.length },
				terminate: true,
			};
		},
	};
}
