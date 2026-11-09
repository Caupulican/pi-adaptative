/**
 * What a released plan step asks the fleet for: the dispatch (header line, task words, input digests, write scope,
 * demand) and its placement. Pure code over the plan record and the projection.
 */

import { renderTaskBrief } from "../comms/comms-records.ts";
import { describeOutcomeForHandoff } from "../delegation/worker-outcome-words.ts";
import { type FleetDispatch, type FleetPriority, laneSubtreeId } from "../fleet/fleet-types.ts";
import { MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH } from "../orchestration/contracts.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { currentTaskOf } from "../orchestration/task-successor.ts";
import type { Placement } from "../placement/placement-types.ts";
import {
	clipBytes,
	type FindingPair,
	openItemsLine,
	type PacketReport,
	PLAN_INPUT_DIGEST_BYTES,
	planNodePacket,
} from "./plan-evidence.ts";
import {
	isCodeSettledJoin,
	type PlanNodeSpec,
	type PlanRecord,
	type PlanRuntimeState,
	planNodeEdges,
	planTopologicalOrder,
} from "./plan-graph.ts";
import { planNodeOutcome } from "./plan-view.ts";

/** The root-context excerpt an `annotate` exit bakes into a step's brief. */
export const PLAN_ROOT_EXCERPT_BYTES = 2 * 1024;

type DispatchProjection = Pick<TaskRuntimeProjection, "plans" | "tasks" | "attempts">;

/** What a released step's dispatch reads beyond the plan record: the claim reports and a reduce step's open findings. */
export interface PlanDispatchEvidence {
	readonly reportOf: PacketReport;
	/** A reduce step's finding pairs its review left open: the step is told they may conflict. */
	readonly openFindings: readonly FindingPair[];
}

/** The host header every plan step's task starts with, so lanes and ledgers name plan members without the plan. */
export function planDispatchHeader(planId: string, version: number, nodeId: string): string {
	return `[plan ${planId} v${version} | node ${nodeId} | attempt 1]`;
}

/** The fleet idempotency key of one step's spec version: one release per version. */
export function planReleaseKey(planId: string, nodeId: string, version: number): string {
	return `plan:${planId}:${nodeId}:v${version}`;
}

/**
 * The base placement of a released step (X-18): local by default. `placementFor` (`plan-placement.ts`) chooses a linked
 * machine for a read-only step (a must-pin, a pin to a free candidate, or local room at zero) and replaces this base with
 * its own exit. A pinned step that stays local is recorded as `pin_kept_local`, so the trace shows the pin was considered.
 */
export function decidePlacement(node: PlanNodeSpec): { readonly placement: Placement; readonly exit: string } {
	return { placement: { kind: "local_worker" }, exit: node.pin ? "pin_kept_local" : "local_default" };
}

/** Nodes on a longest path of the plan: they are released first. */
export function planCriticalPath(record: PlanRecord): ReadonlySet<string> {
	const order = planTopologicalOrder(record.nodes);
	if (!order.acyclic) return new Set();
	const byId = new Map(record.nodes.map((node) => [node.id, node]));
	const longest = new Map<string, number>();
	const next = new Map<string, string>();
	for (const id of [...order.order].reverse()) {
		let best = 0;
		for (const dependent of record.nodes.filter((node) => planNodeEdges(node).includes(id))) {
			const length = longest.get(dependent.id) ?? 0;
			if (length >= best) {
				best = length;
				next.set(id, dependent.id);
			}
		}
		longest.set(id, best + 1);
	}
	let start = order.order.find((id) => (byId.get(id)?.inputs.length ?? 0) + (byId.get(id)?.after.length ?? 0) === 0);
	for (const id of order.order) if ((longest.get(id) ?? 0) > (longest.get(start ?? "") ?? 0)) start = id;
	const path = new Set<string>();
	for (let id = start; id !== undefined && !path.has(id); id = next.get(id)) path.add(id);
	return path;
}

/** The most changed-file references one predecessor's input line names. */
const PLAN_INPUT_FILES = 8;

function inputDigest(projection: DispatchProjection, plan: PlanRuntimeState, nodeId: string): string {
	const outcome = planNodeOutcome(projection, plan, nodeId);
	if (!outcome) return `Input from step ${nodeId}: no result recorded.`;
	const report = outcome.digestRef ? ` Report: ${outcome.digestRef}` : "";
	const joined = plan.nodes[nodeId]?.join ? ` Combined result: ${plan.nodes[nodeId]?.join?.artifact}` : "";
	// The originals travel as references: a receiving step reads the files and the report, not a retold summary.
	const shownFiles = outcome.changedFiles.slice(0, PLAN_INPUT_FILES);
	const moreFiles = outcome.changedFiles.length - shownFiles.length;
	const files =
		shownFiles.length > 0
			? ` Files it changed: ${shownFiles.join(", ")}${moreFiles > 0 ? `, +${moreFiles} more` : ""}.`
			: "";
	return clipBytes(
		`Input from step ${nodeId}: ${describeOutcomeForHandoff(outcome)}.${report}${joined}${files}`,
		PLAN_INPUT_DIGEST_BYTES,
	);
}

/**
 * What a predecessor left open, as one line (its uncovered requirements and its report's open items). It is its own
 * section, placed before the digests: the instructions are clipped from the tail, so an open item is never the part cut.
 */
function openItemsOf(
	projection: DispatchProjection,
	plan: PlanRuntimeState,
	nodeId: string,
	reportOf: PacketReport,
): string[] {
	const packet = planNodePacket(projection, plan, nodeId, reportOf);
	const line = packet ? openItemsLine(packet) : undefined;
	return line === undefined ? [] : [line];
}

function joinTaskWords(node: PlanNodeSpec, openFindings: readonly FindingPair[]): string | undefined {
	const members = node.join?.members.join(", ") ?? "";
	if (node.kind === "reduce") {
		const possible =
			openFindings.length > 0
				? ` Possibly conflicting, not settled: ${clipBytes(openFindings.map((pair) => `${pair.cite}: ${pair.summaryA} / ${pair.summaryB}`).join("; "), PLAN_INPUT_DIGEST_BYTES)}.`
				: "";
		return `Combine the results of steps ${members} into one answer${node.join?.criterion ? ` to: ${node.join.criterion}` : ""}. Name every place the results disagree and resolve it or say why it stays open.${possible}`;
	}
	if (node.kind === "verify") {
		return `Independently verify the results of steps ${members}: check each claim against the files and commands, and change no file.`;
	}
	return undefined;
}

/** Task ids of the predecessors' accepted work, a display mirror only (the plan record stays the authority). */
function dependencyTaskIds(
	projection: DispatchProjection,
	plan: PlanRuntimeState,
	record: PlanRecord,
	node: PlanNodeSpec,
): string[] {
	const byId = new Map(record.nodes.map((entry) => [entry.id, entry]));
	const taskOf = (id: string): string[] => {
		const predecessor = byId.get(id);
		if (predecessor && isCodeSettledJoin(predecessor.kind)) {
			return (predecessor.join?.members ?? []).flatMap(taskOf);
		}
		const release = plan.nodes[id]?.release;
		return release ? [currentTaskOf(projection, release.taskId)] : [];
	};
	return [...new Set(planNodeEdges(node).flatMap(taskOf))];
}

/**
 * The dispatch of one released step. Its demand's subtree is the one the fleet queues the lane in
 * (`laneSubtreeId`): a plan step's lane carries no parent agent, so it is charged to the session root's subtree. A
 * prepared dispatch and its queued lane must agree, or a subtree-scoped cancel reaches one and misses the other.
 */
export function buildPlanDispatch(
	projection: DispatchProjection,
	plan: PlanRuntimeState,
	record: PlanRecord,
	node: PlanNodeSpec,
	criticalPath: ReadonlySet<string>,
	evidence: PlanDispatchEvidence,
): FleetDispatch {
	const words = joinTaskWords(node, evidence.openFindings);
	const sections = [
		planDispatchHeader(record.planId, node.since, node.id),
		`Plan: ${record.title}`,
		`Task: ${node.intent}`,
		...(words ? [words] : []),
		...(node.brief ? [renderTaskBrief(node.brief)] : []),
		...(node.requirementIds.length > 0 ? [`Requirements this step proves: ${node.requirementIds.join(", ")}`] : []),
		...planNodeEdges(node).flatMap((id) => openItemsOf(projection, plan, id, evidence.reportOf)),
		...planNodeEdges(node).map((id) => inputDigest(projection, plan, id)),
	];
	const onCriticalPath = criticalPath.has(node.id);
	const priority: FleetPriority = node.kind === "verify" ? 3 : onCriticalPath ? 2 : 1;
	const writeScope = node.kind === "verify" ? [] : node.writeScope;
	return {
		idempotencyKey: planReleaseKey(record.planId, node.id, node.since),
		demand: {
			nodeId: node.id,
			objectiveId: record.objectiveId,
			subtreeId: laneSubtreeId(undefined),
			priority,
			onCriticalPath,
			writes: writeScope.length > 0,
			heavy: node.effort === "deep",
		},
		instructions: clipBytes(sections.join("\n\n"), MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH),
		...(node.brief ? { brief: node.brief } : {}),
		writeScope,
		isolation: "shared",
		requirementIds: node.requirementIds,
		dependsOnTaskIds: dependencyTaskIds(projection, plan, record, node),
		thinking: node.effort === "deep" ? "raise_one" : "inherit",
		plan: { planId: record.planId, version: node.since, nodeId: node.id },
	};
}

function messageText(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const { role, content } = message as { role?: unknown; content?: unknown };
	if (role !== "user" && role !== "assistant") return undefined;
	if (typeof content === "string") return content.trim() ? `${role}: ${content.trim()}` : undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.flatMap((part) =>
			part && typeof part === "object" && (part as { type?: unknown }).type === "text"
				? [(part as { text?: unknown }).text]
				: [],
		)
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n")
		.trim();
	return text ? `${role}: ${text}` : undefined;
}

/**
 * The `annotate` exit's excerpt: the root's last two plain-text user/assistant turns on the current branch, at most
 * 2 KiB, newest last. Tool calls and results are not plain turns and are skipped.
 */
export function rootTurnsExcerpt(entries: readonly unknown[]): string | undefined {
	const turns: string[] = [];
	for (let index = entries.length - 1; index >= 0 && turns.length < 2; index -= 1) {
		const entry = entries[index] as { type?: unknown; message?: unknown } | undefined;
		const text = entry?.type === "message" ? messageText(entry.message) : undefined;
		if (text) turns.unshift(text);
	}
	return turns.length > 0 ? clipBytes(turns.join("\n\n"), PLAN_ROOT_EXCERPT_BYTES) : undefined;
}

/** The root's latest plain-text user turn on the current branch, at most `maxBytes`: the request a plan answers. */
export function lastUserRequest(entries: readonly unknown[], maxBytes: number): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: unknown; message?: unknown } | undefined;
		const text = entry?.type === "message" ? messageText(entry.message) : undefined;
		if (text?.startsWith("user: ")) return clipBytes(text.slice("user: ".length), maxBytes);
	}
	return undefined;
}
