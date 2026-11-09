/**
 * Plan proof sheet: the proof sheet of a combined plan result (a join or the plan's final step), read from the join
 * result the host stored.
 *
 * Requirement coverage is the join's coverage map, the changed files are the union its members recorded, gaps and
 * conflicts are inconclusive items, and spend is the combined outcome's. A join runs no command of its own: each step's
 * commands and checks are on that step's worker proof sheet, so file coverage is not judged at this level and no changed
 * file is listed as unchecked. Protected-path facts are not read here (a combined outcome carries no
 * host findings). A plan result's stakes come from width, spend, failed steps and gaps, and from the highest level its steps
 * recorded when they settled (their command and protected-file facts are read there, not here).
 */

import type { TaskBrief } from "../comms/comms-records.ts";
import type { JoinResult } from "../plan/joins.ts";
import { buildProofSheet, type ProofSheetRecord, proofSheetRecord, renderProofSheet } from "./proof-sheet.ts";
import { highestProofStakes, type ProofStakesLevel, readProofStakes, recordedStakesReading } from "./proof-stakes.ts";

export interface PlanProofSheetInput {
	readonly planId: string;
	readonly title: string;
	readonly nodeId?: string;
	readonly result: JoinResult;
	/** The brief of the step the result settles; its done-when and out-of-scope lines are repeated. */
	readonly brief?: Pick<TaskBrief, "done" | "outOfScope">;
	/** The highest stakes the steps recorded when they settled, as the join recorded it; absent for a record before it. */
	readonly stakes?: ProofStakesLevel;
}

/** The proof sheet of one combined plan result, as owner text and the record a delivery stores under `details.proofSheet`. */
export function buildPlanProofSheet(input: PlanProofSheetInput): { text: string; record: ProofSheetRecord } {
	const { result } = input;
	const coverage = Object.entries(result.coverage);
	const failedSteps = result.members.filter((member) => member.status !== "succeeded");
	const inconclusive = [
		...failedSteps.map((member) => `step ${member.nodeId} ended ${member.status}`),
		...result.gaps,
		...result.conflicts.map(
			(conflict) => `${conflict.kind} conflict between ${conflict.between.join(" and ")}: ${conflict.detail}`,
		),
	];
	// The steps' own stakes were read from their worker results when they settled; the join reads the level it recorded.
	const stakes = highestProofStakes([
		readProofStakes({
			changedFiles: result.changedFiles,
			protectedFiles: [],
			commands: [],
			spendUsd: result.outcome.cost.usd,
			failedChecks: 0,
			inconclusive: inconclusive.length,
		}),
		recordedStakesReading(input.stakes, "a step of this plan"),
	]);
	const sheet = buildProofSheet({
		subject: {
			kind: "plan",
			id: input.nodeId ? `${input.planId}/${input.nodeId}` : input.planId,
			title: input.title,
		},
		stakes,
		commands: [],
		checks: [],
		requirementIds: coverage.map(([id]) => id),
		hostCoveredRequirementIds: coverage.filter(([, met]) => met).map(([id]) => id),
		changedFiles: result.changedFiles,
		inconclusive,
		assumptions: [],
		...(input.brief?.done ? { doneWhen: input.brief.done } : {}),
		...(input.brief?.outOfScope ? { outOfScope: input.brief.outOfScope } : {}),
		sourceRefs: [result.artifact],
		fileChecksElsewhere: "Checks of the changed files are on each step's own result.",
	});
	const text = renderProofSheet(sheet);
	return { text, record: proofSheetRecord(sheet, text) };
}
