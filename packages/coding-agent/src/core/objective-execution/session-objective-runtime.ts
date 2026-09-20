/**
 * The objective execution controller's `runtime` port over a live session.
 *
 * Production hands the controller the durable task runtime, which holds objectives, tasks and
 * attempts but knows nothing of goals, budgets, repositories or verification. Every route
 * evaluation starts with `reconcileObjective`, so without this adapter the objective loop threw on
 * its first line and the shadow hook swallowed it: the route machine never evaluated a real
 * objective. This adapter is the one place that translates between the goal the owner started and
 * the objective System One routes.
 */

import { execFileSync } from "node:child_process";
import type { VerificationObligationView } from "@caupulican/pi-agent-core/verification-obligations";
import type { ArtifactStore } from "../context/context-artifacts.ts";
import type { GoalState } from "../goals/goal-state.ts";
import type { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { goalObjectiveId } from "../orchestration/work-state-projection.ts";
import type { RepairWork } from "./objective-repair-work.ts";
import type { StallEvaluation } from "./objective-stall-fingerprint.ts";

export interface SessionObjectiveRuntimeDeps {
	readonly runtime: DurableTaskRuntime;
	readonly cwd: string;
	getGoalState(): GoalState | undefined;
	/** Projects the goal into its durable objective (requirements, evidence, status). */
	synchronizeGoalState(goal: GoalState): void;
	getArtifactStore?(): ArtifactStore | undefined;
	getVerificationObligations?(): readonly VerificationObligationView[];
	/** Operator-visible note of a repair or replan System One asked for. */
	noteDecision?(kind: "repair" | "replan", detail: string): void;
}

/** The repair task id for a repair-work record; stable so a repeated request never duplicates it. */
export function repairTaskId(repair: RepairWork): string {
	return `repair:${repair.repair_id}`;
}

function readGitHead(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined;
	}
}

export class SessionObjectiveRuntime {
	private readonly deps: SessionObjectiveRuntimeDeps;

	constructor(deps: SessionObjectiveRuntimeDeps) {
		this.deps = deps;
	}

	/** The goal owning `objectiveId`, when the live goal is that objective. */
	private goalFor(objectiveId: string): GoalState | undefined {
		const goal = this.deps.getGoalState();
		return goal && goalObjectiveId(goal.goalId) === objectiveId ? goal : undefined;
	}

	/** Fold the live goal into the durable objective, then hand back the snapshot the routes read. */
	async reconcileObjective(objectiveId: string): Promise<TaskRuntimeProjection> {
		const goal = this.goalFor(objectiveId);
		if (goal) this.deps.synchronizeGoalState(goal);
		return this.deps.runtime.getSnapshot();
	}

	getSnapshot(): TaskRuntimeProjection {
		return this.deps.runtime.getSnapshot();
	}

	isCancelled(objectiveId: string): boolean {
		if (this.goalFor(objectiveId)?.status === "cancelled") return true;
		return this.deps.runtime.getSnapshot().objectives[objectiveId]?.objective.status === "cancelled";
	}

	/** The goal's execution lease marks the goal `budget_limited` the moment a charged response crosses its ceiling. */
	isBudgetExhausted(objectiveId: string): boolean {
		const status = this.goalFor(objectiveId)?.status;
		return status === "budget_limited" || status === "usage_limited";
	}

	/** One durable implementer task per repair record; a repeated request is idempotent. */
	async ensureRepairTasks(objectiveId: string, repairs: readonly RepairWork[]): Promise<void> {
		const snapshot = this.deps.runtime.getSnapshot();
		for (const repair of repairs) {
			const taskId = repairTaskId(repair);
			if (snapshot.tasks[taskId]) continue;
			this.deps.runtime.createTask({
				taskId,
				objectiveId,
				title: `Repair ${repair.failed_gate_id}`,
				description: `${repair.reason}\nRequired next proof: ${repair.required_next_proof}`,
				role: "implementer",
				...(repair.acceptance_criterion_ids?.length
					? { acceptanceCriterionIds: repair.acceptance_criterion_ids }
					: {}),
			});
			this.deps.noteDecision?.("repair", `${repair.failed_gate_id}: ${repair.reason}`);
		}
	}

	async requestReplan(objectiveId: string, stall: StallEvaluation): Promise<void> {
		this.deps.noteDecision?.(
			"replan",
			`${objectiveId}: ${stall.reason ?? "strategy repeated without new evidence"} (stall turns ${stall.stallTurns})`,
		);
	}

	getSourceRevision(): string {
		return readGitHead(this.deps.cwd) ?? "unversioned";
	}

	/** Artifacts the objective's evidence points at, resolved through the artifact store when one exists. */
	getArtifacts(objectiveId: string): readonly { path: string; kind?: string }[] {
		const store = this.deps.getArtifactStore?.();
		const evidence = this.deps.runtime.getSnapshot().objectives[objectiveId]?.evidence ?? [];
		const out: { path: string; kind?: string }[] = [];
		for (const item of evidence) {
			for (const artifactId of item.artifactIds) {
				const ref = store?.readRef(artifactId);
				out.push({ path: ref?.path ?? artifactId, kind: ref?.kind ?? item.kind });
			}
		}
		return out;
	}

	/** What still stands between the objective and a clean completion: its open verifications. */
	getLimitations(_objectiveId: string): readonly string[] {
		return (this.deps.getVerificationObligations?.() ?? []).map(
			(obligation) => `unresolved verification: ${obligation.command ?? obligation.id}`,
		);
	}
}
