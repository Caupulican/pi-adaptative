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
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { type GoalStateRevision, getGoalStateRevision, stopGoalFromSystem } from "./goal-lifecycle.ts";
import {
	buildGoalRuntimeSnapshot,
	type GoalRuntimeSnapshot,
	type GoalRuntimeSnapshotSettings,
} from "./goal-runtime-snapshot.ts";
import { applyGoalEvent, type GoalState, isGoalUnfinishedStatus } from "./goal-state.ts";
import { applyGoalAction } from "./goal-tool-core.ts";
import { parseExplicitChatGoal } from "./natural-language-goal.ts";
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

/**
 * Owns durable goal state, exact continuation accounting, and the raw continuation loop. The
 * AgentSession facade supplies process collaborators but no longer implements goal lifecycle rules.
 */
export class GoalSessionController {
	private readonly deps: GoalSessionControllerDeps;
	private readonly loop: GoalLoopController;

	constructor(deps: GoalSessionControllerDeps) {
		this.deps = deps;
		this.loop = new GoalLoopController({
			getGoalRuntimeSnapshot: (settings) => this.getRuntimeSnapshot(settings),
			prompt: (text, options) => this.deps.prompt(text, options),
			captureUsageCursor: () => this.deps.getSessionManager().getLeafId(),
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
			{ action: "start", goalId: `chat-${digest}`, userGoal: parsed.objective },
			now,
		);
		if (!result.ok) throw new Error(result.error);
		this.saveState(result.state, current ? getGoalStateRevision(current) : undefined);
		return { status: "started", state: result.state };
	}

	recordContinuationPass(pass: { turns: number; wallClockMs: number; usageCursor: string | null }): void {
		const state = this.getState();
		if (!state) return;
		const branch = this.deps.getSessionManager().getBranch();
		const cursorIndex = pass.usageCursor === null ? -1 : branch.findIndex((entry) => entry.id === pass.usageCursor);
		if (pass.usageCursor !== null && cursorIndex < 0) {
			this.deps.emitWarning(
				"Goal usage cursor is no longer on the active branch; stopping instead of guessing usage.",
			);
			this.recordContinuationFailure(new Error("goal_usage_cursor_lost"));
			return;
		}
		let tokens = 0;
		let spendUsd = 0;
		for (const entry of branch.slice(cursorIndex + 1)) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const usage = (entry.message as AssistantMessage).usage;
			tokens += Math.max(0, usage.input) + Math.max(0, usage.output);
			spendUsd += Math.max(0, usage.cost.total);
		}
		const updated = applyGoalEvent(state, {
			type: "record_continuation_budget",
			turns: pass.turns,
			wallClockMs: pass.wallClockMs,
			tokens,
			spendUsd,
			now: new Date().toISOString(),
		});
		this.saveState(updated, getGoalStateRevision(state));
	}

	markToolUnavailable(): void {
		const state = this.getState();
		const stopped = stopGoalFromSystem(
			state,
			{
				status: "blocked",
				reason: "goal_tool_unavailable: the active capability surface cannot update durable goal state",
			},
			new Date().toISOString(),
		);
		if (stopped.ok && state) this.saveState(stopped.state, getGoalStateRevision(state));
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
		const stopped = stopGoalFromSystem(
			state,
			{ status, reason: `${classified.reason}: ${message}` },
			new Date().toISOString(),
		);
		if (stopped.ok) this.saveState(stopped.state, getGoalStateRevision(state));
	}

	private markBudgetLimited(reason: string): void {
		const state = this.getState();
		const stopped = stopGoalFromSystem(state, { status: "budget_limited", reason }, new Date().toISOString());
		if (stopped.ok && state) this.saveState(stopped.state, getGoalStateRevision(state));
	}
}
