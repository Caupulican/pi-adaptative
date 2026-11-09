/**
 * Goal proof sheet: the proof sheet of a goal that just completed, read from the goal's own record.
 *
 * Requirement checks the harness reran, verified test and tool evidence and the commands behind it (read from the
 * session branch), the completion account's file-to-requirement map and assumptions, and the stakes facts of the goal's
 * lifetime (every command since the goal started, protected files among the changed ones, recorded spend). Nothing here
 * is a model statement except the account's assumptions, its claimed file paths and its blocked reasons, which are shown as
 * what the work says: observed changed files come from the work diff alone.
 */

import path from "node:path";
import type { SessionManager } from "../../kernel/node.ts";
import { getHarnessWriteProtectedPaths } from "../autonomy/lane-private-paths.ts";
import { isPathWithinScope } from "../autonomy/path-scope.ts";
import type { GoalEvidenceRef, GoalState } from "../goals/goal-state.ts";
import type { CompletionAccount } from "../system-one/completion-account.ts";
import {
	buildProofSheet,
	type ProofCheck,
	type ProofCommand,
	type ProofSheetRecord,
	proofSheetRecord,
	readProofSheetRecords,
	renderProofSheet,
} from "./proof-sheet.ts";
import { highestProofStakes, type ProofStakes, readProofStakes } from "./proof-stakes.ts";
import { countSessionOutboundActions, readSessionCommandReceipts } from "./session-command-receipts.ts";

const CHECK_OUTPUT_MARKER = " Output: ";

export interface GoalProofSheetInput {
	readonly state: GoalState;
	readonly account?: CompletionAccount;
	/** Files the goal changed as the work diff observed them; undefined when no diff was read. */
	readonly changedFiles?: readonly string[];
	readonly sessionManager: Pick<SessionManager, "getBranch">;
	readonly cwd: string;
	readonly agentDir: string;
	readonly reviewWaiting?: number;
}

/** The changed files that sit on a harness write-protected path, by containment against the protected roots. */
export function protectedChangedFiles(changedFiles: readonly string[], cwd: string, agentDir: string): string[] {
	if (changedFiles.length === 0) return [];
	const roots = getHarnessWriteProtectedPaths(cwd, agentDir);
	return changedFiles.filter((file) => {
		const absolute = path.resolve(cwd, file);
		return roots.some((root) => isPathWithinScope(absolute, root));
	});
}

function latestCheckEvidence(state: GoalState, requirementId: string): GoalEvidenceRef | undefined {
	return state.evidence.findLast((entry) => entry.kind === "check" && entry.uri === requirementId);
}

function checkOutputTail(summary: string): string | undefined {
	const index = summary.indexOf(CHECK_OUTPUT_MARKER);
	return index >= 0 ? summary.slice(index + CHECK_OUTPUT_MARKER.length) : undefined;
}

/** The stakes of the worker results delivered on the branch since `since`, each as its own reading. */
function workerResultStakes(entries: ReturnType<SessionManager["getBranch"]>, since: string): ProofStakes[] {
	return entries.flatMap((entry) => {
		if (entry.type !== "custom_message" || entry.timestamp < since) return [];
		return readProofSheetRecords(entry.details, { kind: "custom-message", customType: entry.customType })
			.filter((record) => record.subject.kind === "worker")
			.map((record) => ({ level: record.level, facts: record.stakesFacts }));
	});
}

/** The proof sheet of a completed goal, as owner text and the record a delivery stores under `details.proofSheet`. */
export function buildGoalProofSheet(input: GoalProofSheetInput): { text: string; record: ProofSheetRecord } {
	const { state } = input;
	const checks: ProofCheck[] = [];
	const commands: ProofCommand[] = [];
	for (const requirement of state.requirements) {
		if (!requirement.check) continue;
		const evidence = latestCheckEvidence(state, requirement.id);
		if (!evidence) continue;
		const passed = evidence.outcome === "succeeded";
		checks.push({ label: requirement.check.command, passed, covers: [requirement.id], ref: evidence.id });
		const tail = checkOutputTail(evidence.summary);
		commands.push({
			command: requirement.check.command,
			outcome: passed ? "passed" : "failed",
			...(tail ? { outputTail: tail } : {}),
			ref: evidence.id,
		});
	}
	const cited = state.evidence.filter(
		(entry) => (entry.kind === "test" || entry.kind === "tool") && entry.verified === true && entry.uri,
	);
	const receipts = readSessionCommandReceipts(input.sessionManager, {
		toolCallIds: new Set(cited.map((entry) => entry.uri as string)),
	});
	const receiptByCall = new Map(receipts.map((receipt) => [receipt.ref, receipt]));
	// A citation is a check only with a finished host receipt. Without one, the work's own summary is a claim, never a pass.
	const claimed: string[] = [];
	for (const entry of cited) {
		const covers = state.requirements
			.filter((requirement) => requirement.evidenceIds.includes(entry.id))
			.map((requirement) => requirement.id);
		const receipt = receiptByCall.get(entry.uri);
		if (receipt) commands.push(receipt);
		if (receipt?.outcome === "passed" || receipt?.outcome === "failed") {
			checks.push({ label: receipt.command, passed: receipt.outcome === "passed", covers, ref: entry.id });
		} else {
			claimed.push(`claimed by the work, no finished host receipt: ${entry.summary}`);
		}
	}
	const lifetimeCommands = readSessionCommandReceipts(input.sessionManager, { since: state.createdAt });
	const fileServes: Record<string, string[]> = {};
	const requirementIds = new Set(state.requirements.map((requirement) => requirement.id));
	for (const change of input.account?.changes ?? []) {
		const paths = Array.isArray(change.path) ? change.path : [change.path];
		const serves = change.serves.filter((target) => requirementIds.has(target));
		for (const file of paths) fileServes[file] = [...(fileServes[file] ?? []), ...serves];
	}
	// Observed files come from the work diff only; without one, the account's paths are what the work claims.
	const changedFiles = input.changedFiles;
	const claimedFiles = input.changedFiles === undefined && input.account ? Object.keys(fileServes) : undefined;
	const inconclusive = [
		...state.requirements
			.filter((requirement) => requirement.status === "blocked")
			.map(
				(requirement) =>
					`${requirement.id} blocked: ${requirement.blockedReason ? `the work says: ${requirement.blockedReason}` : "no reason recorded"}`,
			),
		...claimed,
	];
	const ownStakes = readProofStakes({
		changedFiles: changedFiles ?? [],
		protectedFiles: protectedChangedFiles(changedFiles ?? [], input.cwd, input.agentDir),
		commands: lifetimeCommands.filter((command) => command.language === undefined).map((command) => command.command),
		scripts: lifetimeCommands.filter((command) => command.language === "python").map((command) => command.command),
		spendUsd: (state.continuationSpendUsd ?? 0) + (state.continuationWorkerSpendUsd ?? 0),
		failedChecks: checks.filter((check) => !check.passed).length,
		inconclusive: inconclusive.length,
		outboundActions: countSessionOutboundActions(input.sessionManager, state.createdAt),
	});
	// The worker results delivered since the goal started carry their own stakes (their commands and protected files).
	const stakes = highestProofStakes([
		ownStakes,
		...workerResultStakes(input.sessionManager.getBranch(), state.createdAt),
	]);
	const sheet = buildProofSheet({
		subject: { kind: "goal", id: state.goalId, title: state.userGoal },
		stakes,
		commands,
		checks,
		requirementIds: state.requirements.map((requirement) => requirement.id),
		...(changedFiles ? { changedFiles } : {}),
		...(claimedFiles ? { claimedFiles } : {}),
		fileServes,
		inconclusive,
		assumptions: (input.account?.assumptions ?? []).map((assumption) => assumption.claim),
		...(input.reviewWaiting !== undefined ? { reviewWaiting: input.reviewWaiting } : {}),
		sourceRefs: [`goal ${state.goalId}`],
	});
	const citedCalls = new Set(receipts.map((receipt) => receipt.ref));
	const otherCommands = lifetimeCommands.filter((command) => !citedCalls.has(command.ref)).length;
	const text = [
		renderProofSheet(sheet),
		...(otherCommands > 0
			? [`${otherCommands} other command(s) ran during the goal without being cited as evidence.`]
			: []),
	].join("\n");
	return { text, record: proofSheetRecord(sheet, text) };
}
