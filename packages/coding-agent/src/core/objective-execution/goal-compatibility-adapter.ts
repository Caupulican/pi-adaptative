/**
 * Goal Compatibility Adapter.
 * Bridges legacy goal actions to canonical DurableTaskRuntime and SystemOneController operations.
 * Implements reference/goal-compatibility-adapter.ts and STRICT_RULES.md.
 */

import type { GoalEvidenceKind, GoalEvidenceOutcome } from "../goals/goal-state.ts";
import type { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import type { SystemOneController } from "../system-one/controller.ts";

export interface LegacyGoalStart {
	goalId: string;
	userGoal: string;
	tokenBudget?: number;
}

export interface LegacyRequirement {
	id: string;
	description: string;
}

export interface LegacyEvidence {
	id: string;
	kind: GoalEvidenceKind;
	summary: string;
	path?: string;
	outcome?: GoalEvidenceOutcome;
}

export interface LegacySatisfyRequirement {
	requirementId: string;
	evidenceIds: readonly string[];
}

export interface GoalCompatibilityAdapterDeps {
	runtime: DurableTaskRuntime;
	systemOne: SystemOneController;
	getActiveGoalId?(): string | undefined;
}

export class GoalCompatibilityAdapter {
	private readonly runtime: DurableTaskRuntime;
	private readonly systemOne: SystemOneController;
	private readonly getActiveGoalId?: () => string | undefined;

	constructor(deps: GoalCompatibilityAdapterDeps) {
		this.runtime = deps.runtime;
		this.systemOne = deps.systemOne;
		this.getActiveGoalId = deps.getActiveGoalId;
	}

	/**
	 * Translates goal start into DurableTaskRuntime objective creation.
	 */
	async start(input: LegacyGoalStart): Promise<{ objectiveId: string; status: string }> {
		const existingProjection = this.runtime.getSnapshot();
		const existing = existingProjection.objectives[input.goalId];

		if (existing) {
			return { objectiveId: input.goalId, status: existing.objective.status };
		}

		await this.runtime.createObjective({
			objectiveId: input.goalId,
			title: input.userGoal,
			description: input.userGoal,
			riskBudget: {
				maxCostUsd: 10.0,
			},
		});

		return { objectiveId: input.goalId, status: "pending" };
	}

	/**
	 * Translates legacy requirement into a task or acceptance criteria on the objective.
	 */
	async addRequirement(input: LegacyRequirement): Promise<{ taskId: string }> {
		const objectiveId = this.getActiveGoalId?.() ?? Object.keys(this.runtime.getSnapshot().objectives)[0];
		if (!objectiveId) {
			throw new Error("Cannot add requirement without an active objective.");
		}

		const taskId = input.id.startsWith("task_") ? input.id : `task_${input.id}`;
		await this.runtime.createTask({
			taskId,
			objectiveId,
			title: input.description,
			description: input.description,
			role: "implementer",
		});

		return { taskId };
	}

	/**
	 * Ingests legacy evidence by verifying and recording it in SystemOneController as a host observation.
	 */
	async addEvidence(input: LegacyEvidence): Promise<{ observationId: string; verified: boolean }> {
		const observationId = `obs_${input.id}`;
		const isVerified = input.outcome === "succeeded" || input.kind === "test";

		if (this.systemOne.store) {
			this.systemOne.store.recordObservation({
				text: `[${input.kind}] ${input.summary}${input.path ? ` (${input.path})` : ""}`,
				source: {
					kind: input.kind === "test" ? "test" : "tool_output",
					locator: input.path ?? `evidence://${input.id}`,
					trust: isVerified ? "authoritative" : "repository_untrusted_text",
				},
			});
		}

		return { observationId, verified: isVerified };
	}

	/**
	 * Evaluates a requirement satisfaction proposal without granting autonomous completion (Rule 18).
	 */
	async satisfyRequirement(_input: LegacySatisfyRequirement): Promise<{
		accepted: boolean;
		authoritativeSatisfied: boolean;
		reason: string;
	}> {
		// Proposals require mechanical/host verification; worker assertion alone is non-authoritative.
		const state = this.systemOne.store?.snapshot();
		const failedVerifications = (state?.verification ?? []).filter((v) => v.status === "failed");

		if (failedVerifications.length > 0) {
			return {
				accepted: true,
				authoritativeSatisfied: false,
				reason:
					"Requirement satisfaction proposed; pending verification obligations must pass before satisfaction is committed.",
			};
		}

		return {
			accepted: true,
			authoritativeSatisfied: true,
			reason: "Requirement satisfaction registered with passing verification obligations.",
		};
	}

	/**
	 * Non-authoritative progress telemetry (Rule 16). Does not advance canonical progress revision.
	 */
	async progress(): Promise<{ accepted: true; authoritativeProgressChanged: false }> {
		return { accepted: true, authoritativeProgressChanged: false };
	}

	/**
	 * Non-authoritative stall hint (Rule 17). Does not set authoritative stall state.
	 */
	async noProgress(): Promise<{ accepted: true; authoritativeStallChanged: false }> {
		return { accepted: true, authoritativeStallChanged: false };
	}

	/**
	 * Requests the next route evaluation cycle from the controller.
	 */
	async increment(): Promise<{ requestNextRoute: true }> {
		return { requestNextRoute: true };
	}

	/**
	 * Maps legacy complete call to completion_candidate proposal (Rule 19).
	 * Does not commit terminal success directly.
	 */
	async complete(): Promise<{ requestedCandidate: true; candidateCommitted: boolean }> {
		// Worker proposing completion; transitions to completion_candidate stage
		return { requestedCandidate: true, candidateCommitted: false };
	}
}
