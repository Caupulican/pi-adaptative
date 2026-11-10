/**
 * The one bounded `plan-update` message the root reads per join or plan result (design PG 6.6): at most 4 KiB, at most
 * 8 step lines, host codes `h PLAN_UPDATE,<JOIN_DONE|PLAN_DONE|REPLAN|OWNER_NEEDED>,<READ_REPORT|READ_ALL>`, the result
 * digest, coverage per requirement, gaps, conflicts and the artifact path (for a plan that finished on a plain step, that
 * step's outcome line, changed files and report). Its delivery id is the plan, the step and the event's
 * sequence, so a redelivery after restart is the same input and never a second wake.
 */

import { createHash } from "node:crypto";
import { harnessLog } from "../../kernel/harness-log.ts";
import { renderCommsStateLine, type TaskBrief } from "../comms/comms-records.ts";
import type { Outcome } from "../delegation/worker-outcome-contract.ts";
import { describeOutcomeForHandoff } from "../delegation/worker-outcome-words.ts";
import type { ParentInputDelivery } from "../parent-input-delivery.ts";
import { buildPlanProofSheet } from "../proof/plan-proof-sheet.ts";
import {
	PLAN_UPDATE_CUSTOM_TYPE,
	PROOF_SHEET_DETAILS_KEY,
	type ProofSheetRecord,
	proofSheetUnavailableLine,
} from "../proof/proof-sheet.ts";
import type { ProofStakesLevel } from "../proof/stakes-levels.ts";
import type { CommsStateCode } from "../provider-prompt-contracts.ts";
import type { JoinResult } from "./joins.ts";
import { joinReadsAsReport } from "./joins.ts";
import type { PlanNodeView, PlanView } from "./plan-view.ts";

/** The customType of a plan update; defined with the proof-sheet carriers, re-exported here for its producers. */
export { PLAN_UPDATE_CUSTOM_TYPE };
export const PLAN_UPDATE_MAX_BYTES = 4 * 1024;
const MAX_NODE_LINES = 8;
/** The most conflicts one update names; the full list is in the result file. */
const MAX_CONFLICT_LINES = 4;
const MAX_LINE_CHARS = 240;

export type PlanUpdateKind = "join" | "settled" | "replan" | "owner" | "failed";

export interface PlanUpdateInput {
	readonly kind: PlanUpdateKind;
	/** The step the update is about (the join, the held step, the final step). */
	readonly nodeId?: string;
	readonly result?: JoinResult;
	/** Plain words: why the plan needs a revise, or the question for the owner. */
	readonly detail?: string;
	/** Distinguishes two updates of the same kind about the same step (join sequence, hold generation). */
	readonly sequence: number;
	/** The spec version of the step the update is about: a restated step's join sequence and hold generation start again. */
	readonly since?: number;
	/** The brief of the step the update is about; a result's proof sheet repeats its done-when and out-of-scope lines. */
	readonly brief?: Pick<TaskBrief, "done" | "outOfScope">;
	/** The stakes the join recorded when it settled (its steps' highest level); the result's proof sheet reads it. */
	readonly stakes?: ProofStakesLevel;
	/** A plan that finished on a plain step has no combined result: that step's outcome, which the update then carries. */
	readonly stepOutcome?: Outcome;
}

const KIND_CODE: Readonly<Record<PlanUpdateKind, CommsStateCode>> = {
	join: "JOIN_DONE",
	settled: "PLAN_DONE",
	replan: "REPLAN",
	owner: "OWNER_NEEDED",
	failed: "REPLAN",
};

const KIND_WORDS: Readonly<Record<PlanUpdateKind, string>> = {
	join: "a combined result is ready",
	settled: "the plan finished",
	replan: "the plan needs a revise",
	owner: "a step waits for the owner",
	failed: "a step failed and nothing left in the plan can act on it",
};

const STATE_WORDS: Readonly<Record<PlanNodeView["state"], string>> = {
	planned: "waiting",
	ready: "ready",
	admitted: "starting",
	running: "running",
	settled: "done",
	held: "held",
	superseded: "replaced",
	cancelled: "cancelled",
};

function clip(text: string, max = MAX_LINE_CHARS): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= max ? line : `${line.slice(0, max - 3)}...`;
}

function nodeLine(node: PlanNodeView): string {
	const outcome = node.outcomeStatus ? ` (${node.outcomeStatus})` : "";
	const held = node.held ? ` [${node.held.reason}: ${node.held.detail}]` : "";
	return clip(`- ${node.id}: ${STATE_WORDS[node.state]}${outcome}${held}: ${node.intent}`);
}

/** The nodes worth a line: the update's own step first, then held, failed and running steps, then the rest. */
function pickNodes(view: PlanView, nodeId: string | undefined): readonly PlanNodeView[] {
	const rank = (node: PlanNodeView): number => {
		if (node.id === nodeId) return 0;
		if (node.state === "held") return 1;
		if (node.outcomeStatus && node.outcomeStatus !== "succeeded") return 2;
		if (node.state === "running" || node.state === "admitted") return 3;
		return 4;
	};
	return [...view.nodes].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_NODE_LINES);
}

function bounded(lines: readonly string[]): string {
	const kept: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (bytes + size > PLAN_UPDATE_MAX_BYTES) break;
		kept.push(line);
		bytes += size;
	}
	return kept.join("\n");
}

/**
 * The delivery id of one update: the plan, the kind, the step, the step's spec version and the sequence, so a redelivery is
 * the same input and an update about a restated step is a new one. A step still at its first version keeps the id it
 * always had, so an update delivered by an earlier build is not delivered again.
 */
export function planUpdateDeliveryId(
	planId: string,
	input: Pick<PlanUpdateInput, "kind" | "nodeId" | "sequence" | "since">,
): string {
	const version = input.since !== undefined && input.since > 1 ? `v${input.since}:` : "";
	return `plan-update:${planId}:${input.kind}:${input.nodeId ?? "plan"}:${version}${input.sequence}`;
}

/** The plan-update parent input; `origin` is the receipt origin the root transcript records the input under. */
export function planUpdateDelivery(
	view: PlanView,
	input: PlanUpdateInput,
	origin: ParentInputDelivery["origin"],
): ParentInputDelivery {
	const result = input.result;
	// The plain step a plan finished on, read only when no combined result exists.
	const step = result ? undefined : input.stepOutcome;
	const asReport = result
		? joinReadsAsReport(result)
		: step !== undefined && step.status === "succeeded" && step.coverage.uncovered.length === 0;
	const reads = asReport ? "READ_REPORT" : "READ_ALL";
	const codes = renderCommsStateLine(["PLAN_UPDATE", KIND_CODE[input.kind], reads]);
	const coverage = result ? Object.entries(result.coverage) : [];
	// A combined result carries its proof sheet for the owner (shown ahead of the update); the root reads the update lines.
	// A sheet that cannot be built leaves the update delivered without it, with a plain line in the update's place.
	let proofSheet: ProofSheetRecord | undefined;
	let sheetFailure: string | undefined;
	if (result && (input.kind === "join" || input.kind === "settled")) {
		try {
			proofSheet = buildPlanProofSheet({
				planId: view.planId,
				title: view.title,
				...(input.nodeId ? { nodeId: input.nodeId } : {}),
				result,
				...(input.brief ? { brief: input.brief } : {}),
				...(input.stakes ? { stakes: input.stakes } : {}),
			}).record;
		} catch (error) {
			harnessLog.warn(
				"proof",
				"a plan result's proof sheet could not be built; the update is delivered without it",
				{
					planId: view.planId,
					...(input.nodeId ? { nodeId: input.nodeId } : {}),
				},
			);
			sheetFailure = proofSheetUnavailableLine(error);
		}
	}
	const lines = [
		...(codes ? [codes] : []),
		clip(`Plan "${view.title}" (version ${view.version}): ${KIND_WORDS[input.kind]}.`),
		...(input.detail ? [clip(input.detail, 600)] : []),
		...(result
			? [
					`Result: ${result.outcome.status}${result.winner ? `; winner ${result.winner}` : ""}; ${result.members.length} steps combined.`,
					...(result.changedFiles.length > 0
						? [clip(`Changed files: ${result.changedFiles.join(", ")}`, 600)]
						: []),
					...(coverage.length > 0
						? [
								clip(
									`Requirements: ${coverage.map(([id, met]) => `${id} ${met ? "met" : "not met"}`).join(", ")}`,
									600,
								),
							]
						: []),
					...result.gaps.slice(0, 6).map((gap) => clip(`Gap: ${gap}`)),
					...result.conflicts
						.slice(0, MAX_CONFLICT_LINES)
						.map((conflict) =>
							clip(`Conflict (${conflict.kind}) between ${conflict.between.join(" and ")}: ${conflict.detail}`),
						),
					`Full result: ${result.artifact}`,
				]
			: []),
		...(step
			? [
					clip(`Result: ${describeOutcomeForHandoff(step)}`, 600),
					...(step.changedFiles.length > 0 ? [clip(`Changed files: ${step.changedFiles.join(", ")}`, 600)] : []),
					...(step.digestRef ? [`Report: ${step.digestRef}`] : []),
				]
			: []),
		...(sheetFailure ? [sheetFailure] : []),
		...(view.rootOwned.length > 0 ? [clip(`Requirements no step covers (yours): ${view.rootOwned.join(", ")}`)] : []),
		"Steps:",
		...pickNodes(view, input.nodeId).map(nodeLine),
	];
	const message = {
		customType: PLAN_UPDATE_CUSTOM_TYPE,
		display: true,
		content: bounded(lines),
		details: {
			planId: view.planId,
			version: view.version,
			kind: input.kind,
			...(input.nodeId ? { nodeId: input.nodeId } : {}),
			...(proofSheet ? { [PROOF_SHEET_DETAILS_KEY]: proofSheet } : {}),
		},
	};
	return {
		deliveryId: planUpdateDeliveryId(view.planId, input),
		payloadDigest: createHash("sha256").update(JSON.stringify(message)).digest("hex"),
		message,
		origin,
		...(view.goalId ? { goalId: view.goalId } : {}),
	};
}
