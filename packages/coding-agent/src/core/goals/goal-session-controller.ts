import { createHash } from "node:crypto";
import { classifyFailure } from "@caupulican/pi-agent-core/reliability";
import type { SessionManager } from "@caupulican/pi-agent-core/session";
import type { AssistantMessage } from "@caupulican/pi-ai";
import type {
	GoalContinuationLoopOptions,
	GoalContinuationLoopResult,
	GoalContinuationOnceOptions,
	GoalContinuationOnceResult,
	PromptOptions,
} from "../agent-session-contracts.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { GoalLoopController } from "../goal-loop-controller.ts";
import { budgetedTokens } from "../orchestration/capability-gateway.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { type GoalStateRevision, getGoalStateRevision, stopGoalFromSystem } from "./goal-lifecycle.ts";
import {
	buildGoalRuntimeSnapshot,
	type GoalRuntimeSnapshot,
	type GoalRuntimeSnapshotSettings,
} from "./goal-runtime-snapshot.ts";
import { applyGoalEvent, type GoalState, isGoalUnfinishedStatus } from "./goal-state.ts";
import { applyGoalAction } from "./goal-tool-core.ts";
import { type ExplicitGoalStartAuthority, parseExplicitChatGoal } from "./natural-language-goal.ts";
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
	synchronizeGoalState(state: GoalState): void;
	scheduleGoalAutoContinueFromIdle(): void;
	prompt(text: string, options?: PromptOptions): Promise<void>;
	emitWarning(message: string): void;
}

export type ChatGoalAdmission =
	| { status: "not_explicit" }
	| { status: "started"; state: GoalState }
	| { status: "unfinished_goal_exists"; state: GoalState };

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

	constructor(deps: GoalSessionControllerDeps) {
		this.deps = deps;
		this.loop = new GoalLoopController({
			getGoalRuntimeSnapshot: (settings) => this.getRuntimeSnapshot(settings),
			prompt: (text, options) => this.deps.prompt(text, options),
			recordGoalContinuationPass: (pass) => this.recordContinuationPass(pass),
			recordGoalContinuationFailure: (error) => this.recordContinuationFailure(error),
			markGoalBudgetLimited: (reason) => this.markBudgetLimited(reason),
		});
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
	admitExplicitChatGoal(text: string, now = new Date().toISOString()): ChatGoalAdmission {
		const parsed = parseExplicitChatGoal(text);
		if (!parsed) return { status: "not_explicit" };
		const current = this.getState();
		if (current && isGoalUnfinishedStatus(current.status)) {
			return { status: "unfinished_goal_exists", state: current };
		}
		const digest = createHash("sha256")
			.update(`${now}\0${current?.goalId ?? "none"}\0${parsed.objective}`)
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
			now,
		);
		if (!result.ok) throw new Error(result.error);
		this.saveState(result.state, current ? getGoalStateRevision(current) : undefined);
		return { status: "started", state: result.state };
	}

	/** Attribute turn/wall-clock telemetry after usage has already been charged per response. */
	recordContinuationPass(pass: { turns: number; wallClockMs: number }): void {
		const state = this.getState();
		if (!state) return;
		const updated = applyGoalEvent(state, {
			type: "record_continuation_budget",
			turns: pass.turns,
			wallClockMs: pass.wallClockMs,
			tokens: 0,
			spendUsd: 0,
			now: new Date().toISOString(),
		});
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
		if (goalId && (!state || state.goalId !== goalId || state.status !== "active")) return undefined;
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
			updated.status === "active" &&
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
		if (!state || state.status !== "active") return false;
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

	/** Reserve only remaining output capacity; actual provider usage is charged on response. */
	admitProviderRequest(): number | undefined {
		const lease = this.executionLease;
		if (!lease) return undefined;
		this.flushPendingExecutionUsage(lease);
		const state = this.resolveExecutionState(lease);
		const tokenBudget = state?.tokenBudget ?? lease.provisionalTokenBudget;
		if (tokenBudget === undefined) return undefined;
		if (state?.status === "budget_limited") {
			throw new Error(`goal_token_budget_exhausted: ${state.blockedReason ?? lease.goalId}`);
		}
		if (state && state.status !== "active") return undefined;
		const tokensUsed = state?.tokensUsed ?? lease.pendingTokens;
		const remaining = Math.max(0, tokenBudget - tokensUsed);
		if (remaining === 0) {
			if (state) {
				this.markBudgetLimited(`token budget exhausted (${tokensUsed}/${tokenBudget}) before provider request`);
			}
			throw new Error(`goal_token_budget_exhausted: no tokens remain for provider output`);
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
		if (!state) return;
		this.chargeExecutionUsage(lease, state, lease.pendingTokens, lease.pendingSpendUsd);
	}

	markToolUnavailable(): void {
		this.stopActiveGoal(
			"blocked",
			"goal_tool_unavailable: the active capability surface cannot update durable goal state",
		);
	}

	markRunawayBlocked(info: { signature: string; repeats: number }): boolean {
		return this.stopActiveGoal(
			"blocked",
			`runaway_tool_loop: repeated tool-call signature ${info.signature} ${info.repeats} times without progress`,
		);
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
		if (!state || state.status !== "active") return;
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
