import { createHash } from "node:crypto";
import { classifyFailure } from "@caupulican/pi-agent-core/reliability";
import { MAX_SESSION_ENTRY_VISIT_COUNT, type SessionManager } from "@caupulican/pi-agent-core/session";
import type { AgentMessage, AgentRunawayStopInfo } from "@caupulican/pi-agent-core/types";
import type { AssistantMessage } from "@caupulican/pi-ai";
import {
	type GoalContinuationLoopOptions,
	type GoalContinuationLoopResult,
	type GoalContinuationOnceOptions,
	type GoalContinuationOnceResult,
	isInterruptedAssistantStopReason,
	type PromptOptions,
} from "../agent-session-contracts.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { BackgroundToolTaskRef } from "../background-tool-task-controller.ts";
import { GoalLoopController } from "../goal-loop-controller.ts";
import { budgetedTokens } from "../orchestration/capability-gateway.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { GoalBudgetExhaustedError } from "./goal-execution-errors.ts";
import { type GoalStateRevision, getGoalStateRevision, stopGoalFromSystem } from "./goal-lifecycle.ts";
import {
	buildGoalRuntimeSnapshot,
	type GoalRuntimeSnapshot,
	type GoalRuntimeSnapshotSettings,
} from "./goal-runtime-snapshot.ts";
import { applyGoalEvent, type GoalState, isGoalExecutionActive, isGoalUnfinishedStatus } from "./goal-state.ts";
import { applyGoalAction } from "./goal-tool-core.ts";
import {
	type ExplicitGoalStartAuthority,
	parseExplicitChatGoal,
	priorUserPromptText,
} from "./natural-language-goal.ts";
import {
	appendGoalClearedSnapshot,
	appendGoalStateSnapshot,
	getLatestGoalStateSnapshot,
} from "./session-goal-state.ts";

export interface GoalSessionControllerDeps {
	getSessionManager(): SessionManager;
	getModelProvider(): string | undefined;
	getLaneRecords(): readonly LaneRecord[];
	getTaskRuntimeSnapshot(): TaskRuntimeProjection | undefined;
	getBackgroundToolTasks(): readonly BackgroundToolTaskRef[];
	synchronizeGoalState(state: GoalState): void;
	scheduleGoalAutoContinueFromIdle(): void;
	prompt(text: string, options?: PromptOptions): Promise<void>;
	emitWarning(message: string): void;
}

export type ChatGoalAdmission =
	| { status: "not_explicit" }
	| { status: "started"; state: GoalState }
	| { status: "unfinished_goal_exists"; state: GoalState };

/**
 * Smallest remaining goal budget worth handing to the provider as one more request's OUTPUT cap.
 * `admitProviderRequest` returns the goal's remaining TOTAL budget (input+output, cache-weighted) as
 * that cap — correct only because it also narrows further downstream against the model's real output
 * limit. When remaining drops below this floor (e.g. 200k budget, 199.4k used → 600 remaining), handing
 * 600 to the provider as maxTokens produces a request that pays the FULL input cost of the turn only to
 * get cut off mid-generation (`stopReason: "length"`) — a doomed, wasted turn. Below the floor, stop
 * the goal cleanly BEFORE sending instead of gambling on a truncated one. Above it, the remaining-total
 * value is a generous (imprecise but safe) protective ceiling — a modest final-turn overrun is
 * acceptable; a truncated turn is not.
 */
const MIN_VIABLE_GOAL_TURN_OUTPUT_TOKENS = 1_000;

const goalExecutionLeaseMarker: unique symbol = Symbol("goalExecutionLease");

/** Identity-bound attribution for one goal-owned foreground execution. */
export interface GoalExecutionLease {
	readonly goalId?: string;
	readonly [goalExecutionLeaseMarker]: true;
}

interface MutableGoalExecutionLease extends GoalExecutionLease {
	goalId?: string;
	adoptNewGoal: boolean;
	adoptionBaselineGoalId?: string;
	provisionalTokenBudget?: number;
	pendingTokens: number;
	pendingSpendUsd: number;
	/** Set once this lease has admitted a provider request while its goal was still active. Lets a
	 * later admission on the SAME still-held lease recognize "the goal ended mid-turn" (drain the
	 * in-flight turn's wrap-up response) instead of "a new turn is starting against a dead goal"
	 * (which stays denied). */
	admittedWhileActive: boolean;
}

interface QueuedOwnerChatGoal {
	text: string;
	authority: ExplicitGoalStartAuthority;
}

/**
 * Owns durable goal state, exact continuation accounting, and the raw continuation loop. The
 * AgentSession facade supplies process collaborators but no longer implements goal lifecycle rules.
 */
export class GoalSessionController {
	private readonly deps: GoalSessionControllerDeps;
	private readonly loop: GoalLoopController;
	private executionLease: MutableGoalExecutionLease | undefined;
	private startAuthority: ExplicitGoalStartAuthority | undefined;
	private readonly queuedOwnerChatGoals = new WeakMap<AgentMessage, QueuedOwnerChatGoal>();
	private queuedOwnerChatExecutionLease: GoalExecutionLease | undefined;

	constructor(deps: GoalSessionControllerDeps) {
		this.deps = deps;
		this.loop = new GoalLoopController({
			getGoalRuntimeSnapshot: (settings) => this.getRuntimeSnapshot(settings),
			prompt: async (text, options) => {
				const firstTurnEntryIndex = this.deps.getSessionManager().getEntryCount();
				await this.deps.prompt(text, options);
				return this.getContinuationTurnOutcome(firstTurnEntryIndex);
			},
			recordGoalContinuationPass: (pass) => this.recordContinuationPass(pass),
			recordGoalContinuationFailure: (error) => this.recordContinuationFailure(error),
			markGoalBudgetLimited: (reason) => this.markBudgetLimited(reason),
		});
	}

	private getContinuationTurnOutcome(firstTurnEntryIndex: number): "completed" | "interrupted" {
		const sessionManager = this.deps.getSessionManager();
		const endIndex = sessionManager.getEntryCount();
		let nextIndex = firstTurnEntryIndex;
		let lastAssistantStopReason: AssistantMessage["stopReason"] | undefined;
		while (nextIndex < endIndex) {
			const visitCount = Math.min(MAX_SESSION_ENTRY_VISIT_COUNT, endIndex - nextIndex);
			nextIndex = sessionManager.visitEntries(nextIndex, visitCount, (entry) => {
				if (entry.type === "message" && entry.message.role === "assistant") {
					lastAssistantStopReason = entry.message.stopReason;
				}
			});
		}
		return isInterruptedAssistantStopReason(lastAssistantStopReason) ? "interrupted" : "completed";
	}

	saveState(state: GoalState, expected?: GoalStateRevision): string {
		const current = this.getState();
		if (
			expected &&
			(!current || current.goalId !== expected.goalId || (current.revision ?? 0) !== expected.revision)
		) {
			throw new Error(
				`Goal state changed concurrently; expected ${expected.goalId}@${expected.revision}, found ${current ? `${current.goalId}@${current.revision ?? 0}` : "none"}. Retry against the latest state.`,
			);
		}
		const entryId = appendGoalStateSnapshot(this.deps.getSessionManager(), state, current);
		try {
			this.deps.synchronizeGoalState(state);
		} catch (error) {
			this.deps.emitWarning(
				`Goal state persisted but durable worker reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return entryId;
	}

	clearState(state: GoalState, now: string): string {
		const current = this.getState();
		const expected = getGoalStateRevision(state);
		if (!current || current.goalId !== expected.goalId || (current.revision ?? 0) !== expected.revision) {
			throw new Error("Goal state changed concurrently; retry clear against the latest state.");
		}
		if (state.status !== "completed" && state.status !== "cancelled") {
			this.deps.synchronizeGoalState(applyGoalEvent(state, { type: "cancel_goal", now }));
		}
		return appendGoalClearedSnapshot(this.deps.getSessionManager(), state, now);
	}

	getState(): GoalState | undefined {
		return getLatestGoalStateSnapshot(this.deps.getSessionManager());
	}

	/**
	 * Promote high-confidence natural-language persistence into the same durable state written by the
	 * goal tool. This is intentionally narrower than task detection: ordinary work never starts a
	 * goal, and an unfinished goal is never replaced implicitly.
	 */
	admitOwnerChatGoal(text: string, messages: readonly { role: string; content?: unknown }[]): ChatGoalAdmission {
		return this.admitExplicitChatGoal(text, undefined, priorUserPromptText(messages, text));
	}

	startOwnerChatGoal(text: string, messages: readonly { role: string; content?: unknown }[]): string | undefined {
		const admission = this.admitOwnerChatGoal(text, messages);
		if (admission.status === "started") return admission.state.goalId;
		if (admission.status === "unfinished_goal_exists") {
			this.deps.emitWarning(
				`Explicit chat goal was not started because unfinished goal '${admission.state.goalId}' is ${admission.state.status}. Complete, clear, or explicitly replace it first.`,
			);
		}
		return undefined;
	}

	queueOwnerChatGoal(message: AgentMessage, text: string, authority: ExplicitGoalStartAuthority): void {
		this.queuedOwnerChatGoals.set(message, { text, authority });
	}

	activateQueuedOwnerChatGoal(message: AgentMessage, messages: readonly { role: string; content?: unknown }[]): void {
		const queued = this.queuedOwnerChatGoals.get(message);
		if (!queued) return;
		this.queuedOwnerChatGoals.delete(message);
		const goalId = this.startOwnerChatGoal(queued.text, messages);
		if (!goalId) return;
		this.setStartAuthority(queued.authority);
		const lease = this.beginExecution(goalId);
		if (!lease) {
			this.setStartAuthority(undefined);
			return;
		}
		this.queuedOwnerChatExecutionLease = lease;
	}

	endQueuedOwnerChatGoalExecution(): void {
		const lease = this.queuedOwnerChatExecutionLease;
		if (!lease) return;
		this.queuedOwnerChatExecutionLease = undefined;
		this.setStartAuthority(undefined);
		this.endExecution(lease);
	}

	admitExplicitChatGoal(text: string, now?: string, priorUserText?: string): ChatGoalAdmission {
		const admittedAt = now ?? new Date().toISOString();
		const parsed = parseExplicitChatGoal(text, priorUserText);
		if (!parsed) return { status: "not_explicit" };
		const current = this.getState();
		if (current && isGoalUnfinishedStatus(current.status)) {
			return { status: "unfinished_goal_exists", state: current };
		}
		const digest = createHash("sha256")
			.update(`${admittedAt}\0${current?.goalId ?? "none"}\0${parsed.objective}`)
			.digest("hex")
			.slice(0, 20);
		const result = applyGoalAction(
			current,
			{
				action: "start",
				goalId: `chat-${digest}`,
				userGoal: parsed.objective,
				tokenBudget: parsed.tokenBudget,
			},
			admittedAt,
		);
		if (!result.ok) throw new Error(result.error);
		this.saveState(result.state, current ? getGoalStateRevision(current) : undefined);
		return { status: "started", state: result.state };
	}

	/** Attribute turn/wall-clock telemetry without inferring progress (public/manual accounting seam). */
	recordContinuationTelemetry(pass: { turns: number; wallClockMs: number }): void {
		this.persistContinuationPass(pass);
	}

	/** Attribute one host-driven pass and derive stall state from the authoritative revision. */
	private recordContinuationPass(pass: {
		turns: number;
		wallClockMs: number;
		goalId: string;
		progressRevision: number;
		stallTurns: number;
	}): void {
		this.persistContinuationPass(pass);
	}

	private persistContinuationPass(
		pass: { turns: number; wallClockMs: number } & Partial<
			Pick<GoalState, "goalId" | "progressRevision" | "stallTurns">
		>,
	): void {
		const state = this.getState();
		if (!state) return;
		if (pass.goalId !== undefined && state.goalId !== pass.goalId) {
			this.deps.emitWarning(
				`Goal continuation accounting skipped because goal '${pass.goalId}' was replaced by '${state.goalId}' during the pass.`,
			);
			return;
		}
		const now = new Date().toISOString();
		let updated = applyGoalEvent(state, {
			type: "record_continuation_budget",
			turns: pass.turns,
			wallClockMs: pass.wallClockMs,
			tokens: 0,
			spendUsd: 0,
			now,
		});
		if (
			pass.progressRevision !== undefined &&
			pass.stallTurns !== undefined &&
			isGoalExecutionActive(state.status) &&
			(state.progressRevision ?? 0) <= pass.progressRevision &&
			state.stallTurns <= pass.stallTurns
		) {
			updated = applyGoalEvent(updated, { type: "no_progress", now });
		}
		this.saveState(updated, getGoalStateRevision(state));
	}

	/** Begin one foreground execution whose provider usage belongs to the specified active goal. */
	beginExecution(
		goalId: string | undefined,
		options: { adoptNewGoal?: boolean; provisionalTokenBudget?: number } = {},
	): GoalExecutionLease | undefined {
		if (!goalId && !options.adoptNewGoal) return undefined;
		if (this.executionLease) throw new Error("Goal execution attribution is already active");
		const state = this.getState();
		if (goalId && (!state || state.goalId !== goalId || !isGoalExecutionActive(state.status))) return undefined;
		const lease: MutableGoalExecutionLease = {
			...(goalId ? { goalId } : {}),
			[goalExecutionLeaseMarker]: true,
			adoptNewGoal: options.adoptNewGoal === true,
			...(options.adoptNewGoal && state ? { adoptionBaselineGoalId: state.goalId } : {}),
			...(options.provisionalTokenBudget !== undefined
				? { provisionalTokenBudget: options.provisionalTokenBudget }
				: {}),
			pendingTokens: 0,
			pendingSpendUsd: 0,
			admittedWhileActive: false,
		};
		this.executionLease = lease;
		return lease;
	}

	endExecution(lease: GoalExecutionLease | undefined): void {
		if (!lease) return;
		if (this.executionLease !== lease) throw new Error("Cannot end goal execution attribution owned by another run");
		this.flushPendingExecutionUsage(this.executionLease);
		this.executionLease = undefined;
	}

	/** Charge one observed assistant response exactly once, including routed responses buffered from persistence. */
	recordExecutionUsage(message: AssistantMessage): void {
		const lease = this.executionLease;
		if (!lease) return;
		const tokens = budgetedTokens({
			inputTokens: Math.max(0, message.usage.input),
			outputTokens: Math.max(0, message.usage.output),
			cacheReadTokens: Math.max(0, message.usage.cacheRead),
			cacheWriteTokens: Math.max(0, message.usage.cacheWrite),
			totalTokens: Math.max(0, message.usage.totalTokens),
		});
		const spendUsd = Math.max(0, message.usage.cost.total);
		if (tokens === 0 && spendUsd === 0) return;
		const state = this.resolveExecutionState(lease);
		if (!state) {
			lease.pendingTokens += tokens;
			lease.pendingSpendUsd += spendUsd;
			return;
		}
		this.chargeExecutionUsage(lease, state, tokens, spendUsd);
	}

	private chargeExecutionUsage(
		lease: MutableGoalExecutionLease,
		state: GoalState,
		tokens: number,
		spendUsd: number,
	): void {
		const updated = applyGoalEvent(state, {
			type: "record_continuation_budget",
			turns: 0,
			wallClockMs: 0,
			tokens,
			spendUsd,
			now: new Date().toISOString(),
		});
		this.saveState(updated, getGoalStateRevision(state));
		lease.pendingTokens = 0;
		lease.pendingSpendUsd = 0;
		if (
			isGoalExecutionActive(updated.status) &&
			updated.tokenBudget !== undefined &&
			(updated.tokensUsed ?? 0) >= updated.tokenBudget
		) {
			this.markBudgetLimited(
				`token budget exhausted (${updated.tokensUsed ?? 0}/${updated.tokenBudget}) during goal execution`,
			);
		}
	}

	markProtocolFailureBlocked(errorMessage: string): boolean {
		const lease = this.executionLease;
		if (!lease) return false;
		const state = this.resolveExecutionState(lease);
		if (!state || !isGoalExecutionActive(state.status)) return false;
		const stopped = stopGoalFromSystem(
			state,
			{ status: "blocked", reason: errorMessage.slice(0, 500) },
			new Date().toISOString(),
		);
		if (!stopped.ok) return false;
		this.saveState(stopped.state, getGoalStateRevision(state));
		return true;
	}

	setStartAuthority(authority: ExplicitGoalStartAuthority | undefined): void {
		this.startAuthority = authority;
	}

	authorizeStartFromTool(input: { tokenBudget?: number }): string | undefined {
		const authority = this.startAuthority;
		if (!authority) return "goal start requires explicit owner authorization in the current prompt.";
		if (authority.tokenBudget === undefined && input.tokenBudget !== undefined) {
			return "tokenBudget requires an exact numeric token ceiling in the current owner prompt.";
		}
		if (authority.tokenBudget !== undefined && input.tokenBudget !== authority.tokenBudget) {
			return `tokenBudget must equal the owner-requested ceiling ${authority.tokenBudget}.`;
		}
		return undefined;
	}

	/**
	 * True once the currently held execution lease's goal has crossed into `budget_limited` — set
	 * synchronously by `chargeExecutionUsage` as soon as a just-charged response crosses the ceiling.
	 * Wired to the agent's `shouldStopAfterTurn` hook so a mid-turn budget stop ends the loop
	 * gracefully BEFORE the next provider request is even planned, instead of only being caught by
	 * `admitProviderRequest`'s throw — which still exists as the backstop for a fresh turn or an
	 * external admission starting against an already budget_limited goal, but would otherwise also
	 * fire for a request this same lease was already mid-flight for, surfacing a synthetic error
	 * message where a clean turn end belongs.
	 */
	hasExecutionLeaseCrossedBudgetLimit(): boolean {
		const lease = this.executionLease;
		if (!lease) return false;
		return this.resolveExecutionState(lease)?.status === "budget_limited";
	}

	/** Reserve only remaining output capacity; actual provider usage is charged on response. */
	admitProviderRequest(): number | undefined {
		const lease = this.executionLease;
		if (!lease) return undefined;
		this.flushPendingExecutionUsage(lease);
		const state = this.resolveExecutionState(lease);
		if (state?.status === "budget_limited") {
			throw new GoalBudgetExhaustedError(`goal_token_budget_exhausted: ${state.blockedReason ?? lease.goalId}`);
		}
		if (state && !isGoalExecutionActive(state.status)) {
			if (!lease.admittedWhileActive) {
				// A fresh turn/continuation is being started against a goal that is already done —
				// keep this denied so a dead goal cannot restart itself.
				throw new Error(`goal_execution_not_active: ${state.goalId} is ${state.status}`);
			}
			// This lease already admitted at least one request while the goal was active, so the
			// goal ended mid-turn (e.g. the model itself just called `goal complete`/`block`). Let
			// the already-in-flight turn drain to its closing response instead of throwing an error
			// at the user right after a successful stop.
			return undefined;
		}
		if (!state && lease.goalId !== undefined) {
			throw new Error(`goal_execution_not_active: ${lease.goalId} no longer exists`);
		}
		lease.admittedWhileActive = true;
		const tokenBudget = state?.tokenBudget ?? lease.provisionalTokenBudget;
		if (tokenBudget === undefined) return undefined;
		const tokensUsed = state?.tokensUsed ?? lease.pendingTokens;
		const remaining = Math.max(0, tokenBudget - tokensUsed);
		if (remaining < MIN_VIABLE_GOAL_TURN_OUTPUT_TOKENS) {
			// Below the floor, remaining is too small to hand to the provider as an output cap without
			// dooming the turn to a mid-generation truncation that still burns the full input cost.
			// Stop cleanly now instead of sending a request that cannot possibly complete.
			if (state) {
				this.markBudgetLimited(
					`token budget nearly exhausted (${tokensUsed}/${tokenBudget}, ${remaining} remaining is below the ` +
						`${MIN_VIABLE_GOAL_TURN_OUTPUT_TOKENS}-token minimum viable turn) before provider request`,
				);
			}
			throw new GoalBudgetExhaustedError(
				`goal_token_budget_exhausted: ${remaining} tokens remain, below the ${MIN_VIABLE_GOAL_TURN_OUTPUT_TOKENS}-token minimum viable turn`,
			);
		}
		return remaining;
	}

	private resolveExecutionState(lease: MutableGoalExecutionLease): GoalState | undefined {
		const state = this.getState();
		if (!state) return undefined;
		if (lease.goalId === state.goalId) return state;
		if (lease.goalId !== undefined || !lease.adoptNewGoal) return undefined;
		if (lease.adoptionBaselineGoalId === state.goalId) return undefined;
		lease.goalId = state.goalId;
		return state;
	}

	private flushPendingExecutionUsage(lease: MutableGoalExecutionLease): void {
		if (lease.pendingTokens === 0 && lease.pendingSpendUsd === 0) return;
		const state = this.resolveExecutionState(lease);
		if (!state) {
			// A speculative adopt-new-goal lease (lease.goalId still undefined) that never actually
			// adopted a goal this turn has nowhere to attribute usage — that is normal, not a loss.
			// A lease that WAS bound to a real goal but can no longer resolve it is a genuine loss of
			// buffered spend; fail loudly instead of silently discarding it (matches the cursor-based
			// accounting this replaced, which stopped the goal on `goal_usage_cursor_lost`).
			if (lease.goalId !== undefined) {
				this.deps.emitWarning(
					`Goal usage cursor is no longer resolvable for '${lease.goalId}'; ${lease.pendingTokens} pending tokens and $${lease.pendingSpendUsd.toFixed(6)} pending spend could not be attributed and were dropped.`,
				);
				this.recordContinuationFailure(new Error("goal_usage_cursor_lost"));
			}
			lease.pendingTokens = 0;
			lease.pendingSpendUsd = 0;
			return;
		}
		this.chargeExecutionUsage(lease, state, lease.pendingTokens, lease.pendingSpendUsd);
	}

	markToolUnavailable(): void {
		this.stopActiveGoal(
			"blocked",
			"goal_tool_unavailable: the active capability surface cannot update durable goal state",
		);
	}

	markHarnessGuardBlocked(info: AgentRunawayStopInfo): boolean {
		const reason =
			info.reason === "provider_turn_limit"
				? `provider_turn_limit: reached the explicit ${info.repeats}-request provider-turn limit`
				: `runaway_tool_loop: repeated tool-call signature ${info.signature} ${info.repeats} times without progress`;
		return this.stopActiveGoal("blocked", reason);
	}

	markTerminalToolFailureBlocked(toolName: string): boolean {
		return this.stopActiveGoal(
			"blocked",
			`terminal_tool_failure: ${toolName} reported an unrecoverable error and terminated the run`,
		);
	}

	getRuntimeSnapshot(settings: GoalRuntimeSnapshotSettings): GoalRuntimeSnapshot {
		return buildGoalRuntimeSnapshot({
			sessionManager: this.deps.getSessionManager(),
			settings,
			laneRecords: this.deps.getLaneRecords(),
			taskRuntime: this.deps.getTaskRuntimeSnapshot(),
			backgroundToolTasks: this.deps.getBackgroundToolTasks(),
		});
	}

	continueOnce(options: GoalContinuationOnceOptions): Promise<GoalContinuationOnceResult> {
		return this.loop.continueGoalOnce(options);
	}

	continueLoop(options: GoalContinuationLoopOptions): Promise<GoalContinuationLoopResult> {
		return this.loop.continueGoalLoop(options);
	}

	restoreAfterResume(): void {
		this.deps.scheduleGoalAutoContinueFromIdle();
	}

	private recordContinuationFailure(error: unknown): void {
		const state = this.getState();
		if (!state || !isGoalExecutionActive(state.status)) return;
		const message = error instanceof Error ? error.message : String(error);
		const classified = classifyFailure({ message, provider: this.deps.getModelProvider() });
		const status = classified.reason === "billing_or_quota" ? "usage_limited" : "blocked";
		this.stopActiveGoal(status, `${classified.reason}: ${message}`);
	}

	private markBudgetLimited(reason: string): void {
		this.stopActiveGoal("budget_limited", reason);
	}

	private stopActiveGoal(status: "blocked" | "usage_limited" | "budget_limited", reason: string): boolean {
		const state = this.getState();
		const stopped = stopGoalFromSystem(state, { status, reason }, new Date().toISOString());
		if (!stopped.ok || !state) return false;
		this.saveState(stopped.state, getGoalStateRevision(state));
		return true;
	}
}
