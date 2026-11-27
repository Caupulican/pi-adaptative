/** Projects the saved goal and its observed completion account into the tool receipt read by the final report. */
import type { CommittedToolReport } from "../../kernel/types.ts";
import type { GoalState } from "../goals/goal-state.ts";
import type { GoalCompletionPresentation } from "../objective-execution/current-objective-execution.ts";
import { type ProofSheetRecord, proofSheetUnavailableLine } from "../proof/proof-sheet.ts";
import { type CompletionAccount, parseCompletionAccount } from "../system-one/completion-account.ts";

export const goalReportInstruction =
	"Give the owner one final report grounded in this receipt, including its proof and verification limits.";

export type GoalProofSheetBuilder = (input: {
	state: GoalState;
	account?: CompletionAccount;
	changedFiles?: readonly string[];
}) => { text: string; record: ProofSheetRecord };

export function goalCompletionReceipt(
	build: GoalProofSheetBuilder,
	state: GoalState,
	reviewedAccount: CompletionAccount | undefined,
	rawAccount: unknown,
	changedFiles: readonly string[] | undefined,
): { text: string; record?: ProofSheetRecord } {
	try {
		const parsed = !reviewedAccount && rawAccount ? parseCompletionAccount(rawAccount) : undefined;
		const account = reviewedAccount ?? (parsed && "account" in parsed ? parsed.account : undefined);
		return build({ state, ...(account ? { account } : {}), ...(changedFiles ? { changedFiles } : {}) });
	} catch (error) {
		return { text: proofSheetUnavailableLine(error) };
	}
}

export function goalReportHandoff(presentation?: GoalCompletionPresentation): {
	terminate: true;
	handoff: CommittedToolReport;
} {
	return {
		terminate: true,
		handoff: {
			kind: "report_committed_result",
			signal: presentation?.signal,
			beginDispatch: presentation?.beginReportDispatch,
		},
	};
}
