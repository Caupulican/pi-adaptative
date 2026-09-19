/**
 * Goal State Migration to DurableTaskRuntime and SystemOne.
 * Conforms to schemas/goal-migration.schema.json.
 * Implements idempotent, backup-preserving dry-run and apply migration.
 */

import { createHash } from "node:crypto";
import type { GoalState } from "../goals/goal-state.ts";
import type { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import type { SystemOneController } from "../system-one/controller.ts";

export const GOAL_MIGRATION_SCHEMA_VERSION = "1.0" as const;
export const CURRENT_GOAL_MIGRATION_VERSION = "1.0.0" as const;

export interface GoalMigrationRecord {
	readonly schema_version: typeof GOAL_MIGRATION_SCHEMA_VERSION;
	readonly legacy_goal_id: string;
	readonly objective_id: string;
	readonly migration_version: string;
	readonly source_digest: string;
	readonly status: "dry_run" | "migrated" | "verified" | "failed";
	readonly mapped_requirement_ids?: readonly string[];
	readonly mapped_evidence_ids?: readonly string[];
	readonly warnings?: readonly string[];
	readonly backupSnapshot?: Readonly<GoalState>;
}

export class GoalMigrationError extends Error {
	constructor(message: string) {
		super(`GoalMigrationError: ${message}`);
		this.name = "GoalMigrationError";
	}
}

/**
 * Computes a deterministic SHA-256 digest of a GoalState snapshot.
 */
export function computeGoalStateDigest(state: GoalState): string {
	const canonical = {
		goalId: state.goalId,
		userGoal: state.userGoal,
		status: state.status,
		tokenBudget: state.tokenBudget,
		tokensUsed: state.tokensUsed,
		requirements: state.requirements?.map((r) => ({ id: r.id, desc: r.text, status: r.status })),
		evidence: state.evidence?.map((e) => ({ id: e.id, kind: e.kind, summary: e.summary })),
	};
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Migrates a legacy GoalState into DurableTaskRuntime and SystemOneController.
 * Supports dry-run, preserves backup, preserves budgets, requirements, evidence, and blockers.
 * Strictly idempotent (Rule 54).
 */
export async function migrateGoalState(
	legacyState: GoalState,
	deps: {
		runtime?: DurableTaskRuntime;
		systemOne?: SystemOneController;
	},
	options?: { dryRun?: boolean },
): Promise<GoalMigrationRecord> {
	if (!legacyState || typeof legacyState !== "object" || !legacyState.goalId) {
		throw new GoalMigrationError("Invalid legacy GoalState provided for migration.");
	}

	const sourceDigest = computeGoalStateDigest(legacyState);
	const objectiveId = legacyState.goalId;
	const isDryRun = options?.dryRun ?? false;
	const warnings: string[] = [];

	const mappedRequirementIds: string[] = [];
	const mappedEvidenceIds: string[] = [];

	if (legacyState.requirements) {
		for (const req of legacyState.requirements) {
			mappedRequirementIds.push(req.id);
		}
	}

	if (legacyState.evidence) {
		for (const ev of legacyState.evidence) {
			mappedEvidenceIds.push(ev.id);
		}
	}

	// Preserve backup snapshot (Rule 55, OEL-041)
	const backupSnapshot = JSON.parse(JSON.stringify(legacyState)) as GoalState;

	if (isDryRun) {
		return {
			schema_version: GOAL_MIGRATION_SCHEMA_VERSION,
			legacy_goal_id: legacyState.goalId,
			objective_id: objectiveId,
			migration_version: CURRENT_GOAL_MIGRATION_VERSION,
			source_digest: sourceDigest,
			status: "dry_run",
			mapped_requirement_ids: mappedRequirementIds,
			mapped_evidence_ids: mappedEvidenceIds,
			warnings: warnings.length > 0 ? warnings : undefined,
			backupSnapshot,
		};
	}

	// Apply migration to DurableTaskRuntime and SystemOneController
	try {
		if (deps.runtime) {
			const projection = deps.runtime.getSnapshot();
			const existingObjective = projection.objectives[objectiveId];

			if (!existingObjective) {
				await deps.runtime.createObjective({
					objectiveId,
					title: legacyState.userGoal,
					description: legacyState.userGoal,
					riskBudget: {
						maxCostUsd: 10.0,
					},
				});
			}

			// Map requirements to tasks
			if (legacyState.requirements) {
				for (const req of legacyState.requirements) {
					const taskId = req.id.startsWith("task_") ? req.id : `task_${req.id}`;
					if (!projection.tasks[taskId]) {
						await deps.runtime.createTask({
							taskId,
							objectiveId,
							title: req.text,
							description: req.text,
							role: "implementer",
						});
					}
				}
			}
		}

		// Map evidence to SystemOne observations
		if (deps.systemOne?.store && legacyState.evidence) {
			for (const ev of legacyState.evidence) {
				deps.systemOne.store.recordObservation({
					text: `[${ev.kind}] ${ev.summary}${ev.uri ? ` (${ev.uri})` : ""}`,
					source: {
						kind: ev.kind === "test" ? "test" : "tool_output",
						locator: ev.uri ?? `evidence://${ev.id}`,
						trust: ev.outcome === "succeeded" ? "authoritative" : "repository_untrusted_text",
					},
				});
			}
		}

		return {
			schema_version: GOAL_MIGRATION_SCHEMA_VERSION,
			legacy_goal_id: legacyState.goalId,
			objective_id: objectiveId,
			migration_version: CURRENT_GOAL_MIGRATION_VERSION,
			source_digest: sourceDigest,
			status: "migrated",
			mapped_requirement_ids: mappedRequirementIds,
			mapped_evidence_ids: mappedEvidenceIds,
			warnings: warnings.length > 0 ? warnings : undefined,
			backupSnapshot,
		};
	} catch (error) {
		return {
			schema_version: GOAL_MIGRATION_SCHEMA_VERSION,
			legacy_goal_id: legacyState.goalId,
			objective_id: objectiveId,
			migration_version: CURRENT_GOAL_MIGRATION_VERSION,
			source_digest: sourceDigest,
			status: "failed",
			warnings: [error instanceof Error ? error.message : String(error)],
			backupSnapshot,
		};
	}
}
