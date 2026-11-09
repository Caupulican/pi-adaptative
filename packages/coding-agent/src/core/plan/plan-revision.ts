/**
 * How one plan version's nodes are built: from the `plan` tool's steps (start), from a revise's delta (steps added or
 * replaced by id, ids removed), and from the executor's own host revisions (a verify step wrapped around an outcome
 * that asks for independent verification, a step restated pinned to this machine after its linked machine could not run
 * it). Pure code; the caller checks the facts and records the version.
 *
 * Every builder ends in `resolveSince`: a node whose spec is unchanged keeps the version that last stated it (and with
 * it its running or settled work); a changed node, a node that newly depends on a restarted one, and on a root revise a
 * held node, are stated at the new version and start afresh.
 */

import {
	MAX_TASK_DONE_CHARS,
	MAX_TASK_GOAL_CHARS,
	MAX_TASK_OUT_OF_SCOPE,
	MAX_TASK_OUT_OF_SCOPE_CHARS,
	type TaskBrief,
} from "../comms/comms-records.ts";
import type { PlacementPin } from "../placement/placement-types.ts";
import type { PlanToolInput, PlanToolStep } from "./plan-executor-port.ts";
import {
	concurrentPlanPairs,
	normalizePlanWriteScope,
	PLAN_LIMITS,
	type PlanNodeSpec,
	type PlanRecord,
	type PlanRuntimeState,
	planNodeEdges,
	planTopologicalOrder,
} from "./plan-graph.ts";

/** A step's `by`: `machine:<id>` names a machine, `here` this machine, anything else a bot; always a preference. */
export function pinFromBy(by: string): PlacementPin {
	const value = by.trim();
	if (value === "here") return { target: "here", mode: "prefer" };
	if (value.startsWith("machine:")) return { target: { machineId: value.slice("machine:".length) }, mode: "prefer" };
	return { target: { botId: value }, mode: "prefer" };
}

/** Text as one canonical brief line inside `max` characters: whitespace runs collapse, an overlong line is cut. */
export function briefLine(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= max ? line : `${line.slice(0, max - 3)}...`;
}

/** The step's acceptance fields as a brief whose goal is the step's intent, or undefined when the step states neither. */
function stepBrief(step: PlanToolStep): TaskBrief | undefined {
	const done = step.doneWhen ? briefLine(step.doneWhen, MAX_TASK_DONE_CHARS) : "";
	const outOfScope = (step.outOfScope ?? [])
		.map((item) => briefLine(item, MAX_TASK_OUT_OF_SCOPE_CHARS))
		.filter((item) => item.length > 0)
		.slice(0, MAX_TASK_OUT_OF_SCOPE);
	if (!done && outOfScope.length === 0) return undefined;
	return {
		v: 3,
		goal: briefLine(step.do, MAX_TASK_GOAL_CHARS),
		...(done ? { done } : {}),
		...(outOfScope.length > 0 ? { outOfScope } : {}),
	};
}

/** One tool step as a node spec stated at `version`. A path that normalizes is kept normalized; F5 refuses the rest. */
export function nodeFromStep(step: PlanToolStep, version: number): PlanNodeSpec {
	const kind = step.join ?? "work";
	const inputs = [...new Set(step.uses ?? [])];
	const brief = stepBrief(step);
	return {
		id: step.id,
		kind,
		intent: step.do.trim(),
		...(brief ? { brief } : {}),
		inputs,
		after: [...new Set(step.after ?? [])].filter((id) => !inputs.includes(id)),
		writeScope: (step.files ?? []).map((path) => normalizePlanWriteScope(path, PLAN_LIMITS.scopeChars) ?? path),
		requirementIds: [...new Set(step.req ?? [])],
		...(step.by ? { pin: pinFromBy(step.by) } : {}),
		effort: step.deep ? "deep" : "normal",
		...(kind !== "work"
			? { join: { members: inputs, ...(step.question ? { criterion: step.question.trim() } : {}) } }
			: {}),
		since: version,
	};
}

/** The default final step: the last join in the given order, else the last step. */
export function defaultFinal(nodes: readonly Pick<PlanNodeSpec, "id" | "kind">[]): string | undefined {
	return [...nodes].reverse().find((node) => node.kind !== "work")?.id ?? nodes[nodes.length - 1]?.id;
}

function specKey(node: PlanNodeSpec): string {
	const { since: _since, ...spec } = node;
	return JSON.stringify(spec);
}

/**
 * Sets each node's `since`: unchanged nodes keep their version; a changed or new node, every node downstream of a
 * restarted one, and (when `restartHeld`) a held node are stated at `version`.
 */
export function resolveSince(
	prior: PlanRecord | undefined,
	runtime: PlanRuntimeState | undefined,
	nodes: readonly PlanNodeSpec[],
	version: number,
	restartHeld: boolean,
): PlanNodeSpec[] {
	const priorById = new Map((prior?.nodes ?? []).map((node) => [node.id, node]));
	const restarted = new Set<string>();
	const resolved = new Map<string, PlanNodeSpec>();
	const order = planTopologicalOrder(nodes);
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const ids = order.acyclic ? order.order : nodes.map((node) => node.id);
	for (const id of ids) {
		const node = byId.get(id) as PlanNodeSpec;
		const before = priorById.get(id);
		const restart =
			!before ||
			specKey(node) !== specKey(before) ||
			(restartHeld && runtime?.nodes[id]?.held !== undefined) ||
			planNodeEdges(node).some((edge) => restarted.has(edge));
		if (restart) restarted.add(id);
		resolved.set(id, { ...node, since: restart ? version : before.since });
	}
	return nodes.map((node) => resolved.get(node.id) as PlanNodeSpec);
}

/** A revise's delta over the current record: unknown removals are reported, a replaced id keeps its place. */
export function revisedNodes(
	record: PlanRecord,
	input: PlanToolInput,
	version: number,
): { readonly nodes: PlanNodeSpec[]; readonly final: string | undefined; readonly problems: string[] } {
	const problems: string[] = [];
	const removed = new Set(input.remove ?? []);
	for (const id of removed) {
		if (!record.nodes.some((node) => node.id === id)) problems.push(`remove names unknown step "${id}"`);
	}
	const replacements = new Map((input.steps ?? []).map((step) => [step.id, nodeFromStep(step, version)]));
	const nodes = record.nodes.filter((node) => !removed.has(node.id)).map((node) => replacements.get(node.id) ?? node);
	for (const [id, node] of replacements) if (!record.nodes.some((existing) => existing.id === id)) nodes.push(node);
	const final = input.final ?? (removed.has(record.final) ? defaultFinal(nodes) : record.final);
	return { nodes, final, problems };
}

/** Adds `earlier` to `later`'s inputs (a data edge) or `after` (ordering only), once. */
export function withEdges(
	nodes: readonly PlanNodeSpec[],
	edges: readonly { readonly earlier: string; readonly later: string }[],
	kind: "inputs" | "after",
): PlanNodeSpec[] {
	return nodes.map((node) => {
		const added = edges
			.filter((edge) => edge.later === node.id && !planNodeEdges(node).includes(edge.earlier))
			.map((edge) => edge.earlier);
		if (added.length === 0) return node;
		return { ...node, [kind]: [...new Set([...node[kind], ...added])] };
	});
}

function freshId(base: string, taken: ReadonlySet<string>): string | undefined {
	for (let index = 0; index < 100; index += 1) {
		const suffix = index === 0 ? "" : `${index}`;
		const candidate = `${base.slice(0, PLAN_LIMITS.idChars - suffix.length)}${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
	return undefined;
}

function replaceEdge(node: PlanNodeSpec, from: string, to: readonly string[]): PlanNodeSpec {
	if (!planNodeEdges(node).includes(from)) return node;
	const swap = (ids: readonly string[]) => [...new Set(ids.flatMap((id) => (id === from ? to : [id])))];
	const inputs = swap(node.inputs);
	return {
		...node,
		inputs,
		after: swap(node.after).filter((id) => !inputs.includes(id)),
		...(node.join ? { join: { ...node.join, members: swap(node.join.members) } } : {}),
	};
}

/**
 * Host revision for `verify_independently`: a read-only verify step over `nodeId` takes its place for every dependent
 * (and as the final step when it was). Undefined when the plan has no room for another step.
 */
export function verifyWrapNodes(
	record: PlanRecord,
	nodeId: string,
	requirementIds: readonly string[],
	version: number,
): { readonly nodes: PlanNodeSpec[]; readonly final: string } | undefined {
	if (record.nodes.length >= PLAN_LIMITS.nodes || version > PLAN_LIMITS.versions) return undefined;
	const subject = record.nodes.find((node) => node.id === nodeId);
	const id = freshId(`${nodeId}-check`, new Set(record.nodes.map((node) => node.id)));
	if (!subject || !id) return undefined;
	const verify: PlanNodeSpec = {
		id,
		kind: "verify",
		intent: `Independently verify step ${nodeId}: ${subject.intent}`.slice(0, PLAN_LIMITS.intentChars),
		inputs: [nodeId],
		after: [],
		writeScope: [],
		requirementIds: [...new Set(requirementIds.length > 0 ? requirementIds : subject.requirementIds)],
		effort: subject.effort,
		join: { members: [nodeId] },
		since: version,
	};
	const nodes = [...record.nodes.map((node) => replaceEdge(node, nodeId, [id])), verify];
	return { nodes, final: record.final === nodeId ? id : record.final };
}

/**
 * Host revision for `replace`: the step is restated pinned to this machine (a must), so the plan starts it afresh here
 * (`resolveSince` gives it the new version, since its spec changed). Undefined when the step is missing or the plan has no
 * version left.
 */
export function placeHereNodes(
	record: PlanRecord,
	nodeId: string,
	version: number,
): { readonly nodes: PlanNodeSpec[]; readonly final: string } | undefined {
	if (version > PLAN_LIMITS.versions || !record.nodes.some((node) => node.id === nodeId)) return undefined;
	const pin: PlacementPin = { target: "here", mode: "must" };
	const nodes = record.nodes.map((node) => (node.id === nodeId ? { ...node, pin, since: version } : node));
	return { nodes, final: record.final };
}

/** Steps whose text is this short are asked whether they stand alone (J4). */
const THIN_INTENT_CHARS = 160;

function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
	return a.some((left) =>
		b.some((right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)),
	);
}

function mentions(node: PlanNodeSpec, other: PlanNodeSpec): boolean {
	return node.intent.includes(other.id) || other.writeScope.some((path) => node.intent.includes(path));
}

/**
 * F9: pairs of plain steps that run at the same time and might depend on each other, strongest first. A pair counts
 * when their files overlap, one names the other or a file it changes, or the earlier one changes files. `focus`
 * keeps only pairs touching those ids (a revise asks only about what it changed).
 */
export function dependencyCandidates(
	nodes: readonly PlanNodeSpec[],
	focus?: ReadonlySet<string>,
): { readonly earlier: PlanNodeSpec; readonly later: PlanNodeSpec }[] {
	const scored: { earlier: PlanNodeSpec; later: PlanNodeSpec; score: number }[] = [];
	const work = nodes.filter((node) => node.kind === "work");
	for (const [a, b] of concurrentPlanPairs(work)) {
		if (focus && !focus.has(a.id) && !focus.has(b.id)) continue;
		const overlap = scopesOverlap(a.writeScope, b.writeScope) ? 3 : 0;
		const forward = overlap + (mentions(b, a) ? 2 : 0) + (a.writeScope.length > 0 ? 1 : 0);
		const backward = overlap + (mentions(a, b) ? 2 : 0) + (b.writeScope.length > 0 ? 1 : 0);
		if (Math.max(forward, backward) === 0) continue;
		scored.push(
			forward >= backward ? { earlier: a, later: b, score: forward } : { earlier: b, later: a, score: backward },
		);
	}
	return scored.sort((x, y) => y.score - x.score).map(({ earlier, later }) => ({ earlier, later }));
}

/** J4 candidates: plain steps stated in few words, which may lean on context only the planner holds. */
export function thinSteps(nodes: readonly PlanNodeSpec[], focus?: ReadonlySet<string>): PlanNodeSpec[] {
	return nodes.filter(
		(node) => node.kind === "work" && node.intent.length < THIN_INTENT_CHARS && (!focus || focus.has(node.id)),
	);
}
