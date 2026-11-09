/**
 * The one bounded `plan-update` message the root reads per join or plan result (design PG 6.6): at most 4 KiB, at most
 * 8 step lines, host codes `h PLAN_UPDATE,<JOIN_DONE|PLAN_DONE|REPLAN|OWNER_NEEDED>,<READ_REPORT|READ_ALL>`, the result
 * digest, coverage per requirement, gaps and the artifact path. Its delivery id is the plan, the step and the event's
 * sequence, so a redelivery after restart is the same input and never a second wake.
 */

import { createHash } from "node:crypto";
import { renderCommsStateLine } from "../comms/comms-records.ts";
import type { ParentInputDelivery } from "../parent-input-delivery.ts";
import type { CommsStateCode } from "../provider-prompt-contracts.ts";
import type { JoinResult } from "./joins.ts";
import { joinReadsAsReport } from "./joins.ts";
import type { PlanNodeView, PlanView } from "./plan-view.ts";

export const PLAN_UPDATE_CUSTOM_TYPE = "plan-update";
export const PLAN_UPDATE_MAX_BYTES = 4 * 1024;
const MAX_NODE_LINES = 8;
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

/** The delivery id of one update: the plan, the kind, the step and the sequence, so a redelivery is the same input. */
export function planUpdateDeliveryId(
	planId: string,
	input: Pick<PlanUpdateInput, "kind" | "nodeId" | "sequence">,
): string {
	return `plan-update:${planId}:${input.kind}:${input.nodeId ?? "plan"}:${input.sequence}`;
}

/** The plan-update parent input; `origin` is the receipt origin the root transcript records the input under. */
export function planUpdateDelivery(
	view: PlanView,
	input: PlanUpdateInput,
	origin: ParentInputDelivery["origin"],
): ParentInputDelivery {
	const result = input.result;
	const reads = result && joinReadsAsReport(result) ? "READ_REPORT" : "READ_ALL";
	const codes = renderCommsStateLine(["PLAN_UPDATE", KIND_CODE[input.kind], reads]);
	const coverage = result ? Object.entries(result.coverage) : [];
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
					`Full result: ${result.artifact}`,
				]
			: []),
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
