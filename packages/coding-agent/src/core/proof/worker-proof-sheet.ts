/**
 * Worker proof sheet: the proof sheet of one finished worker (or leader) result, read from the host's own records.
 *
 * The commands are the host's command receipts (exit codes, no output: a worker's saved output lives in its scratch
 * directory, removed when it ends). A check the worker reported counts as passed only when a finished host receipt matches
 * it (the receipt it names, or the latest receipt of its command, which is how the host matches a check that names none) and
 * that receipt exited cleanly; a check no finished receipt matches, or not run, is listed as inconclusive instead. Requirement
 * coverage is the host's outcome coverage (else its verdict), protected-path facts are the host's findings, and the
 * done-when and out-of-scope lines come from the dispatch brief. Only the worker's assumptions are its own words.
 */

import type { WorkerClaim } from "../autonomy/contracts.ts";
import type { TaskBrief } from "../comms/comms-records.ts";
import { MAX_WORKER_CLAIM_BLOCKER_CHARS } from "../delegation/worker-claim.ts";
import type { Outcome } from "../delegation/worker-outcome-contract.ts";
import { receiptAlias, resolvedCheckReceipt } from "../delegation/worker-report.ts";
import { boundedText } from "../util/bounded-line.ts";
import {
	buildProofSheet,
	type ProofCheck,
	type ProofCommand,
	type ProofSheetRecord,
	proofSheetRecord,
	renderProofSheet,
} from "./proof-sheet.ts";
import { type ProofStakes, type ProofStakesFacts, readProofStakes } from "./proof-stakes.ts";

export interface WorkerProofSheetInput {
	readonly laneId: string;
	/** The task's title or plain-words intent, shown in the headline. */
	readonly title: string;
	readonly claim?: Pick<
		WorkerClaim,
		"changedFiles" | "commandReceipts" | "report" | "hostVerdict" | "hostFindings" | "inconclusive"
	>;
	readonly outcome?: Pick<Outcome, "coverage" | "changedFiles" | "cost" | "digestRef">;
	/** The brief the task was dispatched with; its done-when and out-of-scope lines are repeated. */
	readonly brief?: Pick<TaskBrief, "done" | "outOfScope">;
	/** Requirement ids the dispatch named, used when neither the outcome nor the report lists them. */
	readonly requirementIds?: readonly string[];
	/** Where the worker's full output lives, when the host kept it. */
	readonly outputUri?: string;
	readonly reviewWaiting?: number;
	/** The text bound of this sheet; a delivery carrying several sheets gives each its share. */
	readonly maxTextBytes?: number;
}

type WorkerClaimInput = WorkerProofSheetInput["claim"];

/**
 * The checks the worker's report made and the lines it left open, each read against the host's receipts: a check the host
 * holds no receipt for is open, and so is a check the worker never ran.
 */
function reviewWorkerClaim(claim: WorkerClaimInput): { checks: ProofCheck[]; inconclusive: string[] } {
	const receipts = claim?.commandReceipts ?? [];
	const report = claim?.report;
	const checks: ProofCheck[] = [];
	// The claim's own inconclusive list already holds the text of each requirement-bound item (worker-report), so only the items it lacks are added.
	const inconclusive: string[] = [...(claim?.inconclusive ?? [])];
	for (const check of report?.checks ?? []) {
		if (check.result === "not_run") {
			inconclusive.push(`check not run: ${check.command}`);
			continue;
		}
		// The receipt the check names, or the latest of its command, read as the delivery verdict reads it.
		const resolved = resolvedCheckReceipt(check, receipts);
		if (!resolved) {
			inconclusive.push(`check reported ${check.result} without a matching finished host receipt: ${check.command}`);
			continue;
		}
		const { receipt, outcome } = resolved;
		// The worker's own map of the requirements this receipt evidences (by its id or its alias): its claim, which no count takes as coverage.
		const claimedCovers = (report?.requirements ?? [])
			.filter((requirement) =>
				requirement.evidence.some((ref) => ref === receipt.id || ref === receiptAlias(receipt)),
			)
			.map((requirement) => requirement.id);
		checks.push({ label: receipt.command, passed: outcome === "passed", covers: [], claimedCovers, ref: receipt.id });
	}
	for (const item of report?.inconclusiveRequirements ?? []) {
		// The claim keeps the item bounded as its inconclusive lines are (worker-report), so the match is on that bounded text.
		const claimText = boundedText(item.item.trim(), MAX_WORKER_CLAIM_BLOCKER_CHARS);
		if (!inconclusive.includes(claimText)) inconclusive.push(`${item.requirementId}: ${item.item}`);
	}
	return { checks, inconclusive };
}

/**
 * The facts a worker result's stakes read: its changed files, protected-path findings, shell and python receipts, spend and
 * open items. A receipt scanned when it was built carries its facts, read from the full command; an older receipt is read
 * from its head: shell lines to the shell reader, python sources to the code scan.
 */
function workerStakesFacts(
	input: Pick<WorkerProofSheetInput, "claim" | "outcome">,
	checks: readonly ProofCheck[],
	inconclusive: readonly string[],
): ProofStakesFacts {
	const { claim, outcome } = input;
	const receipts = claim?.commandReceipts ?? [];
	const scanned = receipts.filter((receipt) => receipt.stakesFacts !== undefined);
	const unscanned = receipts.filter((receipt) => receipt.stakesFacts === undefined);
	return {
		changedFiles: outcome?.changedFiles ?? claim?.changedFiles ?? [],
		protectedFiles: (claim?.hostFindings ?? [])
			.filter((finding) => finding.code === "protected_path")
			.map((finding) => finding.text),
		commands: unscanned.filter((receipt) => receipt.tool !== "python").map((receipt) => receipt.command),
		scripts: unscanned.filter((receipt) => receipt.tool === "python").map((receipt) => receipt.command),
		scannedFacts: scanned.flatMap((receipt) => receipt.stakesFacts ?? []),
		scannedFileWrites: scanned.reduce((total, receipt) => total + (receipt.stakesFileWrites ?? 0), 0),
		unreadScripts: scanned.reduce((total, receipt) => total + (receipt.stakesUnread ?? 0), 0),
		...(outcome ? { spendUsd: outcome.cost.usd } : {}),
		failedChecks: checks.filter((check) => !check.passed).length,
		inconclusive: inconclusive.length,
	};
}

/**
 * The stakes of one worker result, read from the host's own records. The worker proof sheet shows this reading, and the plan
 * executor records it on the step it settles, so both rate a result the same way.
 */
export function workerResultStakes(input: Pick<WorkerProofSheetInput, "claim" | "outcome">): ProofStakes {
	const { checks, inconclusive } = reviewWorkerClaim(input.claim);
	return readProofStakes(workerStakesFacts(input, checks, inconclusive));
}

/** The proof sheet of one worker result, as owner text and the record a delivery stores under `details.proofSheet`. */
export function buildWorkerProofSheet(input: WorkerProofSheetInput): { text: string; record: ProofSheetRecord } {
	const { claim, outcome } = input;
	const receipts = claim?.commandReceipts ?? [];
	const commands: ProofCommand[] = receipts.map((receipt) => ({
		command: receipt.command,
		outcome: receipt.isError ? "failed" : "passed",
		...(receipt.exitCode !== undefined ? { exitCode: receipt.exitCode } : {}),
		ref: receipt.id,
	}));
	const report = claim?.report;
	const { checks, inconclusive } = reviewWorkerClaim(claim);
	const requirementIds =
		outcome?.coverage.required ??
		(report && report.requirements.length > 0
			? report.requirements.map((requirement) => requirement.id)
			: (input.requirementIds ?? []));
	const hostCovered = outcome
		? outcome.coverage.covered.map((entry) => entry.id)
		: (claim?.hostVerdict?.coveredRequirementIds ?? []);
	const changedFiles = outcome?.changedFiles ?? claim?.changedFiles;
	const fileServes: Record<string, string[]> = {};
	for (const change of report?.changes ?? []) {
		fileServes[change.file] = [...(fileServes[change.file] ?? []), ...(change.serves ?? [])];
	}
	const stakes = readProofStakes(workerStakesFacts(input, checks, inconclusive));
	const sheet = buildProofSheet({
		subject: { kind: "worker", id: input.laneId, title: input.title },
		stakes,
		commands,
		checks,
		requirementIds,
		hostCoveredRequirementIds: hostCovered,
		...(changedFiles ? { changedFiles } : {}),
		fileServes,
		inconclusive,
		assumptions: report?.assumptions ?? [],
		...(input.brief?.done ? { doneWhen: input.brief.done } : {}),
		...(input.brief?.outOfScope ? { outOfScope: input.brief.outOfScope } : {}),
		...(input.reviewWaiting !== undefined ? { reviewWaiting: input.reviewWaiting } : {}),
		sourceRefs: [
			`worker ${input.laneId}`,
			...(input.outputUri ? [input.outputUri] : []),
			...(outcome?.digestRef ? [outcome.digestRef] : []),
		],
	});
	const recordText = renderProofSheet(sheet, input.maxTextBytes);
	const modelText = renderProofSheet(sheet, input.maxTextBytes, { includeQuizOffer: false });
	return { text: modelText, record: proofSheetRecord(sheet, recordText) };
}
