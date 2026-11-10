import type { Api, Model } from "@caupulican/pi-ai";
import { getSupportedThinkingLevels } from "@caupulican/pi-ai/models";
import type { FleetScheduler } from "../fleet/fleet-types.ts";
import type { GoalState } from "../goals/goal-state.ts";
import type { RequirementCheckResult } from "../goals/requirement-checks.ts";
import type { OutcomeRankQuery } from "../models/outcome-ledger-store.ts";
import { ORCHESTRATION_THINKING_LEVELS, type OrchestrationThinkingLevel } from "../orchestration/contracts.ts";
import type { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import type { ResolvedWorkerOutcomeSettings } from "../settings/worker-outcome-settings.ts";
import { WorkerEscalation } from "./worker-escalation.ts";
import { type Outcome, subscribeOutcomes } from "./worker-outcome.ts";
import { WorkerOutcomeLearning } from "./worker-outcome-learning.ts";
import type { WorkerOutcomeRecorder } from "./worker-outcome-recorder.ts";

export interface WorkerOutcomeFollowUpDeps {
	readonly agentDir: string;
	readonly sessionId: string;
	readonly runtime: DurableTaskRuntime;
	/** The two recorder members the follow-up uses: re-recording after host checks, and installing the ladder context. */
	readonly recorder: Pick<WorkerOutcomeRecorder, "record" | "useLadderContext">;
	readonly fleet: Pick<FleetScheduler, "prepare" | "admit">;
	settings(): ResolvedWorkerOutcomeSettings;
	findModel(provider: string, modelId: string): Model<Api> | undefined;
	goalState(): GoalState | undefined;
	cwd(): string;
	/** Aborting it detaches the follow-up: no subscription, ladder context or placement outlives the controller. */
	readonly signal: AbortSignal;
	/** Whether a directory is a worktree lane (a rerun of its original cannot be placed back into it yet). */
	isLaneDirectory(directory: string): boolean;
	/** Record a passing host requirement check as the goal's own proof of that requirement. */
	recordCheckProof(attemptId: string, requirementId: string, result: RequirementCheckResult): void;
}

/**
 * What happens after a worker outcome is recorded, for one session's worker controller: the ladder reads the owner's
 * settings, model thinking ceilings and host requirement checks; the outcome teaches the ledger; the next action is
 * carried out (host checks, escalation rungs). Event-driven: it runs on each durably recorded outcome of this
 * session's runtime and never polls.
 */
export class WorkerOutcomeFollowUp {
	private readonly deps: WorkerOutcomeFollowUpDeps;
	private readonly learning: WorkerOutcomeLearning;
	private readonly escalation: WorkerEscalation;
	private readonly releaseLadder: () => void;
	private readonly unsubscribe: () => void;
	private closed = false;

	constructor(deps: WorkerOutcomeFollowUpDeps) {
		this.deps = deps;
		this.learning = new WorkerOutcomeLearning({
			agentDir: deps.agentDir,
			sessionId: deps.sessionId,
			settings: deps.settings,
		});
		this.escalation = new WorkerEscalation({
			runtime: deps.runtime,
			fleet: deps.fleet,
			goalState: deps.goalState,
			cwd: deps.cwd,
			isLaneDirectory: (directory) => deps.isLaneDirectory(directory),
			recordChecks: (attemptId, checks) => {
				deps.recorder.record(attemptId, undefined, { requirementChecks: checks });
			},
			recordRefusal: (attemptId, detail) => {
				deps.recorder.record(attemptId, undefined, { rungRefusal: detail });
			},
			recordCheckProof: deps.recordCheckProof,
			signal: deps.signal,
		});
		this.releaseLadder = deps.recorder.useLadderContext({
			settings: () => deps.settings().escalation,
			thinkingCeiling: (modelRef) => this.thinkingCeiling(modelRef),
			requirementCheckIds: () =>
				new Set((deps.goalState()?.requirements ?? []).filter((entry) => entry.check).map((entry) => entry.id)),
		});
		this.unsubscribe = subscribeOutcomes((outcome) => {
			// Outcomes are published inside the recorder's write; acting on them waits for that write to return.
			queueMicrotask(() => this.follow(outcome));
		});
		deps.signal.addEventListener("abort", () => this.close(), { once: true });
	}

	/** Detaches the follow-up: no subscription, ladder context or placement follows after this. Idempotent. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe();
		this.releaseLadder();
	}

	/** The resolver's ranking port (see `WorkerAuthorityResolutionInput.rankRoutedModels`). */
	rankRoutedModels(models: readonly Model<Api>[], query: OutcomeRankQuery): Model<Api>[] {
		return this.learning.rankRoutedModels(models, query);
	}

	private thinkingCeiling(modelRef: string): OrchestrationThinkingLevel | undefined {
		const [provider, ...rest] = modelRef.split("/");
		const model = provider && rest.length > 0 ? this.deps.findModel(provider, rest.join("/")) : undefined;
		const highest = model ? getSupportedThinkingLevels(model).at(-1) : undefined;
		return ORCHESTRATION_THINKING_LEVELS.find((level) => level === highest);
	}

	private follow(outcome: Outcome): void {
		if (this.closed || this.deps.signal.aborted || !outcome.taskId) return;
		const snapshot = this.deps.runtime.getSnapshot();
		// Subscribers are process-wide: act only on this runtime's current outcome of the task.
		if (snapshot.tasks[outcome.taskId]?.outcome?.outcomeId !== outcome.outcomeId) return;
		this.learning.observe(outcome, snapshot);
		this.escalation.follow(outcome);
	}
}
