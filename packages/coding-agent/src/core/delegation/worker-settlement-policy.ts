/**
 * The worker policy members the session's settlement judges answer: the code-duplicate review of a worker's new
 * code, its report's claim blockers, and the ladder over what it could not settle. What stays unsettled goes to the
 * parent through `recordUnsettledForOwner`, the parent write that keeps it for the owner.
 */

import type { SettlementJudges } from "../system-one/settlement-judges.ts";
import type { ParentExecutionPolicy, ParentWritePort } from "./parent-execution-context.ts";

export function createWorkerSettlementPolicy(
	judges: Pick<SettlementJudges, "codeDuplicates" | "answerClaims" | "settleWorkerInconclusive">,
	recordUnsettledForOwner: ParentWritePort["recordUnsettledForOwner"],
): Required<Pick<ParentExecutionPolicy, "reviewNewCode" | "reviewWorkerReport" | "settleInconclusive">> {
	return {
		reviewNewCode: ({ toolName, args, cwd }) => judges.codeDuplicates.review(toolName, args, cwd),
		reviewWorkerReport: (input) => judges.answerClaims.workerReportBlockers(input),
		settleInconclusive: (input) => judges.settleWorkerInconclusive(input, recordUnsettledForOwner),
	};
}
