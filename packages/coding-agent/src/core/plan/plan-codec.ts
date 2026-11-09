/**
 * The one decoder of durable plan facts, shared by the orchestration reducer (`plan.*` event payloads) and the
 * projection snapshot codec (the `plans` map). A plan record of version 1 is validated field by field; a record from a
 * newer build decodes to its identity only and is marked unsupported, so an older reader replays the journal without
 * refusing it and never executes a shape it does not know.
 */

import { parseTaskBrief, type TaskBrief } from "../comms/comms-records.ts";
import { storedOutcomeFromValue } from "../delegation/worker-outcome-codec.ts";
import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH } from "../orchestration/contracts.ts";
import { exactRecord, record } from "../orchestration/task-runtime-projection.ts";
import { DurableTaskRuntimeError } from "../orchestration/task-runtime-state.ts";
import type { Placement, PlacementPin } from "../placement/placement-types.ts";
import {
	PLAN_CLOSE_STATUSES,
	PLAN_HOLD_REASONS,
	PLAN_LIMITS,
	PLAN_NODE_ID_PATTERN,
	PLAN_NODE_KINDS,
	PLAN_RECORD_VERSION,
	PLAN_STATUSES,
	type PlanClosure,
	type PlanFromNewerBuild,
	type PlanJoinSettlement,
	type PlanJoinSpec,
	type PlanJudgmentRef,
	type PlanNodeHold,
	type PlanNodeRelease,
	type PlanNodeRuntime,
	type PlanNodeSettlement,
	type PlanNodeSpec,
	type PlanRecord,
	type PlanRetiredTask,
	type PlanRuntimeState,
	type PlanSubgraphOf,
	type StoredPlanRecord,
} from "./plan-graph.ts";

const fail = (label: string, why: string): never => {
	throw new DurableTaskRuntimeError(`${label} ${why}.`);
};

function text(value: unknown, maxChars: number, label: string): string {
	if (typeof value === "string" && value.length > 0 && value.length <= maxChars) return value;
	return fail(label, `must be text of 1 to ${maxChars} characters`);
}

function optionalText(value: unknown, maxChars: number, label: string): string | undefined {
	return value === undefined ? undefined : text(value, maxChars, label);
}

function id(value: unknown, label: string): string {
	return text(value, MAX_ORCHESTRATION_IDENTIFIER_LENGTH, label);
}

function nodeId(value: unknown, label: string): string {
	const decoded = text(value, PLAN_LIMITS.idChars, label);
	return PLAN_NODE_ID_PATTERN.test(decoded) ? decoded : fail(label, "is not a step id");
}

function positive(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max) return value;
	return fail(label, `must be a whole number from 1 to ${max}`);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
	const match = allowed.find((entry) => entry === value);
	return match ?? fail(label, `must be one of ${allowed.join(", ")}`);
}

function entries<T>(value: unknown, max: number, label: string, decode: (entry: unknown, at: string) => T): T[] {
	if (!Array.isArray(value)) return fail(label, "must be a list");
	if (value.length > max) return fail(label, `holds more than ${max} entries`);
	return value.map((entry, index) => decode(entry, `${label}[${index}]`));
}

function briefFromValue(value: unknown, label: string): TaskBrief {
	try {
		return parseTaskBrief(value);
	} catch (error) {
		return fail(label, error instanceof Error ? error.message : "is invalid");
	}
}

export function placementFromValue(value: unknown, label: string): Placement {
	const input = record(value, label);
	switch (input.kind) {
		case "local_worker":
			exactRecord(input, label, ["kind"]);
			return { kind: "local_worker" };
		case "bot":
			exactRecord(input, label, ["kind", "botId"]);
			return { kind: "bot", botId: id(input.botId, `${label}.botId`) };
		case "leader": {
			exactRecord(input, label, ["kind", "botId", "machineId"]);
			const botId = input.botId === undefined ? undefined : id(input.botId, `${label}.botId`);
			const machineId = input.machineId === undefined ? undefined : id(input.machineId, `${label}.machineId`);
			return { kind: "leader", ...(botId ? { botId } : {}), ...(machineId ? { machineId } : {}) };
		}
		case "remote_machine":
			exactRecord(input, label, ["kind", "machineId"]);
			return { kind: "remote_machine", machineId: id(input.machineId, `${label}.machineId`) };
		default:
			return fail(`${label}.kind`, "is not a placement");
	}
}

function pinFromValue(value: unknown, label: string): PlacementPin {
	const input = exactRecord(value, label, ["target", "mode"]);
	const mode = oneOf(input.mode, ["must", "prefer"] as const, `${label}.mode`);
	if (input.target === "here") return { target: "here", mode };
	const target = record(input.target, `${label}.target`);
	if (typeof target.machineId === "string") {
		exactRecord(target, `${label}.target`, ["machineId"]);
		return { target: { machineId: text(target.machineId, PLAN_LIMITS.pinChars, `${label}.target.machineId`) }, mode };
	}
	exactRecord(target, `${label}.target`, ["botId"]);
	return { target: { botId: text(target.botId, PLAN_LIMITS.pinChars, `${label}.target.botId`) }, mode };
}

function joinFromValue(value: unknown, label: string): PlanJoinSpec {
	const input = exactRecord(value, label, ["members", "criterion", "quorum"]);
	const criterion = optionalText(input.criterion, PLAN_LIMITS.criterionChars, `${label}.criterion`);
	return {
		members: entries(input.members, PLAN_LIMITS.joinMembersMax, `${label}.members`, nodeId),
		...(criterion !== undefined ? { criterion } : {}),
		...(input.quorum !== undefined
			? { quorum: positive(input.quorum, `${label}.quorum`, PLAN_LIMITS.joinMembersMax) }
			: {}),
	};
}

const NODE_FIELDS = [
	"id",
	"kind",
	"intent",
	"brief",
	"inputs",
	"after",
	"writeScope",
	"requirementIds",
	"pin",
	"effort",
	"join",
	"since",
] as const;

function nodeFromValue(value: unknown, label: string): PlanNodeSpec {
	const input = exactRecord(value, label, NODE_FIELDS);
	return {
		id: nodeId(input.id, `${label}.id`),
		kind: oneOf(input.kind, PLAN_NODE_KINDS, `${label}.kind`),
		intent: text(input.intent, PLAN_LIMITS.intentChars, `${label}.intent`),
		...(input.brief !== undefined ? { brief: briefFromValue(input.brief, `${label}.brief`) } : {}),
		inputs: entries(input.inputs, PLAN_LIMITS.edgeEntries, `${label}.inputs`, nodeId),
		after: entries(input.after, PLAN_LIMITS.edgeEntries, `${label}.after`, nodeId),
		writeScope: entries(input.writeScope, PLAN_LIMITS.writeScopeEntries, `${label}.writeScope`, (entry, at) =>
			text(entry, 4096, at),
		),
		requirementIds: entries(input.requirementIds, PLAN_LIMITS.requirementEntries, `${label}.requirementIds`, id),
		...(input.pin !== undefined ? { pin: pinFromValue(input.pin, `${label}.pin`) } : {}),
		effort: oneOf(input.effort, ["normal", "deep"] as const, `${label}.effort`),
		...(input.join !== undefined ? { join: joinFromValue(input.join, `${label}.join`) } : {}),
		since: positive(input.since, `${label}.since`, PLAN_LIMITS.versions),
	};
}

function judgmentFromValue(value: unknown, label: string): PlanJudgmentRef {
	const input = exactRecord(value, label, ["program", "questionId", "ledgerRef"]);
	return {
		program: id(input.program, `${label}.program`),
		questionId: id(input.questionId, `${label}.questionId`),
		ledgerRef: id(input.ledgerRef, `${label}.ledgerRef`),
	};
}

function subgraphFromValue(value: unknown, label: string): PlanSubgraphOf {
	const input = exactRecord(value, label, ["parentPlanId", "parentNodeId", "delegationObjectiveId"]);
	return {
		parentPlanId: id(input.parentPlanId, `${label}.parentPlanId`),
		parentNodeId: nodeId(input.parentNodeId, `${label}.parentNodeId`),
		delegationObjectiveId: id(input.delegationObjectiveId, `${label}.delegationObjectiveId`),
	};
}

const RECORD_FIELDS = [
	"v",
	"planId",
	"version",
	"objectiveId",
	"goalId",
	"subgraphOf",
	"title",
	"nodes",
	"rootOwned",
	"final",
	"status",
	"unjudged",
	"judgments",
	"createdAt",
	"revisedAt",
] as const;

function newerPlan(input: Record<string, unknown>, version: number): PlanFromNewerBuild {
	const planId =
		typeof input.planId === "string" && /^pl-[0-9a-f]{8}$/.test(input.planId) ? input.planId : "pl-unknown";
	const planVersion =
		typeof input.version === "number" && Number.isSafeInteger(input.version) && input.version > 0 ? input.version : 0;
	return { v: version, planId, version: planVersion, unsupported: true };
}

/** Decodes a stored plan record; see the module comment for the newer-build rule. */
export function planRecordFromValue(value: unknown, label: string): StoredPlanRecord {
	const input = record(value, label);
	const v = input.v;
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) return fail(`${label}.v`, "is invalid");
	if (v > PLAN_RECORD_VERSION) return newerPlan(input, v);
	exactRecord(input, label, RECORD_FIELDS);
	const planId = text(input.planId, 11, `${label}.planId`);
	if (!/^pl-[0-9a-f]{8}$/.test(planId)) fail(`${label}.planId`, "is not a plan id");
	if (typeof input.unjudged !== "boolean") fail(`${label}.unjudged`, "must be true or false");
	const goalId = input.goalId === undefined ? undefined : id(input.goalId, `${label}.goalId`);
	const decoded: PlanRecord = {
		v: PLAN_RECORD_VERSION,
		planId,
		version: positive(input.version, `${label}.version`, PLAN_LIMITS.versions),
		objectiveId: id(input.objectiveId, `${label}.objectiveId`),
		...(goalId !== undefined ? { goalId } : {}),
		...(input.subgraphOf !== undefined
			? { subgraphOf: subgraphFromValue(input.subgraphOf, `${label}.subgraphOf`) }
			: {}),
		title: text(input.title, PLAN_LIMITS.titleChars, `${label}.title`),
		nodes: entries(input.nodes, PLAN_LIMITS.nodes, `${label}.nodes`, nodeFromValue),
		rootOwned: entries(input.rootOwned, PLAN_LIMITS.requirementEntries * PLAN_LIMITS.nodes, `${label}.rootOwned`, id),
		final: nodeId(input.final, `${label}.final`),
		status: oneOf(input.status, PLAN_STATUSES, `${label}.status`),
		unjudged: input.unjudged === true,
		judgments: entries(input.judgments, PLAN_LIMITS.judgments, `${label}.judgments`, judgmentFromValue),
		createdAt: id(input.createdAt, `${label}.createdAt`),
		revisedAt: id(input.revisedAt, `${label}.revisedAt`),
	};
	if (decoded.nodes.some((node) => node.since > decoded.version)) fail(`${label}.nodes`, "name a later version");
	if (!decoded.nodes.some((node) => node.id === decoded.final)) fail(`${label}.final`, "names no step of the plan");
	return decoded;
}

/** `plan.node_released` payload. */
export interface PlanNodeReleasedPayload {
	readonly planId: string;
	readonly version: number;
	readonly nodeId: string;
	readonly taskId: string;
	readonly placement: Placement;
	readonly exit: string;
}

export function planNodeReleasedFromValue(value: unknown, label: string): PlanNodeReleasedPayload {
	const input = exactRecord(value, label, ["planId", "version", "nodeId", "taskId", "placement", "exit"]);
	return {
		planId: id(input.planId, `${label}.planId`),
		version: positive(input.version, `${label}.version`, PLAN_LIMITS.versions),
		nodeId: nodeId(input.nodeId, `${label}.nodeId`),
		taskId: id(input.taskId, `${label}.taskId`),
		placement: placementFromValue(input.placement, `${label}.placement`),
		exit: id(input.exit, `${label}.exit`),
	};
}

/** `plan.node_settled` payload. */
export interface PlanNodeSettledPayload {
	readonly planId: string;
	readonly nodeId: string;
	readonly outcomeId: string;
	readonly generation: number;
}

export function planNodeSettledFromValue(value: unknown, label: string): PlanNodeSettledPayload {
	const input = exactRecord(value, label, ["planId", "nodeId", "outcomeId", "generation"]);
	return {
		planId: id(input.planId, `${label}.planId`),
		nodeId: nodeId(input.nodeId, `${label}.nodeId`),
		outcomeId: id(input.outcomeId, `${label}.outcomeId`),
		generation: positive(input.generation, `${label}.generation`),
	};
}

/** `plan.node_held` payload. */
export interface PlanNodeHeldPayload {
	readonly planId: string;
	readonly nodeId: string;
	readonly reason: PlanNodeHold["reason"];
	readonly detail: string;
	readonly generation: number;
}

export function planNodeHeldFromValue(value: unknown, label: string): PlanNodeHeldPayload {
	const input = exactRecord(value, label, ["planId", "nodeId", "reason", "detail", "generation"]);
	return {
		planId: id(input.planId, `${label}.planId`),
		nodeId: nodeId(input.nodeId, `${label}.nodeId`),
		reason: oneOf(input.reason, PLAN_HOLD_REASONS, `${label}.reason`),
		detail: text(input.detail, PLAN_LIMITS.detailChars, `${label}.detail`),
		generation: positive(input.generation, `${label}.generation`),
	};
}

/** `plan.join_settled` payload. */
export interface PlanJoinSettledPayload {
	readonly planId: string;
	readonly nodeId: string;
	readonly outcome: PlanJoinSettlement["outcome"];
	readonly artifact: string;
}

export function planJoinSettledFromValue(value: unknown, label: string): PlanJoinSettledPayload {
	const input = exactRecord(value, label, ["planId", "nodeId", "outcome", "artifact"]);
	return {
		planId: id(input.planId, `${label}.planId`),
		nodeId: nodeId(input.nodeId, `${label}.nodeId`),
		outcome: storedOutcomeFromValue(input.outcome, `${label}.outcome`),
		artifact: text(input.artifact, PLAN_LIMITS.artifactChars, `${label}.artifact`),
	};
}

/** `plan.closed` payload. */
export interface PlanClosedPayload {
	readonly planId: string;
	readonly status: PlanClosure["status"];
	readonly reason: string;
}

export function planClosedFromValue(value: unknown, label: string): PlanClosedPayload {
	const input = exactRecord(value, label, ["planId", "status", "reason"]);
	return {
		planId: id(input.planId, `${label}.planId`),
		status: oneOf(input.status, PLAN_CLOSE_STATUSES, `${label}.status`),
		reason: text(input.reason, PLAN_LIMITS.reasonChars, `${label}.reason`),
	};
}

function releaseFromValue(value: unknown, label: string): PlanNodeRelease {
	const input = exactRecord(value, label, ["version", "taskId", "placement", "exit", "releasedAt"]);
	return {
		version: positive(input.version, `${label}.version`, PLAN_LIMITS.versions),
		taskId: id(input.taskId, `${label}.taskId`),
		placement: placementFromValue(input.placement, `${label}.placement`),
		exit: id(input.exit, `${label}.exit`),
		releasedAt: id(input.releasedAt, `${label}.releasedAt`),
	};
}

function settlementFromValue(value: unknown, label: string): PlanNodeSettlement {
	const input = exactRecord(value, label, ["outcomeId", "generation", "settledAt"]);
	return {
		outcomeId: id(input.outcomeId, `${label}.outcomeId`),
		generation: positive(input.generation, `${label}.generation`),
		settledAt: id(input.settledAt, `${label}.settledAt`),
	};
}

function holdFromValue(value: unknown, label: string): PlanNodeHold {
	const input = exactRecord(value, label, ["reason", "detail", "generation", "heldAt"]);
	return {
		reason: oneOf(input.reason, PLAN_HOLD_REASONS, `${label}.reason`),
		detail: text(input.detail, PLAN_LIMITS.detailChars, `${label}.detail`),
		generation: positive(input.generation, `${label}.generation`),
		heldAt: id(input.heldAt, `${label}.heldAt`),
	};
}

function joinSettlementFromValue(value: unknown, label: string): PlanJoinSettlement {
	const input = exactRecord(value, label, ["outcome", "artifact", "n", "settledAt"]);
	return {
		outcome: storedOutcomeFromValue(input.outcome, `${label}.outcome`),
		artifact: text(input.artifact, PLAN_LIMITS.artifactChars, `${label}.artifact`),
		n: positive(input.n, `${label}.n`),
		settledAt: id(input.settledAt, `${label}.settledAt`),
	};
}

function nodeRuntimeFromValue(value: unknown, label: string): PlanNodeRuntime {
	const input = exactRecord(value, label, ["since", "release", "settled", "held", "join"]);
	return {
		since: positive(input.since, `${label}.since`, PLAN_LIMITS.versions),
		...(input.release !== undefined ? { release: releaseFromValue(input.release, `${label}.release`) } : {}),
		...(input.settled !== undefined ? { settled: settlementFromValue(input.settled, `${label}.settled`) } : {}),
		...(input.held !== undefined ? { held: holdFromValue(input.held, `${label}.held`) } : {}),
		...(input.join !== undefined ? { join: joinSettlementFromValue(input.join, `${label}.join`) } : {}),
	};
}

function retiredFromValue(value: unknown, label: string): PlanRetiredTask {
	const input = exactRecord(value, label, ["nodeId", "taskId", "reason"]);
	return {
		nodeId: nodeId(input.nodeId, `${label}.nodeId`),
		taskId: id(input.taskId, `${label}.taskId`),
		reason: oneOf(input.reason, ["superseded", "removed", "cancelled"] as const, `${label}.reason`),
	};
}

/** Decodes one entry of the projection's `plans` map from a snapshot. */
export function planRuntimeStateFromValue(value: unknown, label: string): PlanRuntimeState {
	const input = exactRecord(value, label, ["record", "nodes", "retired", "closed"]);
	const nodes = record(input.nodes, `${label}.nodes`);
	if (Object.keys(nodes).length > PLAN_LIMITS.nodes)
		fail(`${label}.nodes`, `holds more than ${PLAN_LIMITS.nodes} steps`);
	let closed: PlanClosure | undefined;
	if (input.closed !== undefined) {
		const raw = exactRecord(input.closed, `${label}.closed`, ["status", "reason", "closedAt"]);
		closed = {
			status: oneOf(raw.status, PLAN_CLOSE_STATUSES, `${label}.closed.status`),
			reason: text(raw.reason, PLAN_LIMITS.reasonChars, `${label}.closed.reason`),
			closedAt: id(raw.closedAt, `${label}.closed.closedAt`),
		};
	}
	return {
		record: planRecordFromValue(input.record, `${label}.record`),
		nodes: Object.fromEntries(
			Object.entries(nodes).map(([key, entry]) => [
				nodeId(key, `${label}.nodes key`),
				nodeRuntimeFromValue(entry, `${label}.nodes.${key}`),
			]),
		),
		retired: entries(input.retired, PLAN_LIMITS.retiredTasks, `${label}.retired`, retiredFromValue),
		...(closed ? { closed } : {}),
	};
}
