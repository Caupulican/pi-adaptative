/** Independent objective observations and derived goal coverage retain separate cardinality quotas. */
import { isPlainRecord } from "../util/value-guards.ts";
import {
	MAX_ORCHESTRATION_EVIDENCE,
	MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE,
	MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE_ROWS,
	MAX_ORCHESTRATION_OBJECTIVE_GOAL_COVERAGE,
} from "./contracts.ts";
import { isGoalCoverageRecord } from "./goal-evidence-mirror.ts";
import { DurableTaskRuntimeError, type ObjectiveRuntimeState } from "./task-runtime-state.ts";

interface ObjectiveEvidenceCounts {
	readonly independent: number;
	readonly coverage: number;
}
const countsByRows = new WeakMap<readonly unknown[], { objectiveId: string; counts: ObjectiveEvidenceCounts }>();

/** Validates every retained row once per immutable array, including the unique coverage slot per criterion. */
export function objectiveEvidenceCounts(objectiveId: string, rows: readonly unknown[]): ObjectiveEvidenceCounts {
	const cached = countsByRows.get(rows);
	if (cached?.objectiveId === objectiveId) return cached.counts;
	if (rows.length > MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE_ROWS)
		throw new DurableTaskRuntimeError(
			`Orchestration objective evidence exceeds its ${MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE_ROWS}-row limit.`,
		);
	const counts = { independent: 0, coverage: 0 };
	const covered = new Set<string>();
	for (const item of rows) {
		if (isGoalCoverageRecord(item, objectiveId)) {
			if (covered.has(item.criterionId!))
				throw new DurableTaskRuntimeError(`Objective goal coverage repeats criterion '${item.criterionId}'.`);
			covered.add(item.criterionId!);
			counts.coverage++;
		} else counts.independent++;
	}
	if (counts.independent > MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE)
		throw new DurableTaskRuntimeError(
			`Orchestration objective independent evidence limit (${MAX_ORCHESTRATION_OBJECTIVE_EVIDENCE}) exceeded.`,
		);
	if (counts.coverage > MAX_ORCHESTRATION_OBJECTIVE_GOAL_COVERAGE)
		throw new DurableTaskRuntimeError(
			`Orchestration objective goal coverage limit (${MAX_ORCHESTRATION_OBJECTIVE_GOAL_COVERAGE}) exceeded.`,
		);
	if (
		Object.isFrozen(rows) &&
		rows.every(
			(row) =>
				isPlainRecord(row) &&
				Object.isFrozen(row) &&
				Object.isFrozen(row.metadata) &&
				Object.isFrozen(row.artifactIds),
		)
	)
		countsByRows.set(rows, { objectiveId, counts: Object.freeze(counts) });
	return counts;
}

/** Derived coverage is bounded per objective and therefore by the existing objective-count and aggregate-byte ceilings. */
export function assertObjectiveEvidenceCapacity(
	objectives: Readonly<Record<string, ObjectiveRuntimeState>>,
	replacement?: ObjectiveRuntimeState,
): void {
	let independent = 0;
	for (const [objectiveId, objective] of Object.entries(objectives)) {
		independent += objectiveEvidenceCounts(
			objectiveId,
			replacement?.objective.objectiveId === objectiveId ? replacement.evidence : objective.evidence,
		).independent;
	}
	if (replacement && !objectives[replacement.objective.objectiveId])
		independent += objectiveEvidenceCounts(replacement.objective.objectiveId, replacement.evidence).independent;
	if (independent > MAX_ORCHESTRATION_EVIDENCE)
		throw new DurableTaskRuntimeError(
			`Orchestration independent evidence limit (${MAX_ORCHESTRATION_EVIDENCE}) exceeded.`,
		);
}
