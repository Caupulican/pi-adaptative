/**
 * The plan graph: a root's whole decomposition of one goal as nodes and edges, recorded in the orchestration event
 * store and executed by the plan executor. This module is the dependency-free leaf every other plan module reads:
 * the record shapes, the bounds, the code facts F1-F7 checked before a plan is recorded, the topological order and the
 * plan's identity. Nothing here performs I/O or asks System One; judgments live in `system-one/plan-graph-review.ts`
 * and decisions in the executor.
 */

import { createHash } from "node:crypto";
import type { TaskBrief } from "../comms/comms-records.ts";
import type { StoredOutcome } from "../delegation/worker-outcome-contract.ts";
import type { PlanNodeDemand } from "../fleet/fleet-types.ts";
import type { Placement, PlacementPin } from "../placement/placement-types.ts";

export type { PlanNodeDemand };

export const PLAN_RECORD_VERSION = 1 as const;

export const PLAN_NODE_KINDS = ["work", "collect", "reduce", "merge", "vote", "race", "verify"] as const;
export type PlanNodeKind = (typeof PLAN_NODE_KINDS)[number];

/** Kinds that combine the results of the nodes in their `join.members`; every kind except `work`. */
export type PlanJoinKind = Exclude<PlanNodeKind, "work">;

/** Kinds the harness settles without a worker; reduce and verify run a worker task, merge is not built yet. */
export const CODE_SETTLED_JOIN_KINDS: readonly PlanJoinKind[] = ["collect", "race", "vote"];

/** Join kinds a plan may use now: `merge` is reserved and refused by F4 until it is built. */
export const PLAN_OFFERED_JOIN_KINDS: readonly PlanJoinKind[] = ["collect", "reduce", "vote", "race", "verify"];

export function isCodeSettledJoin(kind: PlanNodeKind): boolean {
	return (CODE_SETTLED_JOIN_KINDS as readonly PlanNodeKind[]).includes(kind);
}

export const PLAN_STATUSES = ["active", "settled", "cancelled", "paused"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_HOLD_REASONS = ["replan", "owner", "root"] as const;
export type PlanHoldReason = (typeof PLAN_HOLD_REASONS)[number];

export const PLAN_CLOSE_STATUSES = ["settled", "cancelled"] as const;
export type PlanCloseStatus = (typeof PLAN_CLOSE_STATUSES)[number];

/** Section 2.5 bounds: every one is a code fact checked before a plan version is recorded. */
export const PLAN_LIMITS = {
	nodes: 40,
	joinMembersMin: 2,
	joinMembersMax: 24,
	layerWidth: 24,
	depth: 8,
	versions: 16,
	recordBytes: 64 * 1024,
	retainedPlans: 8,
	idChars: 24,
	titleChars: 120,
	intentChars: 2_000,
	criterionChars: 1_000,
	writeScopeEntries: 32,
	/** One write-scope path, as F5 checks it. */
	scopeChars: 300,
	edgeEntries: 24,
	requirementEntries: 32,
	pinChars: 128,
	reasonChars: 500,
	detailChars: 1_000,
	judgments: 64,
	retiredTasks: 256,
	artifactChars: 256,
} as const;

/** The step id pattern, shared with the fan-out member ids. */
export const PLAN_NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface PlanJoinSpec {
	/** Node ids joined (2..24); always the node's `inputs`, so every member is a predecessor. */
	readonly members: readonly string[];
	/** reduce: the question the combined answer answers; vote: what the winner must meet. */
	readonly criterion?: string;
	/** collect/reduce: members that must be accepted before the join settles; default all. */
	readonly quorum?: number;
}

export interface PlanNodeSpec {
	readonly id: string;
	readonly kind: PlanNodeKind;
	/** Plain-words task, shown on screen. */
	readonly intent: string;
	readonly brief?: TaskBrief;
	/** Nodes whose result digest is rendered into this node's brief at release. */
	readonly inputs: readonly string[];
	/** Pure ordering edges, no data. The node's edges are `inputs` and `after` together. */
	readonly after: readonly string[];
	/** Repository-relative files or folders the node may change, forward slashes; empty is read-only. */
	readonly writeScope: readonly string[];
	readonly requirementIds: readonly string[];
	/** From the step's `by`: prefer this bot, leader or machine. */
	readonly pin?: PlacementPin;
	readonly effort: "normal" | "deep";
	readonly join?: PlanJoinSpec;
	/**
	 * The plan version that last stated this node's spec. A revise that restates a node with a changed spec, or a held
	 * node, sets it to the new version; the store then starts the node afresh. An unchanged node keeps its version and
	 * its running work.
	 */
	readonly since: number;
}

export interface PlanJudgmentRef {
	readonly program: string;
	readonly questionId: string;
	readonly ledgerRef: string;
}

export interface PlanSubgraphOf {
	readonly parentPlanId: string;
	readonly parentNodeId: string;
	readonly delegationObjectiveId: string;
}

export interface PlanRecord {
	readonly v: typeof PLAN_RECORD_VERSION;
	/** "pl-" plus 8 hex of sha256(sessionId, toolCallId). */
	readonly planId: string;
	readonly version: number;
	/** The orchestration objective the plan's tasks are created under. */
	readonly objectiveId: string;
	readonly goalId?: string;
	readonly subgraphOf?: PlanSubgraphOf;
	readonly title: string;
	/** Topologically sorted by code at acceptance. */
	readonly nodes: readonly PlanNodeSpec[];
	/** Requirement ids no node covers; the root keeps them. */
	readonly rootOwned: readonly string[];
	/** The node whose settlement settles the plan. */
	readonly final: string;
	readonly status: PlanStatus;
	/** Recorded on code facts alone because System One was unavailable. */
	readonly unjudged: boolean;
	readonly judgments: readonly PlanJudgmentRef[];
	readonly createdAt: string;
	readonly revisedAt: string;
}

/** A record written by a newer build: kept by identity, never refused, never executed by this build. */
export interface PlanFromNewerBuild {
	readonly v: number;
	readonly planId: string;
	readonly version: number;
	readonly unsupported: true;
}

export type StoredPlanRecord = PlanRecord | PlanFromNewerBuild;

export function isPlanFromNewerBuild(record: StoredPlanRecord | undefined): record is PlanFromNewerBuild {
	return record !== undefined && "unsupported" in record;
}

/** The binding of a node's spec version to the orchestration task that runs it. */
export interface PlanNodeRelease {
	readonly version: number;
	readonly taskId: string;
	readonly placement: Placement;
	/** The placement exit that fired (code), for the trace. */
	readonly exit: string;
	readonly releasedAt: string;
}

export interface PlanNodeSettlement {
	readonly outcomeId: string;
	readonly generation: number;
	readonly settledAt: string;
}

export interface PlanNodeHold {
	readonly reason: PlanHoldReason;
	readonly detail: string;
	readonly generation: number;
	readonly heldAt: string;
}

export interface PlanJoinSettlement {
	readonly outcome: StoredOutcome;
	/** `plan/<planId>/<nodeId>.json` under the session bundle. */
	readonly artifact: string;
	readonly n: number;
	readonly settledAt: string;
}

/** Durable per-node facts the runtime cannot express on its own; the node's state is derived from them. */
export interface PlanNodeRuntime {
	readonly since: number;
	readonly release?: PlanNodeRelease;
	readonly settled?: PlanNodeSettlement;
	readonly held?: PlanNodeHold;
	readonly join?: PlanJoinSettlement;
}

/** A task released for a spec the plan no longer runs; kept so its terminal still routes to the executor. */
export interface PlanRetiredTask {
	readonly nodeId: string;
	readonly taskId: string;
	readonly reason: "superseded" | "removed" | "cancelled";
}

export interface PlanClosure {
	readonly status: PlanCloseStatus;
	readonly reason: string;
	readonly closedAt: string;
}

export interface PlanRuntimeState {
	readonly record: StoredPlanRecord;
	readonly nodes: Readonly<Record<string, PlanNodeRuntime>>;
	readonly retired: readonly PlanRetiredTask[];
	readonly closed?: PlanClosure;
}

export type PlanNodeState =
	| "planned"
	| "ready"
	| "admitted"
	| "running"
	| "settled"
	| "held"
	| "superseded"
	| "cancelled";

/** Deterministic plan identity: a replayed tool call rebuilds the same plan and its record replays inertly. */
export function derivePlanId(sessionId: string, toolCallId: string): string {
	return `pl-${createHash("sha256").update(sessionId).update("\0").update(toolCallId).digest("hex").slice(0, 8)}`;
}

export function planNodeEdges(node: Pick<PlanNodeSpec, "inputs" | "after">): readonly string[] {
	return [...new Set([...node.inputs, ...node.after])];
}

export function isJoinNode(node: Pick<PlanNodeSpec, "kind">): boolean {
	return node.kind !== "work";
}

export function planRecordBytes(record: PlanRecord): number {
	return Buffer.byteLength(JSON.stringify(record), "utf8");
}

export type PlanOrder =
	| { readonly acyclic: true; readonly order: readonly string[]; readonly levels: ReadonlyMap<string, number> }
	| { readonly acyclic: false; readonly cycle: readonly string[] };

/**
 * Kahn's sort over `inputs` and `after`, stable in the given order. `levels` is each node's longest-path layer from a
 * source (0-based), which bounds both depth and the width of one ready layer. Edges to unknown ids are ignored here;
 * F1 refuses them.
 */
export function planTopologicalOrder(nodes: readonly Pick<PlanNodeSpec, "id" | "inputs" | "after">[]): PlanOrder {
	const known = new Set(nodes.map((node) => node.id));
	const indegree = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const node of nodes) {
		const edges = planNodeEdges(node).filter((id) => known.has(id) && id !== node.id);
		indegree.set(node.id, edges.length + (planNodeEdges(node).includes(node.id) ? 1 : 0));
		for (const edge of edges) dependents.set(edge, [...(dependents.get(edge) ?? []), node.id]);
	}
	const levels = new Map<string, number>();
	const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
	for (const id of queue) levels.set(id, 0);
	const order: string[] = [];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		order.push(id);
		for (const dependent of dependents.get(id) ?? []) {
			levels.set(dependent, Math.max(levels.get(dependent) ?? 0, (levels.get(id) ?? 0) + 1));
			const remaining = (indegree.get(dependent) ?? 0) - 1;
			indegree.set(dependent, remaining);
			if (remaining === 0) queue.push(dependent);
		}
	}
	if (order.length === nodes.length) return { acyclic: true, order, levels };
	const placed = new Set(order);
	return { acyclic: false, cycle: nodes.filter((node) => !placed.has(node.id)).map((node) => node.id) };
}

/** True when a path leads from `from` to `to` over the nodes' edges. */
export function planPathExists(
	nodes: readonly Pick<PlanNodeSpec, "id" | "inputs" | "after">[],
	from: string,
	to: string,
): boolean {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const seen = new Set<string>();
	const stack = [to];
	while (stack.length > 0) {
		const id = stack.pop() as string;
		if (id === from) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		const node = byId.get(id);
		if (node) stack.push(...planNodeEdges(node));
	}
	return false;
}

/**
 * Normalizes one write scope to the repository-relative form X-31 fixes (forward slashes, no leading `./`, no
 * trailing `/`), or returns undefined when it leaves the repository or is not a relative path.
 */
export function normalizePlanWriteScope(scope: string, maxChars: number): string | undefined {
	const trimmed = scope.trim();
	if (trimmed.length === 0 || trimmed.length > maxChars) return undefined;
	if (trimmed.includes("\\") || trimmed.includes("\0")) return undefined;
	if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith("~")) return undefined;
	const segments = trimmed.split("/").filter((segment) => segment.length > 0 && segment !== ".");
	if (segments.length === 0 || segments.includes("..")) return undefined;
	return segments.join("/");
}

export type PlanFact = "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7";

export interface PlanFactProblem {
	readonly fact: PlanFact;
	readonly nodeId?: string;
	/** One plain-words fix. */
	readonly fix: string;
}

export interface PlanFactContext {
	/** The version the checked nodes will be recorded at. */
	readonly version: number;
	/** Requirement ids of the active goal; undefined when the plan has no goal. */
	readonly requirementIds?: readonly string[];
	/** Requirement ids of the active goal that are still open. */
	readonly openRequirementIds?: readonly string[];
	/** Remaining projection slots (`getProjectionCapacity().headroom`). */
	readonly headroom: { readonly tasks: number; readonly attempts: number };
	/** Tasks already released by earlier versions of this plan; they do not need new slots. */
	readonly releasedTasks?: number;
	readonly maxScopeChars: number;
}

export interface PlanFactsAccepted {
	readonly ok: true;
	/** The nodes in topological order. */
	readonly nodes: readonly PlanNodeSpec[];
	readonly rootOwned: readonly string[];
	readonly depth: number;
	readonly width: number;
}

export type PlanFactsResult = PlanFactsAccepted | { readonly ok: false; readonly problems: readonly PlanFactProblem[] };

function checkIds(nodes: readonly PlanNodeSpec[], final: string, problems: PlanFactProblem[]): void {
	const seen = new Set<string>();
	for (const node of nodes) {
		if (node.id.length > PLAN_LIMITS.idChars || !PLAN_NODE_ID_PATTERN.test(node.id)) {
			problems.push({ fact: "F1", nodeId: node.id, fix: `rename step "${node.id}" to letters, digits, . _ or -` });
		}
		if (seen.has(node.id)) problems.push({ fact: "F1", nodeId: node.id, fix: `use step id "${node.id}" once` });
		seen.add(node.id);
	}
	for (const node of nodes) {
		for (const ref of [...node.inputs, ...node.after, ...(node.join?.members ?? [])]) {
			if (!seen.has(ref))
				problems.push({ fact: "F1", nodeId: node.id, fix: `step "${node.id}" names unknown step "${ref}"` });
		}
	}
	if (!seen.has(final)) problems.push({ fact: "F1", fix: `final names unknown step "${final}"` });
}

function checkNodeBounds(node: PlanNodeSpec, problems: PlanFactProblem[]): void {
	const over = (what: string, limit: number) =>
		problems.push({ fact: "F3", nodeId: node.id, fix: `step "${node.id}": keep ${what} within ${limit}` });
	if (node.intent.trim().length === 0)
		problems.push({ fact: "F3", nodeId: node.id, fix: `step "${node.id}": say what it does` });
	if (node.intent.length > PLAN_LIMITS.intentChars) over("do", PLAN_LIMITS.intentChars);
	if (node.writeScope.length > PLAN_LIMITS.writeScopeEntries) over("files", PLAN_LIMITS.writeScopeEntries);
	if (node.inputs.length > PLAN_LIMITS.edgeEntries) over("uses", PLAN_LIMITS.edgeEntries);
	if (node.after.length > PLAN_LIMITS.edgeEntries) over("after", PLAN_LIMITS.edgeEntries);
	if (node.requirementIds.length > PLAN_LIMITS.requirementEntries) over("req", PLAN_LIMITS.requirementEntries);
	if ((node.join?.criterion?.length ?? 0) > PLAN_LIMITS.criterionChars) over("question", PLAN_LIMITS.criterionChars);
}

function checkJoinShape(node: PlanNodeSpec, problems: PlanFactProblem[]): void {
	const join = node.join;
	if (node.kind === "work") {
		if (join) problems.push({ fact: "F4", nodeId: node.id, fix: `step "${node.id}" is plain work; drop its join` });
		return;
	}
	if (node.kind === "merge") {
		problems.push({
			fact: "F4",
			nodeId: node.id,
			fix: `step "${node.id}": merge joins are not available yet; use collect`,
		});
		return;
	}
	if (!join) {
		problems.push({
			fact: "F4",
			nodeId: node.id,
			fix: `step "${node.id}" (${node.kind}) needs the steps it combines in uses`,
		});
		return;
	}
	const count = join.members.length;
	// A verify join checks one subject or several; every other join combines at least two.
	const minimum = node.kind === "verify" ? 1 : PLAN_LIMITS.joinMembersMin;
	if (count < minimum || count > PLAN_LIMITS.joinMembersMax) {
		problems.push({
			fact: "F4",
			nodeId: node.id,
			fix: `step "${node.id}" combines ${count} steps; a ${node.kind} combines ${minimum} to ${PLAN_LIMITS.joinMembersMax}`,
		});
	}
	const predecessors = new Set(planNodeEdges(node));
	for (const member of join.members) {
		if (!predecessors.has(member)) {
			problems.push({
				fact: "F4",
				nodeId: node.id,
				fix: `step "${node.id}" must list "${member}" in uses to combine it`,
			});
		}
	}
	if (join.quorum !== undefined && (!Number.isSafeInteger(join.quorum) || join.quorum < 1 || join.quorum > count)) {
		problems.push({ fact: "F4", nodeId: node.id, fix: `step "${node.id}": quorum must be between 1 and ${count}` });
	}
	if (node.kind === "vote" && !join.criterion) {
		problems.push({
			fact: "F4",
			nodeId: node.id,
			fix: `step "${node.id}": a vote needs the question the winner must meet`,
		});
	}
}

function checkScopes(node: PlanNodeSpec, maxChars: number, problems: PlanFactProblem[]): void {
	for (const scope of node.writeScope) {
		if (normalizePlanWriteScope(scope, maxChars) !== scope) {
			problems.push({
				fact: "F5",
				nodeId: node.id,
				fix: `step "${node.id}": give "${scope}" as a path inside the repository`,
			});
		}
	}
}

function requiredSlots(nodes: readonly PlanNodeSpec[]): number {
	return nodes.length + nodes.filter((node) => node.kind === "verify").length;
}

/**
 * Checks code facts F1-F7 over one plan version's nodes. Every failed refusing fact is listed at once; nothing is
 * recorded on a refusal. F7 refuses an unknown requirement id and moves open requirements no node cites to the root.
 */
export function checkPlanFacts(
	title: string,
	nodes: readonly PlanNodeSpec[],
	final: string,
	context: PlanFactContext,
): PlanFactsResult {
	const problems: PlanFactProblem[] = [];
	checkIds(nodes, final, problems);
	if (title.trim().length === 0 || title.length > PLAN_LIMITS.titleChars) {
		problems.push({ fact: "F3", fix: `give the plan a title of 1 to ${PLAN_LIMITS.titleChars} characters` });
	}
	if (nodes.length === 0 || nodes.length > PLAN_LIMITS.nodes) {
		problems.push({ fact: "F3", fix: `a plan has 1 to ${PLAN_LIMITS.nodes} steps` });
	}
	if (context.version > PLAN_LIMITS.versions) {
		problems.push({ fact: "F3", fix: `this plan reached ${PLAN_LIMITS.versions} revisions; start a new plan` });
	}
	for (const node of nodes) {
		checkNodeBounds(node, problems);
		checkJoinShape(node, problems);
		checkScopes(node, context.maxScopeChars, problems);
	}
	const order = planTopologicalOrder(nodes);
	let depth = 0;
	let width = 0;
	if (!order.acyclic) {
		problems.push({
			fact: "F2",
			fix: `steps ${order.cycle.join(", ")} wait on each other in a loop; break the loop`,
		});
	} else {
		const perLevel = new Map<number, number>();
		for (const level of order.levels.values()) perLevel.set(level, (perLevel.get(level) ?? 0) + 1);
		depth = perLevel.size;
		width = Math.max(0, ...perLevel.values());
		if (depth > PLAN_LIMITS.depth) {
			problems.push({ fact: "F3", fix: `the plan is ${depth} steps deep; keep chains within ${PLAN_LIMITS.depth}` });
		}
		if (width > PLAN_LIMITS.layerWidth) {
			problems.push({
				fact: "F3",
				fix: `${width} steps start together; keep one layer within ${PLAN_LIMITS.layerWidth}`,
			});
		}
	}
	const needed = Math.max(0, requiredSlots(nodes) - (context.releasedTasks ?? 0));
	if (context.headroom.tasks < needed || context.headroom.attempts < needed * 2) {
		problems.push({
			fact: "F6",
			fix: `this session has room for ${Math.max(0, context.headroom.tasks)} more tasks; the plan needs ${needed}; split it or finish open work first`,
		});
	}
	const known = context.requirementIds === undefined ? undefined : new Set(context.requirementIds);
	const cited = new Set<string>();
	for (const node of nodes) {
		for (const requirementId of node.requirementIds) {
			cited.add(requirementId);
			if (known && !known.has(requirementId)) {
				problems.push({
					fact: "F7",
					nodeId: node.id,
					fix: `step "${node.id}" cites unknown requirement "${requirementId}"`,
				});
			}
			if (!known) {
				problems.push({
					fact: "F7",
					nodeId: node.id,
					fix: `step "${node.id}" cites "${requirementId}" but no goal is active`,
				});
			}
		}
	}
	if (problems.length > 0 || !order.acyclic) return { ok: false, problems };
	const byId = new Map(nodes.map((node) => [node.id, node]));
	return {
		ok: true,
		nodes: order.order.map((id) => byId.get(id) as PlanNodeSpec),
		rootOwned: (context.openRequirementIds ?? []).filter((requirementId) => !cited.has(requirementId)),
		depth,
		width,
	};
}

/** Pairs of nodes that can run at the same time: no path leads from one to the other. */
export function concurrentPlanPairs(
	nodes: readonly PlanNodeSpec[],
): readonly (readonly [PlanNodeSpec, PlanNodeSpec])[] {
	const pairs: (readonly [PlanNodeSpec, PlanNodeSpec])[] = [];
	for (let first = 0; first < nodes.length; first += 1) {
		for (let second = first + 1; second < nodes.length; second += 1) {
			const a = nodes[first] as PlanNodeSpec;
			const b = nodes[second] as PlanNodeSpec;
			if (!planPathExists(nodes, a.id, b.id) && !planPathExists(nodes, b.id, a.id)) pairs.push([a, b]);
		}
	}
	return pairs;
}

/** The plan's effective status: a closure wins over the recorded status. */
export function effectivePlanStatus(plan: PlanRuntimeState): PlanStatus | "unsupported" {
	if (isPlanFromNewerBuild(plan.record)) return "unsupported";
	return plan.closed?.status ?? plan.record.status;
}

/**
 * F10: edges the goal's own requirement dependencies imply. When node B cites a requirement that depends on a
 * requirement node A cites, B runs after A; the edge is added by code and stated in the tool result. A resulting cycle
 * is refused by F2.
 */
export function goalDependencyEdges(
	nodes: readonly PlanNodeSpec[],
	requirements: readonly { readonly id: string; readonly dependencies?: readonly string[] }[],
): readonly { readonly earlier: string; readonly later: string }[] {
	const dependenciesOf = new Map(requirements.map((requirement) => [requirement.id, requirement.dependencies ?? []]));
	const edges: { earlier: string; later: string }[] = [];
	for (const later of nodes) {
		const needed = new Set(later.requirementIds.flatMap((id) => dependenciesOf.get(id) ?? []));
		for (const earlier of nodes) {
			if (earlier.id === later.id || planNodeEdges(later).includes(earlier.id)) continue;
			if (earlier.requirementIds.some((id) => needed.has(id) && !later.requirementIds.includes(id))) {
				edges.push({ earlier: earlier.id, later: later.id });
			}
		}
	}
	return edges;
}
