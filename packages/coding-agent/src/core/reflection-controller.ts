/**
 * Root-session reflection cue + explicit learning-write controller.
 *
 * Automatic reflection is a hidden cue in the root orchestrator's ordinary provider turn. This
 * controller never schedules an automatic provider request. The isolated completion and structured
 * reflection pass remain explicit compatibility/application seams for owner-invoked callers. Every
 * durable effect goes through the bundled memory tool, the session log (via deps), or the skills dir.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@caupulican/pi-agent-core/agent";
import { runAgentLoop, startAgentProviderRequest } from "@caupulican/pi-agent-core/agent-loop";
import type { SessionManager } from "@caupulican/pi-agent-core/session";
import type { AgentContext, AgentLoopConfig, AgentMessage, ThinkingLevel } from "@caupulican/pi-agent-core/types";
import { resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import type {
	Api,
	AssistantMessage,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Usage,
} from "@caupulican/pi-ai/types";
import {
	computeLaneAffinityKey,
	DEFAULT_ISOLATED_LANE_KIND,
	type IsolatedCompletionOptions,
	type IsolatedCompletionResult,
} from "./agent-session-contracts.ts";
import type { LearningDecision } from "./autonomy/contracts.ts";
import { AUTONOMY_TELEMETRY_EVENT_TYPES, type AutonomyTelemetryEvent } from "./autonomy/telemetry-events.ts";
import { PI_OKF_TYPES, type PiOkfType } from "./context/okf-memory.ts";
import { isCurrentSessionReflectionEnabled, resolveAutoLearnSettings } from "./learning/auto-learn-settings.ts";
import {
	type DurableLearningClaimToken,
	type DurableLearningCueAttachOutcome,
	type DurableLearningReviewMetadata,
	type DurableLearningState,
	isDurableLearningClaimToken,
	isDurableLearningReviewMetadata,
} from "./learning/durable-learning-state.ts";
import {
	APPLY_WRITE_REFUSED_REASON_CODE,
	appendLearningAuditSnapshot,
	contradictionsForReflectionWrite,
	getLearningAuditSnapshots,
	type LearningAuditRecord,
	proposalFromReflectionWrite,
	rollbackPlanForReflectionWrite,
} from "./learning/learning-audit.ts";
import { evaluateLearningDecision } from "./learning/learning-gate.ts";
import { ObservationStore, observationKey } from "./learning/observation-store.ts";
import {
	type DemandSignals,
	decideDemand,
	ReflectionEngine,
	type ReflectionResult,
	type ReflectionWrite,
} from "./learning/reflection-engine.ts";
import { analyzeReflectionTurn, type ReflectionTurnAnalysis } from "./learning/reflection-turn-analysis.ts";
import type { MemoryManager } from "./memory/memory-manager.ts";
import type {
	StructuredReflectionApplyResult,
	StructuredReflectionRollback,
	StructuredReflectionWrite,
} from "./memory/providers/file-store.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { registerInFlightWork } from "./reload-blockers.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import { DEFAULT_BOUNDED_SKILL_AUDIT_LIMITS, runSkillAudit } from "./tools/skill-audit.ts";

export interface ReflectionControllerDeps {
	/** Current session model (fallback for an isolated call that omits its own model). */
	getModel(): Model<Api> | undefined;
	/** The underlying agent — its `streamFn` runs the isolated completion. */
	getAgent(): Agent;
	/** True when the session's stream fn is the raw `streamSimple` provider (auth must be injected). */
	isRawStreamSimple(): boolean;
	/** Model registry for API-key/header resolution on the raw-provider path. */
	getModelRegistry(): ModelRegistry;
	/** Memory subsystem — the bundled `memory` tool applies durable writes; fresh block feeds reflection. */
	getMemoryManager(): MemoryManager;
	/** Fresh bounded structured OKF snapshot, read at reflection time for confront-before-write. */
	getFreshOkfMemoryForReflection(): string;
	/** Main-orchestrator-only structured memory mutation port. */
	applyStructuredReflectionWrite(
		write: StructuredReflectionWrite,
		signal?: AbortSignal,
	): Promise<StructuredReflectionApplyResult>;
	/** Main-orchestrator-only inverse for an audited structured write. */
	rollbackStructuredReflectionWrite(rollback: StructuredReflectionRollback, signal?: AbortSignal): Promise<boolean>;
	/** Settings — the learning-apply policy (gate thresholds, auto-apply layers) is read here. */
	getSettingsManager(): SettingsManager;
	/** Session log — audit snapshots and learning-audit reads go through this. */
	getSessionManager(): SessionManager;
	/** Agent dir — reflection-promoted skills are written under `<agentDir>/skills/`. */
	getAgentDir(): string;
	/** Child sessions must not learn — the pass returns null for them. */
	isChildSession(): boolean;
	/** Disposal short-circuits: no completion, no writes against a dead session. */
	isDisposed(): boolean;
	/** Session-lifetime abort signal — aborts an in-flight reflection completion on dispose. */
	getReflectionSignal(): AbortSignal;
	/** Archive a promoted skill (rollback of a `promote_skill` write). */
	archivePromotedSkill(name: string): boolean;
	/** Make a just-written or archived skill visible to this session's skill vault. */
	refreshLiveSkills?(): void;
	/** G3/G8 autonomy telemetry sink for learning-gate outcomes and approval requests. */
	emitAutonomyTelemetry(event: AutonomyTelemetryEvent): void;
	/** Account the reflection pass's token spend into the cost roll-up (idempotent on reportId). */
	addSpawnedUsage(
		usage: Usage,
		opts?: { label?: string; sourceSessionId?: string; reportId?: string },
	): string | undefined;
	/** Persist a learning-gate decision snapshot to the session log. */
	saveLearningDecisionSnapshot(decision: LearningDecision): string;
	/** Resolve text-tool fallback for the selected isolated model, not the foreground model. */
	resolveTextToolCallProtocol(model: Model<Api>): SimpleStreamOptions["textToolCallProtocol"];
	/** Ensure a managed-local model is running/resident before any isolated lane calls it. */
	ensureModelReady(model: Model<Api>): Promise<void>;
	/**
	 * Session working directory — feeds the skill-overlap audit's project-local skill discovery, the
	 * same `cwd` the model-invoked `skillify`/`skill_audit` tools already receive (tools/index.ts).
	 * Optional so a host that has not wired it yet still resolves (falls back to `process.cwd()`,
	 * mirroring the existing profile-resolution fallback in settings-manager.ts).
	 */
	getCwd?(): string;
	/** Already-loaded root skill universe; avoids a second unbounded filesystem discovery during reflection. */
	getSkillsForAudit?(): readonly Skill[];
	/** Root-owned durable version transition state; omitted by legacy or test hosts. */
	getDurableLearningState?(): DurableLearningState | undefined;
	/** Installed runtime identity used only for root-owned durable transition detection. */
	getRuntimeVersion?(): string | undefined;
	/** Versioned durable-memory interpretation policy. */
	getMemoryPolicyVersion?(): string | undefined;
	/** Bounded host warning sink for fail-safe state degradation. */
	warn?(message: string): void;
}

// reasonCode when an automatic skill promotion is blocked by an overlap with an existing skill
// (skill_audit's similarity threshold) and routed to a consolidation proposal instead of a blind write.
export const SKILL_OVERLAP_CONSOLIDATION_REASON_CODE = "skill_overlap_consolidation_proposed";
// reasonCode when the overlap audit itself fails — the promotion is held (not written unaudited)
// rather than silently skipping the check.
export const SKILL_AUDIT_UNAVAILABLE_REASON_CODE = "skill_audit_unavailable";

export const CURRENT_TURN_REFLECTION_CUSTOM_TYPE = "reflection_cue";
export const CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE = "reflection_cue_state";
/** `internalContextType` of the one dedicated end-of-work reflection turn. */
export const REFLECTION_TURN_TRIGGER_CUSTOM_TYPE = "reflection_turn_trigger";

export type CurrentTurnReflectionTrigger = "root-turn" | "version-change" | Exclude<DemandSignals["trigger"], "none">;

export interface CurrentTurnReflectionCueState {
	version: 1;
	revision: number;
	cueId: string;
	/**
	 * Delivery lifecycle of one logical cue.
	 *
	 * - `pending` — evidence is accumulating for work that is still in flight. NEVER previewed: a cue
	 *   offered here would ride every provider request of the run that is still producing the very
	 *   work it asks the model to reflect on.
	 * - `due` — the work this cue belongs to has ENDED (`finishCurrentTurnCue` observed the run's
	 *   terminal boundary, or the cue was attached at one). Deliverable on the next ordinary provider
	 *   request, and only that one.
	 * - `consumed` — delivered on an accepted provider request; `activeRunToken` names that run.
	 * - `dismissed` — reflection was disabled or the session disposed before delivery.
	 */
	status: "pending" | "due" | "consumed" | "dismissed";
	triggers: CurrentTurnReflectionTrigger[];
	createdAt: string;
	updatedAt: string;
	/** Provider-hidden token proving exact ownership of one version transition. */
	versionChange?: {
		token: DurableLearningClaimToken;
		metadata: DurableLearningReviewMetadata;
	};
	/** Provider-hidden identity of the currently accepted cue-bearing request. */
	activeRunToken?: string;
}

export interface CurrentTurnReflectionCuePlan {
	message: AgentMessage;
	isCurrent(): boolean;
	commit(): void;
}

const CURRENT_TURN_REFLECTION_CUE = [
	"Root reflection contract — this turn exists only to reflect on the work that just ended:",
	"- Decide now, in this turn, whether that completed work warrants durable learning.",
	"- When warranted, confront existing memory first, then use this root session's memory or skill tools now.",
	"- Route canonical project semantics and evidence to OKF; keep ICM/workflow context as status plus OKF references, never duplicated project truth.",
	"- Route stable collaborator preferences to USER, compact hot facts to MEMORY, and reusable procedures to skills.",
	"- Do not defer reflection, ask for a further turn, call an isolated completion, or launch a background learner or worker for it. This turn is the whole budget.",
	"- When nothing durable is warranted, say so in one short line and stop. Do not resume, restate, or extend the previous work.",
].join("\n");

/**
 * The durable half of the reflection turn: the short line that becomes its prompt message.
 *
 * The ~250-token contract above rides the same request as a request-local transient instead of being
 * this text, so it is never written to history. What stays in the transcript is this one line - enough
 * for a later reader (or a rebuilt context) to see that a reflection checkpoint happened, without
 * accumulating a copy of the contract per checkpoint.
 */
const REFLECTION_TURN_PROMPT = "Reflection checkpoint: the unit of work above has ended.";

/**
 * Triggers that justify spending an extra provider turn — the demand signals `analyzeCompletedTurn`
 * raises from what actually happened in a completed turn.
 *
 * Two triggers are deliberately absent. `root-turn` means only "a root turn happened"; buying a
 * reflection turn on that would make every single turn cost two. `version-change` is excluded on its
 * own authority: the cue's own version line states that first observation is audit-only and that
 * version movement alone is never semantic evidence, so paying a provider turn for it would
 * contradict the thing it says. It still rides the cue whenever real evidence buys a turn, and an
 * unreviewed claim is released rather than lost (see `dismissCurrentTurnCue`), so the next session
 * re-observes the transition.
 */
const REFLECTION_TURN_WORTHY_TRIGGERS = new Set<CurrentTurnReflectionTrigger>([
	"complex",
	"corrective",
	"durable",
	"session-end",
]);

const CURRENT_TURN_REFLECTION_TRIGGERS = new Set<CurrentTurnReflectionTrigger>([
	"root-turn",
	"version-change",
	"complex",
	"corrective",
	"durable",
	"session-end",
]);

function parseCurrentTurnReflectionCueState(value: unknown): CurrentTurnReflectionCueState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<CurrentTurnReflectionCueState>;
	if (
		candidate.version !== 1 ||
		typeof candidate.revision !== "number" ||
		!Number.isSafeInteger(candidate.revision) ||
		candidate.revision < 1 ||
		typeof candidate.cueId !== "string" ||
		(candidate.status !== "pending" &&
			candidate.status !== "due" &&
			candidate.status !== "consumed" &&
			candidate.status !== "dismissed") ||
		!Array.isArray(candidate.triggers) ||
		candidate.triggers.length === 0 ||
		candidate.triggers.some((trigger) => !CURRENT_TURN_REFLECTION_TRIGGERS.has(trigger)) ||
		typeof candidate.createdAt !== "string" ||
		typeof candidate.updatedAt !== "string" ||
		(candidate.activeRunToken !== undefined && typeof candidate.activeRunToken !== "string") ||
		(candidate.versionChange !== undefined &&
			(!candidate.versionChange ||
				!isDurableLearningClaimToken(candidate.versionChange.token) ||
				!isDurableLearningReviewMetadata(candidate.versionChange.metadata)))
	) {
		return undefined;
	}
	return {
		version: 1,
		revision: candidate.revision,
		cueId: candidate.cueId,
		status: candidate.status,
		triggers: [...new Set(candidate.triggers)],
		createdAt: candidate.createdAt,
		updatedAt: candidate.updatedAt,
		...(candidate.versionChange
			? {
					versionChange: {
						token: { ...candidate.versionChange.token },
						metadata: { ...candidate.versionChange.metadata },
					},
				}
			: {}),
		...(candidate.activeRunToken ? { activeRunToken: candidate.activeRunToken } : {}),
	};
}

function versionClaimTokensMatch(left: DurableLearningClaimToken, right: DurableLearningClaimToken): boolean {
	return (
		left.transitionId === right.transitionId &&
		left.claimId === right.claimId &&
		left.ownerId === right.ownerId &&
		left.runtimeVersion === right.runtimeVersion &&
		left.memoryPolicyVersion === right.memoryPolicyVersion
	);
}

function hasStrictSuccessfulAssistantTerminal(messages: AgentMessage[]): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (message.stopReason !== "stop" || message.errorMessage) return false;
		return message.content.some((part) => part.type === "text" && part.text.trim().length > 0);
	}
	return false;
}

interface ReflectionApplyResult {
	applied: boolean;
	rollback?: LearningAuditRecord["rollback"];
}

function parseOkfRollbackTarget(target: string | undefined): { type: PiOkfType; title: string } | undefined {
	if (!target) return undefined;
	const separator = target.indexOf("\0");
	if (separator <= 0 || separator === target.length - 1) return undefined;
	const type = target.slice(0, separator);
	if (!PI_OKF_TYPES.includes(type as PiOkfType)) return undefined;
	return { type: type as PiOkfType, title: target.slice(separator + 1) };
}

export class ReflectionController {
	private readonly deps: ReflectionControllerDeps;
	private readonly unsubscribeSettingsChanges: () => void;
	private readonly durableLearningOwnerId = randomUUID();
	private readonly emittedWarningCodes = new Set<string>();
	private cueStateCacheInitialized = false;
	private cueStateCache: CurrentTurnReflectionCueState | undefined;
	private activeRunToken: string | undefined;
	/** True only while the one dedicated reflection turn is running; gates cue visibility entirely. */
	private reflectionTurnInFlight = false;

	constructor(deps: ReflectionControllerDeps) {
		this.deps = deps;
		this.unsubscribeSettingsChanges = deps.getSettingsManager().subscribeChanges(() => {
			this.synchronizeCurrentTurnCueWithSettings();
		});
		this.synchronizeCurrentTurnCueWithSettings();
	}

	dispose(): void {
		this.dismissCurrentTurnCue();
		this.unsubscribeSettingsChanges();
	}

	private isAutomaticReflectionEnabled(): boolean {
		const settingsManager = this.deps.getSettingsManager();
		const settings = resolveAutoLearnSettings(
			settingsManager.getAutonomySettings().mode,
			settingsManager.getAutoLearnSettings(),
		);
		return isCurrentSessionReflectionEnabled(settings) && !this.deps.isChildSession() && !this.deps.isDisposed();
	}

	/** Latest durable cue snapshot on the active session branch; custom state never enters model context. */
	getCurrentTurnCueState(): CurrentTurnReflectionCueState | undefined {
		if (this.cueStateCacheInitialized) return this.cueStateCache;
		const sessionManager = this.deps.getSessionManager();
		let fromId: string | undefined;
		while (true) {
			const entry = sessionManager.getLatestCustomEntryOnBranch(CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE, fromId);
			if (!entry) break;
			const state = parseCurrentTurnReflectionCueState(entry.data);
			if (state) {
				this.cueStateCache = state;
				break;
			}
			if (!entry.parentId) break;
			fromId = entry.parentId;
		}
		this.cueStateCacheInitialized = true;
		return this.cueStateCache;
	}

	/**
	 * A cue that still owns its durable claim: queued but undelivered (`pending`/`due`), or delivered
	 * on a run this controller is still settling (`consumed` under our own run token).
	 */
	private ownsLiveClaim(current: CurrentTurnReflectionCueState | undefined): boolean {
		if (!current) return false;
		if (current.status === "pending" || current.status === "due") return true;
		return (
			current.status === "consumed" && !!current.activeRunToken && current.activeRunToken === this.activeRunToken
		);
	}

	/** Branch/session navigation invalidates the lazy latest-state index; ordinary appends do not. */
	invalidateCurrentTurnCueStateCache(options: { releaseActiveClaim?: boolean } = {}): void {
		if (options.releaseActiveClaim) {
			const current = this.cueStateCacheInitialized ? this.cueStateCache : undefined;
			const isActive = this.ownsLiveClaim(current);
			if (isActive && current?.versionChange) {
				this.deps.getDurableLearningState?.()?.releaseClaim(current.versionChange.token);
			}
			this.activeRunToken = undefined;
		}
		this.cueStateCacheInitialized = false;
		this.cueStateCache = undefined;
	}

	private persistCurrentTurnCueState(state: CurrentTurnReflectionCueState): void {
		this.deps.getSessionManager().appendCustomEntry(CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE, state);
		this.cueStateCache = state;
		this.cueStateCacheInitialized = true;
	}

	private warnOnce(code: string, message: string): void {
		if (this.emittedWarningCodes.has(code)) return;
		this.emittedWarningCodes.add(code);
		this.deps.warn?.(message);
	}

	private dismissCurrentTurnCue(): void {
		const current = this.getCurrentTurnCueState();
		if (!current || !this.ownsLiveClaim(current)) return;
		try {
			this.persistCurrentTurnCueState({
				...current,
				revision: current.revision + 1,
				status: "dismissed",
				activeRunToken: undefined,
				updatedAt: new Date().toISOString(),
			});
		} catch {
			this.warnOnce(
				"cue-dismiss-failed",
				"Automatic reflection cue dismissal failed; its durable claim will expire safely.",
			);
			return;
		}
		this.activeRunToken = undefined;
		if (current.versionChange) this.deps.getDurableLearningState?.()?.releaseClaim(current.versionChange.token);
	}

	private synchronizeCurrentTurnCueWithSettings(): void {
		if (this.isAutomaticReflectionEnabled()) return;
		this.dismissCurrentTurnCue();
	}

	/**
	 * Attach or coalesce evidence into the single logical cue slot.
	 *
	 * `readyForDelivery` records WHERE the caller sits relative to the work the evidence describes,
	 * and is the only thing that decides when the cue may reach the provider. A caller at a
	 * completed-work boundary (`queueCurrentTurnCue`, fed by `analyzeCompletedTurn` at `agent_end`)
	 * attaches a `due` cue; a caller at the START of a root turn (`queueExternalRootTurnCue`) attaches
	 * a `pending` one, which `finishCurrentTurnCue` promotes when that turn's own work ends.
	 * `due` always wins a merge: once a unit of work has ended, later accumulation into the same slot
	 * cannot un-end it and must not push delivery out to the following turn.
	 */
	private attachCurrentTurnCue(
		trigger: CurrentTurnReflectionTrigger,
		options: {
			readyForDelivery: boolean;
			versionChange?: { token: DurableLearningClaimToken; metadata: DurableLearningReviewMetadata };
			clearVersionChange?: boolean;
		},
	): DurableLearningCueAttachOutcome {
		const { readyForDelivery, versionChange, clearVersionChange = false } = options;
		if (!this.isAutomaticReflectionEnabled()) {
			this.synchronizeCurrentTurnCueWithSettings();
			return "disabled";
		}
		try {
			const current = this.getCurrentTurnCueState();
			const updatedAt = new Date().toISOString();
			if (current?.status === "pending" || current?.status === "due") {
				const status = current.status === "due" || readyForDelivery ? "due" : "pending";
				if (clearVersionChange && current.versionChange) {
					const triggers: CurrentTurnReflectionTrigger[] = current.triggers.filter(
						(existing) => existing !== "version-change",
					);
					if (!triggers.includes(trigger)) triggers.push(trigger);
					this.persistCurrentTurnCueState({
						...current,
						revision: current.revision + 1,
						status,
						triggers,
						versionChange: undefined,
						updatedAt,
					});
					return "replaced-stale";
				}
				const alreadyHasTrigger = current.triggers.includes(trigger);
				const alreadyHasVersionTrigger = !versionChange || current.triggers.includes("version-change");
				const sameVersionClaim =
					!versionChange ||
					(!!current.versionChange && versionClaimTokensMatch(current.versionChange.token, versionChange.token));
				if (alreadyHasTrigger && alreadyHasVersionTrigger && sameVersionClaim && status === current.status) {
					return "coalesced";
				}
				const replacingVersionClaim = !!versionChange && !!current.versionChange && !sameVersionClaim;
				const triggers = [...current.triggers];
				if (!triggers.includes(trigger)) triggers.push(trigger);
				if (versionChange && !triggers.includes("version-change")) triggers.push("version-change");
				this.persistCurrentTurnCueState({
					...current,
					revision: current.revision + 1,
					status,
					triggers,
					updatedAt,
					...(versionChange ? { versionChange } : {}),
				});
				if (alreadyHasTrigger && alreadyHasVersionTrigger && sameVersionClaim) return "coalesced";
				return replacingVersionClaim ? "replaced-stale" : "attached";
			}
			const triggers: CurrentTurnReflectionTrigger[] = [trigger];
			if (versionChange && !triggers.includes("version-change")) triggers.push("version-change");
			this.persistCurrentTurnCueState({
				version: 1,
				revision: 1,
				cueId: randomUUID(),
				status: readyForDelivery ? "due" : "pending",
				triggers,
				createdAt: updatedAt,
				updatedAt,
				...(versionChange ? { versionChange } : {}),
			});
			return "attached";
		} catch {
			this.warnOnce(
				"cue-attach-failed",
				"Automatic reflection cue persistence failed; durable learning was not claimed.",
			);
			return "failed";
		}
	}

	/**
	 * Persist one logical ordinary cue without exposing claim metadata to callers.
	 *
	 * Called only from a COMPLETED-work boundary (`AgentSession`'s `agent_end` handling, with evidence
	 * projected by {@link analyzeCompletedTurn}), so the cue it attaches is immediately deliverable.
	 */
	queueCurrentTurnCue(trigger: CurrentTurnReflectionTrigger): boolean {
		// The reflection turn's own completion is not evidence. Without this, a reflection turn that
		// wrote to memory would analyze as `durable` and queue the cue that buys the NEXT reflection
		// turn, and so on - one extra turn forever, which is exactly the cost this design bounds.
		if (this.reflectionTurnInFlight) return false;
		const outcome = this.attachCurrentTurnCue(trigger, { readyForDelivery: true });
		return outcome === "attached" || outcome === "replaced-stale";
	}

	/**
	 * Open the ONE extra provider turn a completed unit of work may buy, returning its prompt text, or
	 * `undefined` when the work bought none.
	 *
	 * A turn is bought only by a `due` cue carrying real evidence ({@link REFLECTION_TURN_WORTHY_TRIGGERS}).
	 * A cue holding nothing but `root-turn` sits and waits: it costs nothing, and it merges with whatever
	 * evidence a later turn produces. Callers MUST pair this with {@link endReflectionTurn}.
	 */
	beginDueReflectionTurn(): string | undefined {
		if (this.reflectionTurnInFlight) return undefined;
		if (!this.isAutomaticReflectionEnabled()) {
			this.synchronizeCurrentTurnCueWithSettings();
			return undefined;
		}
		const current = this.getCurrentTurnCueState();
		if (current?.status !== "due") return undefined;
		if (!current.triggers.some((trigger) => REFLECTION_TURN_WORTHY_TRIGGERS.has(trigger))) return undefined;
		this.reflectionTurnInFlight = true;
		return REFLECTION_TURN_PROMPT;
	}

	/** Close the dedicated reflection turn. Infallible by contract; always call it in a `finally`. */
	endReflectionTurn(): void {
		this.reflectionTurnInFlight = false;
	}

	/**
	 * Root-turn entrypoint: reconcile installed runtime/policy state and atomically attach any exact
	 * version claim to the same provider cue. Fail-safe state faults degrade to an ordinary root cue.
	 *
	 * Called at the START of an external root turn, so what it attaches is `pending`, not deliverable:
	 * the work this cue will ask the model to reflect on has not happened yet. `finishCurrentTurnCue`
	 * promotes it the moment that work ends.
	 */
	queueExternalRootTurnCue(): DurableLearningCueAttachOutcome {
		if (!this.isAutomaticReflectionEnabled()) {
			this.synchronizeCurrentTurnCueWithSettings();
			return "disabled";
		}
		const state = this.deps.getDurableLearningState?.();
		const runtimeVersion = this.deps.getRuntimeVersion?.();
		const memoryPolicyVersion = this.deps.getMemoryPolicyVersion?.();
		if (!state || !runtimeVersion || !memoryPolicyVersion) {
			if (state && (!runtimeVersion || !memoryPolicyVersion)) {
				this.warnOnce(
					"version-identity-unavailable",
					"Installed runtime identity is unavailable; continuing with ordinary root reflection only.",
				);
			}
			return this.attachCurrentTurnCue("root-turn", { readyForDelivery: false, clearVersionChange: true });
		}
		const result = state.reconcileClaimAndAttach(
			{ runtimeVersion, memoryPolicyVersion },
			this.durableLearningOwnerId,
			(token, metadata) =>
				this.attachCurrentTurnCue("root-turn", { readyForDelivery: false, versionChange: { token, metadata } }),
		);
		if (result.warningCode) {
			this.warnOnce(
				result.warningCode,
				`Durable learning state warning (${result.warningCode}); semantic memory remained unchanged.`,
			);
		}
		if (
			result.status === "attached" ||
			result.status === "coalesced" ||
			result.status === "replaced-stale" ||
			result.status === "disabled" ||
			result.status === "failed"
		) {
			return result.status;
		}
		return this.attachCurrentTurnCue("root-turn", { readyForDelivery: false, clearVersionChange: true });
	}

	/**
	 * Preview one request-local provider-only cue, and ONLY inside the dedicated reflection turn
	 * ({@link beginDueReflectionTurn}) on a cue whose work has already ended (`due`).
	 *
	 * The reflection turn is the cue's ONLY delivery path — there is deliberately no piggyback onto an
	 * ordinary request. Every other state is invisible here, each for its own reason. A `pending` cue
	 * belongs to work still in flight; offering it would put a ~250-token MUST-protocol directive on
	 * every provider request of that run, N copies for one unit of work, asking the model to reflect on
	 * work it has not finished. A `consumed` cue was already carried by the accepted request that
	 * consumed it, so re-offering it on the reflection turn's own continuation requests would restore
	 * exactly that per-request cost. And a `due` cue outside a reflection turn is one whose work bought
	 * no extra turn (no evidence beyond `root-turn`, or the run was aborted); it waits for evidence
	 * rather than attaching itself to the next unrelated request.
	 */
	previewCurrentTurnCue(): CurrentTurnReflectionCuePlan | undefined {
		let current = this.getCurrentTurnCueState();
		if (!current || !this.isAutomaticReflectionEnabled()) return undefined;
		if (current.status !== "due" || !this.reflectionTurnInFlight) return undefined;
		if (current.versionChange) {
			// A `due` cue can wait through an arbitrary gap (the run that ended may be the session's
			// last for a while), so its lease is renewed at the delivery boundary rather than assumed
			// fresh from attach time.
			const renewed = this.deps.getDurableLearningState?.()?.renewClaim(current.versionChange.token) ?? false;
			if (!renewed) {
				const withoutStaleClaim = {
					...current,
					revision: current.revision + 1,
					triggers: current.triggers.filter((trigger) => trigger !== "version-change"),
					versionChange: undefined,
					updatedAt: new Date().toISOString(),
				} satisfies CurrentTurnReflectionCueState;
				try {
					this.persistCurrentTurnCueState(withoutStaleClaim);
					current = withoutStaleClaim;
				} catch {
					this.warnOnce(
						"cue-stale-claim-removal-failed",
						"A stale durable version claim could not be removed from provider cue state; version metadata was withheld.",
					);
					return undefined;
				}
			}
		}
		const cueId = current.cueId;
		const revision = current.revision;
		const expectedStatus = current.status;
		const expectedRunToken = current.activeRunToken;
		const versionLine = current.versionChange
			? `\n- Installed-state transition: ${current.versionChange.metadata.reason}; runtime ${current.versionChange.metadata.previousRuntimeVersion ?? "unobserved"} to ${current.versionChange.metadata.runtimeVersion}; memory policy ${current.versionChange.metadata.previousMemoryPolicyVersion ?? "unobserved"} to ${current.versionChange.metadata.memoryPolicyVersion}. First observation is audit-only, and version movement alone is never semantic evidence. Revalidate current sources; update only the canonical durable owner when warranted.`
			: "";
		const message: AgentMessage = {
			role: "custom",
			customType: CURRENT_TURN_REFLECTION_CUSTOM_TYPE,
			// Array (block) content, not a bare string, and that difference is load-bearing.
			// `adaptHostTransients` (packages/agent/src/transient-records.ts, read-only reference from
			// here) turns every host transient shaped as a `custom` message with STRING content into an
			// append-on-change DURABLE record, and gives host-owned kinds no `clearedText`. That is right
			// for reference material whose staleness is harmless — the path-alias legend is a lookup table
			// that stays true — and wrong for this cue, which is a MUST-protocol directive true for exactly
			// one request. Written durably, "a unit of your work has just ended, reflect now" would sit in
			// history reading as current on every later request forever: the per-request reflection cost
			// this whole delivery boundary exists to remove, plus a standing false claim that reflection is
			// due when it is not, plus one more permanent copy every time the trigger list changes. Block
			// content is the shape that module routes to `passThrough`: converted onto the wire for this
			// request only (`convertToLlm` maps custom content through unchanged), never committed to
			// durable history. `agent-session-prompt`/`agent-session-bash-persistence`/
			// `proactive-reflection-integration` all pin the resulting invariant — no `reflection_cue`
			// ever appears in session entries or `session.messages`.
			content: [
				{
					type: "text",
					text: `${CURRENT_TURN_REFLECTION_CUE}\n- Pending evidence classes: ${current.triggers.join(", ")}.${versionLine}`,
				},
			],
			display: false,
			details: {
				version: 1,
				scope: "root-completed-work",
				automaticProviderRequests: 0,
				cueId: current.cueId,
				triggers: current.triggers,
				...(current.versionChange ? { versionChange: { ...current.versionChange.metadata } } : {}),
			},
			// Derived from the cue state's own updatedAt, never a fresh Date.now() read: this message is
			// rebuilt on every provider request (ProviderRequestContextController.plan), and its text only
			// ever changes when the underlying cue state does (persistCurrentTurnCueState always bumps
			// updatedAt alongside any real change). A wall-clock-at-build-time timestamp made an otherwise
			// byte-identical message differ on every single request, defeating the provider's prefix cache
			// for the whole conversation behind it.
			timestamp: new Date(current.updatedAt).getTime(),
		};
		const isCurrent = (): boolean => {
			const latest = this.getCurrentTurnCueState();
			return (
				this.isAutomaticReflectionEnabled() &&
				latest?.status === expectedStatus &&
				latest.cueId === cueId &&
				latest.revision === revision &&
				latest.activeRunToken === expectedRunToken
			);
		};
		return {
			message,
			isCurrent,
			commit: () => {
				if (!isCurrent()) throw new Error("Reflection cue changed before provider-plan commit");
				const latest = this.getCurrentTurnCueState();
				if (!latest) throw new Error("Reflection cue disappeared before provider-plan commit");
				const activeRunToken = randomUUID();
				this.persistCurrentTurnCueState({
					...latest,
					revision: latest.revision + 1,
					status: "consumed",
					activeRunToken,
					updatedAt: new Date().toISOString(),
				});
				this.activeRunToken = activeRunToken;
			},
		};
	}

	/**
	 * The authoritative end-of-work boundary, called by AgentSession at every `agent_end`.
	 *
	 * Two jobs, one boundary. It settles an accepted cue-bearing run (durable claim completed on a
	 * strict terminal success, released otherwise), AND it promotes a still-`pending` cue to `due` —
	 * the transition that makes the cue deliverable at all. Promotion is what implements the owner's
	 * semantics directly: a cue queued at the start of a root turn becomes deliverable only once that
	 * turn's work has actually ended, and is then carried by the next ordinary provider request rather
	 * than by a request bought for it.
	 *
	 * `willRetry` means the run is not over — the same work is about to be attempted again — so neither
	 * job runs to completion: a pending cue stays pending, and a consumed one returns to `due` (its work
	 * DID end; only its delivery request failed) to be re-offered on the retry.
	 */
	finishCurrentTurnCue(messages: AgentMessage[], options: { willRetry: boolean }): void {
		if (!this.isAutomaticReflectionEnabled()) {
			this.synchronizeCurrentTurnCueWithSettings();
			return;
		}
		const current = this.getCurrentTurnCueState();
		if (current?.status === "pending") {
			if (options.willRetry) return;
			try {
				this.persistCurrentTurnCueState({
					...current,
					revision: current.revision + 1,
					status: "due",
					updatedAt: new Date().toISOString(),
				});
			} catch {
				this.warnOnce(
					"cue-promotion-failed",
					"Automatic reflection cue could not be marked deliverable; its durable claim will expire safely.",
				);
			}
			return;
		}
		if (current?.status !== "consumed" || !current.activeRunToken || current.activeRunToken !== this.activeRunToken) {
			return;
		}
		const state = this.deps.getDurableLearningState?.();
		if (options.willRetry) {
			let versionChange = current.versionChange;
			if (versionChange && !state?.renewClaim(versionChange.token)) versionChange = undefined;
			try {
				this.persistCurrentTurnCueState({
					...current,
					revision: current.revision + 1,
					status: "due",
					activeRunToken: undefined,
					triggers: versionChange
						? current.triggers
						: current.triggers.filter((trigger) => trigger !== "version-change"),
					versionChange,
					updatedAt: new Date().toISOString(),
				});
				this.activeRunToken = undefined;
			} catch {
				this.warnOnce(
					"cue-retry-failed",
					"Automatic reflection cue retry persistence failed; any durable claim will expire safely.",
				);
			}
			return;
		}

		const success = hasStrictSuccessfulAssistantTerminal(messages);
		try {
			this.persistCurrentTurnCueState({
				...current,
				revision: current.revision + 1,
				activeRunToken: undefined,
				updatedAt: new Date().toISOString(),
			});
			this.activeRunToken = undefined;
		} catch {
			this.warnOnce(
				"cue-finish-failed",
				"Automatic reflection cue completion persistence failed; any durable claim will expire safely.",
			);
			return;
		}
		if (!current.versionChange || !state) return;
		const settled = success
			? state.completeReview(current.versionChange.token)
			: state.releaseClaim(current.versionChange.token);
		if (!settled) {
			this.warnOnce(
				"version-claim-settle-failed",
				"Durable version claim no longer matched its exact transition; no semantic memory state was marked complete.",
			);
		}
	}

	/** Pure completed-turn projection used only by deterministic memory synchronization. */
	analyzeCompletedTurn(messages: AgentMessage[]): ReflectionTurnAnalysis {
		const settingsManager = this.deps.getSettingsManager();
		const settings = resolveAutoLearnSettings(
			settingsManager.getAutonomySettings().mode,
			settingsManager.getAutoLearnSettings(),
		);
		return analyzeReflectionTurn(messages, settings.complexTaskToolCalls);
	}

	/**
	 * Run an explicit LLM completion fully ISOLATED from the main session for bounded host-owned
	 * consumers. Automatic reflection never reaches this primitive.
	 *
	 * Isolation invariants (audited by codex): builds fresh context (no main history), defaults to no
	 * tools, and passes **no real `sessionId`** — only a deterministic SYNTHETIC cache-affinity key
	 * (see {@link computeLaneAffinityKey}) derived from `(laneKind, model, systemPrompt)`, which can never
	 * equal or embed the real session id. A tool-enabled call receives only caller-owned tools and hooks,
	 * and applies a turn bound only when its owner explicitly supplies one. It cannot mutate `agent.state.messages`, append session entries, or touch the
	 * foreground tool registry. Mirrors `generateSummary()`'s one-shot mechanics otherwise.
	 *
	 * Returns the result even on an error/aborted stop reason; the explicit caller decides whether to
	 * act, and a model-level error is returned rather than thrown.
	 */
	async runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult> {
		if (opts.maxTurns !== undefined && (!Number.isSafeInteger(opts.maxTurns) || opts.maxTurns <= 0)) {
			throw new Error("runIsolatedCompletion: maxTurns must be a positive safe integer when provided");
		}
		const model = opts.model ?? this.deps.getModel();
		if (!model) {
			throw new Error("runIsolatedCompletion: no model available");
		}
		await this.deps.ensureModelReady(model);
		const thinkingLevel = resolveModelThinkingLevel(model, opts.thinkingLevel, "off");

		// Registered for the full isolated-completion call (one-shot or child-loop) so the
		// reload gate waits it out — this is the SINGLE choke point every isolated completion in the
		// codebase runs through (reflection, research/worker/fitness lanes, context-pipeline curation,
		// model-router judge calls). registerInFlightWork is a pure sync map op (cannot throw), so
		// placing it as the last statement before `try` still guarantees the matching finally always
		// runs, on every return path below and on any thrown error.
		const deregisterInFlight = registerInFlightWork(
			this.deps.getAgentDir(),
			"isolated-completion",
			opts.laneKind ?? DEFAULT_ISOLATED_LANE_KIND,
		);
		try {
			// Fresh, isolated context: explicit messages, caller-owned tools only, nothing from the main session.
			const history = opts.history ?? [];
			const context: AgentContext = {
				systemPrompt: opts.systemPrompt,
				messages: [...history, ...opts.messages],
				tools: opts.tools ?? [],
			};

			// Isolate the prompt cache from the main session by DELIBERATELY never sending the real
			// sessionId. In its place, a deterministic SYNTHETIC affinity key lets providers with
			// session-affinity headers / prompt_cache_key route repeat calls from the SAME lane (same
			// laneKind+model+systemPrompt) to the same cache-warm backend, without entangling this call
			// with — or leaking any identity of — the main session.
			const affinityKey = computeLaneAffinityKey(
				opts.laneKind ?? DEFAULT_ISOLATED_LANE_KIND,
				model,
				opts.systemPrompt,
			);
			const options: SimpleStreamOptions = {
				maxTokens: opts.maxTokens,
				signal: opts.signal,
				interactionMode: "background",
				cacheRetention: opts.cacheRetention,
				reasoning: thinkingLevel,
				sessionId: affinityKey,
			};

			// When streamFn is the raw streamSimple (e.g. in tests), auth must be injected explicitly.
			// Throw only when auth genuinely fails — providers that authenticate without an API key
			// (OAuth, local no-key) legitimately return ok with an undefined apiKey.
			if (this.deps.isRawStreamSimple()) {
				const auth = await this.deps.getModelRegistry().getApiKeyAndHeaders(model);
				if (!auth.ok) {
					throw new Error(auth.error);
				}
				options.apiKey = auth.apiKey;
				options.headers = auth.headers;
			}
			const agent = this.deps.getAgent();
			const foregroundModel = agent.state.model;
			const usesForegroundModel = foregroundModel?.provider === model.provider && foregroundModel.id === model.id;
			const textToolCallProtocol = this.deps.resolveTextToolCallProtocol(model);
			const maxTurns = opts.maxTurns;
			let completedTurns = 0;
			const loopConfig: AgentLoopConfig = {
				model,
				interactionMode: "background",
				maxTokens: opts.maxTokens,
				cacheRetention: opts.cacheRetention,
				reasoning: thinkingLevel,
				// Same synthetic per-lane affinity key as the one-shot path above — never the real sessionId.
				sessionId: affinityKey,
				...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
				...(options.headers !== undefined ? { headers: options.headers } : {}),
				getApiKey: agent.getApiKey,
				resolveRequestReasoning: agent.resolveRequestReasoning,
				temperature: textToolCallProtocol ? 0 : undefined,
				textToolCallProtocol,
				onTextToolProtocolParse: usesForegroundModel ? agent.onTextToolProtocolParse : undefined,
				transport: agent.transport,
				thinkingBudgets: agent.thinkingBudgets,
				maxRetryDelayMs: agent.maxRetryDelayMs,
				// This remains independent from an owner-provided turn budget: it stops only repeated
				// identical tool calls, so legitimate long-running work can continue until completion.
				maxStallTurns: agent.maxStallTurns,
				onRunawayStop: usesForegroundModel ? agent.onRunawayStop : undefined,
				toolExecution: "sequential",
				toolArgumentTeachEnabled: agent.toolArgumentTeachEnabled,
				onToolArgumentValidation: usesForegroundModel ? agent.onToolArgumentValidation : undefined,
				toolValidationEscalationThreshold: agent.toolValidationEscalationThreshold,
				onToolValidationEscalation: usesForegroundModel ? agent.onToolValidationEscalation : undefined,
				beforeToolCall: opts.beforeToolCall,
				afterToolCall: opts.afterToolCall,
				getSteeringMessages: opts.getSteeringMessages,
				getFollowUpMessages: opts.getFollowUpMessages,
				transformContext: opts.transformContext,
				requestPreflight: opts.requestPreflight,
				...(maxTurns === undefined
					? {}
					: {
							shouldStopAfterTurn: () => {
								completedTurns += 1;
								return completedTurns >= maxTurns;
							},
						}),
				convertToLlm: agent.convertToLlm,
			};

			// An explicitly supplied surface owns a child tool loop even when it is empty: a model may
			// hallucinate an unavailable tool and must receive the bounded unknown-tool result so it can
			// repair. Only an omitted tools option selects the one-shot completion path.
			if (opts.tools !== undefined) {
				const childContext: AgentContext = {
					systemPrompt: opts.systemPrompt,
					messages: [...history],
					tools: [...opts.tools],
				};
				const messages = await runAgentLoop(
					opts.messages,
					childContext,
					loopConfig,
					async (event) => {
						// KNOWN TYPE GAP, not an oversight: `event.message` is `AgentMessage` (packages/agent),
						// which - since the turn-economics step-3 host-gap hook - can genuinely be a durable
						// custom transient record (a committed tool-failure ledger or verification obligation),
						// not only `Message`'s narrower {user, assistant, toolResult}. `onMessage`'s parameter
						// is declared `Message` in `IsolatedCompletionOptions` (agent-session-contracts.ts);
						// widening that declaration ripples beyond this fix's scope (every `runIsolatedCompletion`
						// caller: research/fitness/judge lanes, not only worker delegation) and was not made
						// here. This cast forces a wider runtime value into that narrower declared type - see
						// `messages: [...history, ...(messages as Message[])]` below for the matching cast on
						// the return side, and `WorkerTranscriptMessage` in worker-conversation-store.ts, which
						// exists specifically so the two files that DO need the honest wider type (this call's
						// actual worker-delegation consumer) do not also have to cast.
						if (event.type === "message_end") await opts.onMessage?.(event.message as Message, event.origin);
					},
					opts.signal,
					agent.streamFn,
				);
				const assistantMessages = messages.filter(
					(message): message is AssistantMessage => message.role === "assistant",
				);
				let finalAssistant = assistantMessages.at(-1);
				if (!finalAssistant) {
					throw new Error("runIsolatedCompletion: child loop produced no assistant message");
				}

				const hasFinalText = finalAssistant.content.some(
					(content) => content.type === "text" && content.text.trim().length > 0,
				);
				const endedOnToolCall = finalAssistant.content.some((content) => content.type === "toolCall");
				if (opts.finalTextPrompt && !hasFinalText && endedOnToolCall && !opts.signal?.aborted) {
					// A hard turn bound may stop immediately after successful tool execution. Preserve that bound,
					// then allow exactly one tool-free synthesis call so the gathered work is not thrown away.
					const finalizationPrompt: Message = {
						role: "user",
						content: opts.finalTextPrompt,
						timestamp: Date.now(),
					};
					await opts.onMessage?.(finalizationPrompt);
					const finalizationContext: AgentContext = {
						systemPrompt: opts.systemPrompt,
						messages: [...history, ...messages, finalizationPrompt],
						tools: [],
					};
					const finalizationStream = await startAgentProviderRequest(
						finalizationContext,
						loopConfig,
						opts.signal,
						agent.streamFn,
					);
					finalAssistant = await finalizationStream.result();
					await opts.onMessage?.(finalAssistant);
					assistantMessages.push(finalAssistant);
					messages.push(finalizationPrompt, finalAssistant);
				}

				const usage = assistantMessages.reduce<Usage>(
					(total, message) => ({
						input: total.input + message.usage.input,
						output: total.output + message.usage.output,
						cacheRead: total.cacheRead + message.usage.cacheRead,
						cacheWrite: total.cacheWrite + message.usage.cacheWrite,
						totalTokens: total.totalTokens + message.usage.totalTokens,
						cost: {
							input: total.cost.input + message.usage.cost.input,
							output: total.cost.output + message.usage.cost.output,
							cacheRead: total.cost.cacheRead + message.usage.cost.cacheRead,
							cacheWrite: total.cost.cacheWrite + message.usage.cost.cacheWrite,
							total: total.cost.total + message.usage.cost.total,
						},
					}),
					{
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				);
				const text = finalAssistant.content
					.filter((content): content is TextContent => content.type === "text")
					.map((content) => content.text)
					.join("");
				// KNOWN TYPE GAP, not an oversight (see the matching note on the emit callback above): this
				// was once true - "the loop only adds assistant/tool-result messages" - and is not anymore.
				// Since the turn-economics step-3 host-gap hook, `messages` (this run's own `newMessages`,
				// packages/agent's agent-loop.ts) can genuinely include a durable custom transient record.
				// `IsolatedCompletionResult.messages` is declared `Message[]` (agent-session-contracts.ts);
				// making that field, and `IsolatedCompletionOptions.onMessage`'s parameter, honestly wider
				// would touch every `runIsolatedCompletion` caller (research/fitness/judge lanes too, not
				// only worker delegation), which is beyond this fix's granted scope. Documented as an open
				// defect rather than silently left to look intentional - see AGENTS.md's "Delegation and
				// Orchestration" section for the full trace. `worker-attempt-executor.ts` and
				// `worker-conversation-store.ts`'s `WorkerTranscriptMessage` type recover the honest wider
				// type on the read side, immediately after this cast forces it narrow here.
				return {
					text,
					usage,
					stopReason: finalAssistant.stopReason,
					...(finalAssistant.errorMessage ? { errorMessage: finalAssistant.errorMessage } : {}),
					messages: [...history, ...(messages as Message[])],
				};
			}

			for (const message of opts.messages) await opts.onMessage?.(message);
			const stream = await startAgentProviderRequest(context, loopConfig, opts.signal, agent.streamFn);
			const result = await stream.result();
			await opts.onMessage?.(result);
			const text = result.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("");
			const usage: Usage = result.usage ?? {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			return {
				text,
				usage,
				stopReason: result.stopReason,
				...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
				messages: [...history, ...opts.messages, result],
			};
		} finally {
			deregisterInFlight();
		}
	}

	/**
	 * Explicit compatibility/application seam for an owner-invoked structured reflection pass. This
	 * method can make an isolated provider request, so automatic current-turn reflection never calls
	 * it. Demand-gates (zero-I/O), applies resulting writes through the bundled `memory` tool, and
	 * accounts the explicitly requested pass through the spawned-usage surface.
	 *
	 * Returns `null` when the gate skips (or in a child session, which must not learn). The whole pass
	 * is best-effort: a model/parse error yields no writes, never throws into the caller.
	 */
	async runReflectionPass(input: {
		signals: DemandSignals;
		recentTurnText: string;
		model?: Model<Api>;
		thinkingLevel?: ThinkingLevel;
		signal?: AbortSignal;
		/** Stable id so a duplicate scheduling/retry of the same pass can't double-count its cost. */
		reportId?: string;
		/** True only when every turn in this pass explicitly asked Pi to remember durable information. */
		explicitUserMemoryInstruction?: boolean;
	}): Promise<ReflectionResult | null> {
		if (this.deps.isChildSession() || this.deps.isDisposed()) return null;
		const plan = decideDemand(input.signals);
		if (plan.act === "skip") return null;

		// Bug #21: tie this background pass to the session lifetime. Disposing the session aborts the
		// in-flight completion (input.signal can add a more specific abort).
		const signal = input.signal
			? AbortSignal.any([input.signal, this.deps.getReflectionSignal()])
			: this.deps.getReflectionSignal();

		const complete = (systemPrompt: string, userPrompt: string) =>
			this.runIsolatedCompletion({
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
				model: input.model,
				thinkingLevel: input.thinkingLevel ?? "low",
				maxTokens: plan.tokenBudget,
				signal,
				// The reflection system prompt is static (#33) — let the provider cache the prefix so
				// repeated passes only pay for the variable tail.
				cacheRetention: "short",
				laneKind: "reflection",
			});

		const result = await new ReflectionEngine().reflect({
			recentTurnText: input.recentTurnText,
			// Read memory FRESH (not the prefix-cache-frozen system-prompt block) so confront-before-write
			// sees writes made earlier this session, including bounded structured OKF records.
			existingMemory: [
				this.deps.getMemoryManager().buildSystemPromptBlockFresh(),
				this.deps.getFreshOkfMemoryForReflection(),
			]
				.filter((block) => block.trim().length > 0)
				.join("\n\n"),
			plan,
			complete,
		});

		// Bug #21: if the session was disposed while the completion was in flight, do NOT write memory
		// or skills against the dead session.
		if (this.deps.isDisposed()) return result;

		// Learning apply policy: every durable write is converted to a proposal, decided by the
		// learning gate, and audited with a rollback plan. When the policy is explicitly disabled,
		// legacy direct-apply behavior is preserved — but now leaves audit records with rollback info.
		const policy = this.deps.getSettingsManager().getLearningPolicySettings();
		// The audit id sequence counts STORED snapshots only: it reseeds from the stored count on
		// every pass, so advancing it for a no-op (which stores nothing) would make later passes
		// reuse ids — and rollback keys on the id, so a collision blocks or misdirects rollback.
		let auditSequence = getLearningAuditSnapshots(this.deps.getSessionManager().getEntries()).length;
		// G6 evidence strength: durable proposals accumulate observation counts across passes/sessions
		// so the gate can distinguish a one-off cue from a repeatedly-confirmed lesson. Built once per
		// pass; every increment is best-effort (store IO must never break reflection).
		const observationStore = ObservationStore.forAgentDir(this.deps.getAgentDir());
		let writeIndex = 0;
		for (const write of result.writes) {
			writeIndex += 1;
			const proposalId = `${input.reportId ?? "reflection"}-w${writeIndex}`;
			const proposal = proposalFromReflectionWrite(write, proposalId);
			const plannedRollback = rollbackPlanForReflectionWrite(write);
			let observations = 1;
			if (policy.enabled) {
				try {
					observations = observationStore.increment(observationKey(proposal.layer, proposal.summary));
				} catch {
					// A store read/write failure falls back to a fresh count of 1, which keeps the gate
					// proposal-first (never spuriously auto-applies) rather than crashing the pass.
					observations = 1;
				}
			}
			const explicitUserMemoryWrite =
				input.explicitUserMemoryInstruction === true &&
				(write.kind === "memory_add" || write.kind === "memory_replace");
			// Additive skill promotion is the skill counterpart of a memory fact: a repeatable
			// procedure should land as a loadable SKILL.md (overlap audit still holds the write).
			// An owner who enabled auto-apply and omitted "skill" from the allow-list keeps that ceiling.
			const ownerExcludedSkillLayer =
				policy.enabled && policy.autoApplyEnabled && !policy.allowedAutoApplyLayers.includes("skill");
			const additiveSkillPromotion = write.kind === "promote_skill" && !ownerExcludedSkillLayer;
			let decision: LearningDecision;
			if (explicitUserMemoryWrite) {
				decision = {
					kind: "apply",
					reasonCode: "explicit_user_memory_instruction",
					confidence: 100,
					summary: proposal.summary,
					requiresApproval: false,
				};
			} else if (additiveSkillPromotion) {
				decision = {
					kind: "apply",
					reasonCode: "additive_skill_promotion",
					confidence: policy.reflectionSourceConfidence,
					summary: proposal.summary,
					requiresApproval: false,
				};
			} else if (policy.enabled) {
				decision = evaluateLearningDecision({
					proposal,
					confidence: policy.reflectionSourceConfidence,
					observations,
					// A replace/remove supersedes an existing durable fact — the reflection engine's
					// confront-before-write conflict signal — so it routes through approval instead of
					// silently overwriting prior memory. Additive writes contradict nothing.
					contradictions: contradictionsForReflectionWrite(write),
					settings: {
						enabled: true,
						autoApplyEnabled: policy.autoApplyEnabled,
						confidenceThreshold: policy.confidenceThreshold,
						minObservations: policy.minObservations,
						allowedAutoApplyLayers: policy.allowedAutoApplyLayers,
						requireRollbackPlan: policy.requireRollbackPlan,
						autoApplySupersessions: policy.autoApplySupersessions,
					},
				});
			} else {
				decision = {
					kind: "apply",
					reasonCode: "learning_policy_disabled_legacy_apply",
					confidence: 0,
					summary: proposal.summary,
					requiresApproval: false,
				};
			}

			this.deps.saveLearningDecisionSnapshot(decision);
			// G3: learning-gate outcome. Codes/numbers only — never the proposal summary/memory text.
			this.deps.emitAutonomyTelemetry({
				type: AUTONOMY_TELEMETRY_EVENT_TYPES.learningDecision,
				timestamp: new Date().toISOString(),
				payload: {
					kind: decision.kind,
					reasonCode: decision.reasonCode,
					layer: proposal.layer,
					confidence: decision.confidence,
					requiresApproval: decision.requiresApproval,
				},
			});
			// G8: a proposal that needs human sign-off is an approval REQUEST. Codes/layer only —
			// never the proposal summary/memory text (those live only in the audit snapshot).
			if (decision.requiresApproval) {
				this.deps.emitAutonomyTelemetry({
					type: AUTONOMY_TELEMETRY_EVENT_TYPES.approvalRequest,
					timestamp: new Date().toISOString(),
					payload: {
						kind: decision.kind,
						reasonCode: decision.reasonCode,
						layer: proposal.layer,
					},
				});
			}
			// An automatic skill promotion the gate would otherwise apply must still clear the same
			// skill_audit overlap check the model-invoked `skillify` tool enforces — otherwise reflection
			// can silently write a near-duplicate SKILL.md. A non-overlapping skill is unaffected
			// (skillPromotionBlock stays undefined) and promotes exactly as before.
			const skillPromotionBlock =
				write.kind === "promote_skill" && decision.kind === "apply"
					? this._checkSkillPromotionOverlap(write)
					: undefined;

			// The gate's decision and the write's actual outcome are two different questions: the memory
			// tool can refuse a write (budget exceeded, drift, threat) via details.success:false without
			// throwing. Capture that outcome instead of assuming "decision.kind === apply" means it landed
			// — otherwise a refused write leaves a phantom "apply" audit whose rollback later fails
			// not-found (or, worse, misfires against whatever now occupies that text).
			const applyResult =
				decision.kind === "apply" && !skillPromotionBlock
					? await this._applyReflectionWrite(write, signal)
					: { applied: false };
			const writeFailed = decision.kind === "apply" && !skillPromotionBlock && !applyResult.applied;
			if (decision.kind !== "no-op") {
				auditSequence += 1;
				appendLearningAuditSnapshot(this.deps.getSessionManager(), {
					id: `audit-${auditSequence}`,
					proposalId,
					layer: proposal.layer,
					action: skillPromotionBlock
						? "propose"
						: writeFailed
							? "apply_failed"
							: decision.kind === "apply"
								? "apply"
								: "propose",
					summary: skillPromotionBlock ? `${proposal.summary} — ${skillPromotionBlock.note}` : proposal.summary,
					reasonCode: skillPromotionBlock
						? skillPromotionBlock.reasonCode
						: writeFailed
							? APPLY_WRITE_REFUSED_REASON_CODE
							: decision.reasonCode,
					decision,
					// No rollback plan on a failed apply or a held/proposed promotion — nothing durable
					// landed in either case, so there is nothing to undo.
					rollback:
						decision.kind === "apply" && !skillPromotionBlock && !writeFailed
							? (applyResult.rollback ?? plannedRollback)
							: undefined,
					createdAt: new Date().toISOString(),
				});
			}
		}

		// Account the reflection's spend so it surfaces in the footer roll-up (net-token visibility).
		// Idempotent on reportId so a retried/duplicated pass cannot double-count.
		if (result.usage.cost.total > 0 || result.usage.totalTokens > 0) {
			this.deps.addSpawnedUsage(result.usage, { label: "reflection", reportId: input.reportId });
		}
		return result;
	}

	getLearningAuditRecords(): LearningAuditRecord[] {
		return getLearningAuditSnapshots(this.deps.getSessionManager().getEntries());
	}

	/**
	 * Roll back one applied durable learning change by executing the inverse operation recorded in
	 * its audit record (memory ops run through the same bundled memory-tool path as the original
	 * apply; promoted skills are archived). Appends a linked "rollback" audit record on success so
	 * the change history stays complete and a change cannot be rolled back twice.
	 */
	async rollbackLearningWrite(auditId: string): Promise<{ ok: boolean; reason: string }> {
		if (this.deps.isDisposed()) return { ok: false, reason: "session_disposed" };

		const audits = this.getLearningAuditRecords();
		const audit = audits.find((record) => record.id === auditId);
		if (!audit) return { ok: false, reason: "audit_not_found" };
		if (audit.action !== "apply") return { ok: false, reason: "not_an_applied_change" };
		if (audits.some((record) => record.action === "rollback" && record.rollbackOf === auditId)) {
			return { ok: false, reason: "already_rolled_back" };
		}
		const rollback = audit.rollback;
		if (!rollback) return { ok: false, reason: "no_rollback_plan" };

		// Every inverse must be VERIFIED-applied before the rollback audit is appended: a silently
		// failed inverse that still recorded "rollback" would permanently self-lock the change
		// behind already_rolled_back while the durable write is in fact still live.
		switch (rollback.kind) {
			case "memory_remove": {
				if (!rollback.target) return { ok: false, reason: "missing_rollback_target" };
				if (!(await this._applyReflectionWrite({ kind: "memory_remove", target: rollback.target })).applied) {
					return { ok: false, reason: "rollback_apply_failed" };
				}
				break;
			}
			case "memory_restore": {
				if (!rollback.target || rollback.previous === undefined) {
					return { ok: false, reason: "missing_rollback_target" };
				}
				const applied = await this._applyReflectionWrite({
					kind: "memory_replace",
					target: rollback.target,
					text: rollback.previous,
				});
				if (!applied.applied) return { ok: false, reason: "rollback_apply_failed" };
				break;
			}
			case "memory_add": {
				if (rollback.previous === undefined) return { ok: false, reason: "missing_rollback_target" };
				const applied = await this._applyReflectionWrite({
					kind: "memory_add",
					section: "MEMORY",
					text: rollback.previous,
				});
				if (!applied.applied) return { ok: false, reason: "rollback_apply_failed" };
				break;
			}
			case "okf_remove": {
				const target = parseOkfRollbackTarget(rollback.target);
				if (!target) return { ok: false, reason: "missing_rollback_target" };
				const applied = await this.deps.rollbackStructuredReflectionWrite({
					...target,
					expectedDigest: rollback.expectedDigest,
					removeRecord: true,
				});
				if (!applied) return { ok: false, reason: "rollback_apply_failed" };
				break;
			}
			case "okf_organize": {
				if (!rollback.target || rollback.previous === undefined) {
					return { ok: false, reason: "missing_rollback_target" };
				}
				const target = parseOkfRollbackTarget(rollback.target);
				if (!target) return { ok: false, reason: "missing_rollback_target" };
				const applied = await this.deps.rollbackStructuredReflectionWrite({
					...target,
					expectedDigest: rollback.expectedDigest,
					sourceText: rollback.previous,
					removeRecord: rollback.removeOkf === true,
				});
				if (!applied) return { ok: false, reason: "rollback_apply_failed" };
				break;
			}
			case "archive_skill": {
				if (!rollback.target) return { ok: false, reason: "missing_rollback_target" };
				if (!this.deps.archivePromotedSkill(rollback.target)) {
					return { ok: false, reason: "skill_archive_failed" };
				}
				this.deps.refreshLiveSkills?.();
				break;
			}
		}

		appendLearningAuditSnapshot(this.deps.getSessionManager(), {
			id: `${audit.id}-rollback`,
			proposalId: audit.proposalId,
			layer: audit.layer,
			action: "rollback",
			summary: `Rolled back: ${audit.summary}`,
			reasonCode: "user_requested_rollback",
			decision: audit.decision,
			rollbackOf: audit.id,
			createdAt: new Date().toISOString(),
		});
		return { ok: true, reason: "rollback_applied" };
	}

	/**
	 * Apply one reflection write through the bundled `memory` tool. `memory_replace`/`memory_remove`
	 * don't carry a target file, so we try MEMORY.md first and fall back to USER.md when the substring
	 * isn't found there. Never throws (reflection must never break a turn); returns whether the write
	 * actually applied so callers that MUST know — rollback's once-only accounting — can react instead
	 * of recording a success that never happened.
	 */
	private async _applyReflectionWrite(write: ReflectionWrite, signal?: AbortSignal): Promise<ReflectionApplyResult> {
		// R7 memory-to-behavior: a recurring procedure is compiled into an executable skill file rather
		// than stored as a flat fact. Written under the agent skills dir so it loads like any user skill.
		if (write.kind === "promote_skill") {
			const promoted = this._promoteReflectionSkill(write.name, write.description, write.body);
			if (promoted) this.deps.refreshLiveSkills?.();
			return { applied: promoted };
		}
		if (write.kind === "okf_add" || write.kind === "okf_organize") {
			try {
				const result = await this.deps.applyStructuredReflectionWrite(write, signal);
				if (!result.applied || result.digest === undefined) return { applied: false };
				return {
					applied: true,
					rollback:
						write.kind === "okf_add"
							? {
									kind: "okf_remove",
									target: `${write.type}\0${write.title}`,
									expectedDigest: result.digest,
									instructions: "Remove only the exact structured OKF record created by this reflection.",
								}
							: {
									kind: "okf_organize",
									target: `${write.type}\0${write.title}`,
									previous: write.sourceText,
									expectedDigest: result.digest,
									removeOkf: result.created,
									instructions:
										"Restore the exact hot-memory source first, then remove only the OKF record created by this reflection.",
								},
				};
			} catch {
				return { applied: false };
			}
		}

		type MemResult = { details?: { success?: boolean; error?: string } };
		type MemExec = (
			toolCallId: string,
			params: {
				action: string;
				target: string;
				content?: string;
				oldContent?: string;
				type?: string;
				title?: string;
				description?: string;
				scope?: string;
				tags?: string[];
				evidenceRefs?: string[];
			},
			signal: AbortSignal | undefined,
			onUpdate: undefined,
			ctx: undefined,
		) => Promise<MemResult>;
		const memTool = this.deps
			.getMemoryManager()
			.getToolDefinitions()
			.find((t) => t.name === "memory");
		const exec = memTool?.execute as unknown as MemExec | undefined;
		if (!exec) return { applied: false };

		const run = (params: Parameters<MemExec>[1]) => exec("reflection", params, signal, undefined, undefined);

		if (write.kind === "memory_add") {
			try {
				const res = await run({
					action: "add",
					target: write.section === "USER" ? "user" : "memory",
					content: write.text,
				});
				return { applied: res?.details?.success === true };
			} catch {
				// best-effort; reflection writes must never throw into the turn loop
				return { applied: false };
			}
		}

		// replace / remove carry no target file — try MEMORY.md, then USER.md. The memory tool reports
		// outcomes via `details.success` (it catches its own errors rather than throwing). Only a
		// genuine "not found in the file" justifies trying the other file; a real failure for a file
		// (budget exceeded / drift) must NOT fall through and mutate the wrong target.
		for (const target of ["memory", "user"] as const) {
			try {
				const params =
					write.kind === "memory_replace"
						? { action: "replace", target, oldContent: write.target, content: write.text }
						: { action: "remove", target, oldContent: write.target };
				const res = await run(params);
				if (res?.details?.success === true) return { applied: true }; // applied
				if (!/not found/i.test(String(res?.details?.error ?? ""))) return { applied: false }; // real failure
				// substring simply absent from this file — try the next target
			} catch {
				// defensive: if the tool ever does throw, try the next target
			}
		}
		return { applied: false };
	}

	/**
	 * The same skill_audit overlap check the model-invoked `skillify` tool enforces
	 * (tools/skillify.ts → tools/skill-audit.ts's `runSkillAudit`), run before an AUTOMATIC promotion
	 * so the reflection engine can never silently write a near-duplicate SKILL.md. Reuses the audit
	 * seam unchanged (never duplicated) against the same already-loaded skills universe skillify
	 * compares a draft against. Returns a block reason when the draft overlaps an existing skill above
	 * the audit's own similarity threshold, or when the audit itself fails (the promotion is held, not
	 * written unaudited); undefined when clear to promote. Never throws — mirrors every other
	 * best-effort check in this file.
	 */
	private _checkSkillPromotionOverlap(write: {
		name: string;
		description: string;
		body: string;
	}): { reasonCode: string; note: string } | undefined {
		try {
			const cwd = this.deps.getCwd?.() ?? process.cwd();
			const audit = runSkillAudit(
				cwd,
				write,
				this.deps.getSkillsForAudit?.(),
				undefined,
				DEFAULT_BOUNDED_SKILL_AUDIT_LIMITS,
			);
			if (audit.truncated) {
				return {
					reasonCode: SKILL_AUDIT_UNAVAILABLE_REASON_CODE,
					note: "skill overlap audit exceeded its bounded universe; promotion held rather than written unaudited",
				};
			}
			const overlap = audit.nearDuplicates.find((d) => d.a === "[draft]" || d.b === "[draft]");
			if (!overlap) return undefined;
			const otherPath = overlap.a === "[draft]" ? overlap.b : overlap.a;
			// Every skill file is named "SKILL.md" — unlike skillify's own display formatter (which takes
			// the path's last segment and always shows that literal filename), look up the declared
			// frontmatter name so the proposal actually names the skill it overlaps with.
			const otherName = audit.skills.find((s) => s.path === otherPath)?.name ?? otherPath;
			return {
				reasonCode: SKILL_OVERLAP_CONSOLIDATION_REASON_CODE,
				note: `overlaps existing skill "${otherName}" (${(overlap.similarity * 100).toFixed(0)}% similar) — consolidation proposed instead of a duplicate write`,
			};
		} catch {
			// Bounded, observable degradation via the promote path's existing error-reporting shape: an
			// audit failure must never throw into the reflection pass, but it also must not silently
			// fall through to an unaudited write — hold the promotion and record why.
			return {
				reasonCode: SKILL_AUDIT_UNAVAILABLE_REASON_CODE,
				note: "skill overlap audit failed; promotion held rather than written unaudited",
			};
		}
	}

	/**
	 * R7: write a reflection-promoted skill as `<agentDir>/skills/<name>/SKILL.md` so it loads like any
	 * user skill. Best-effort; never clobbers an existing (hand-authored) skill of the same name. The
	 * overlap audit runs at the call site in {@link runReflectionPass} — a write only reaches here
	 * once the draft has already cleared it.
	 */
	private _promoteReflectionSkill(rawName: string, description: string, body: string): boolean {
		const name = rawName
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64);
		if (!name || !body.trim()) return false;
		try {
			const dir = join(this.deps.getAgentDir(), "skills", name);
			const file = join(dir, "SKILL.md");
			if (existsSync(file)) return false; // do not overwrite an existing skill
			mkdirSync(dir, { recursive: true });
			const safeDescription = description.replace(/[\r\n]+/g, " ").trim();
			// `promoted: true` marks this as reflection-generated so the curator (#32) can lifecycle-manage
			// it (archive/consolidate) WITHOUT ever touching hand-authored user skills.
			const content = `---\nname: ${name}\ndescription: ${safeDescription}\npromoted: true\n---\n\n<!-- Auto-generated by the reflection engine (R7 memory-to-behavior). Review and refine. -->\n\n${body.trim()}\n`;
			writeFileSync(file, content, "utf-8");
			return true;
		} catch {
			// promotion must never break a turn
			return false;
		}
	}
}
