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
	taskBriefVersionFor,
} from "../comms/comms-records.ts";
import type { PlacementPin } from "../placement/placement-types.ts";
import type { PlanToolInput, PlanToolStep } from "./plan-executor-port.ts";
import {
	concurrentPlanPairs,
	landStepOf,
	normalizePlanWriteScope,
	PLAN_LIMITS,
	type PlanNodeSpec,
	type PlanRecord,
	type PlanRuntimeState,
	planNodeEdges,
	planTopologicalOrder,
	writeScopesOverlap,
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

/**
 * A step's `proof` as the brief fields it sets: `cite`, `cmd` or `diff` name the evidence; `check:<command>` names a
 * command whose exit code 0 proves the step. Undefined for a value the grammar does not allow.
 */
export function proofFields(
	proof: string,
): { readonly evid: "cite" | "cmd" | "diff"; readonly note?: string } | undefined {
	const value = proof.trim();
	if (value === "cite" || value === "cmd" || value === "diff") return { evid: value };
	if (!value.startsWith("check:")) return undefined;
	const command = value.slice("check:".length).trim();
	if (command.length === 0 || /[\r\n]/.test(command)) return undefined;
	return { evid: "cmd", note: `Proof: run ${command}; exit code 0 proves the step.` };
}

const QUESTION_JOINS: ReadonlySet<string> = new Set(["reduce", "verify", "vote"]);

/**
 * The refusals a step's own fields earn before it is built: a proof outside the grammar (it would otherwise be dropped),
 * a join-only field on a step whose join does not read it (`question` belongs to reduce, verify or vote; `criteria` to
 * vote), and a `need` on a step that is no collect join, which nothing would settle by.
 */
export function stepShapeProblems(steps: readonly PlanToolStep[]): string[] {
	return steps.flatMap((step) => {
		const problems: string[] = [];
		const stated = step.join === undefined ? "plain work" : `a ${step.join} join`;
		if (step.proof !== undefined && proofFields(step.proof) === undefined) {
			problems.push(
				`step "${step.id}": proof is cite, cmd, diff, or check:<command> (a command whose exit code 0 proves the step)`,
			);
		}
		if (step.question !== undefined && (step.join === undefined || !QUESTION_JOINS.has(step.join))) {
			problems.push(`step "${step.id}" is ${stated}; question belongs to a reduce, verify, or vote step`);
		}
		if (step.criteria !== undefined && step.join !== "vote") {
			problems.push(`step "${step.id}" is ${stated}; criteria belong to a vote step`);
		}
		if (step.need !== undefined && step.join !== "collect") {
			problems.push(`step "${step.id}" is ${stated}; need belongs to a collect step`);
		}
		return problems;
	});
}

/** The step's acceptance fields and proof as a brief whose goal is the step's intent, or undefined when it states neither. */
function stepBrief(step: PlanToolStep): TaskBrief | undefined {
	const done = step.doneWhen ? briefLine(step.doneWhen, MAX_TASK_DONE_CHARS) : "";
	const outOfScope = (step.outOfScope ?? [])
		.map((item) => briefLine(item, MAX_TASK_OUT_OF_SCOPE_CHARS))
		.filter((item) => item.length > 0)
		.slice(0, MAX_TASK_OUT_OF_SCOPE);
	const proof = step.proof === undefined ? undefined : proofFields(step.proof);
	if (!done && outOfScope.length === 0 && !proof) return undefined;
	return {
		v: taskBriefVersionFor({ ...(done ? { done } : {}), ...(outOfScope.length > 0 ? { outOfScope } : {}) }),
		goal: briefLine(step.do, MAX_TASK_GOAL_CHARS),
		...(proof ? { evid: proof.evid } : {}),
		...(proof?.note ? { note: proof.note } : {}),
		...(done ? { done } : {}),
		...(outOfScope.length > 0 ? { outOfScope } : {}),
	};
}

/** One tool step as a node spec stated at `version`. A path that normalizes is kept normalized; F5 refuses the rest. */
export function nodeFromStep(step: PlanToolStep, version: number): PlanNodeSpec {
	const kind = step.join ?? "work";
	const inputs = [...new Set(step.uses ?? [])];
	const brief = stepBrief(step);
	const criteria = (step.criteria ?? []).map((criterion) => criterion.trim());
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
			? {
					join: {
						members: inputs,
						// The step's `need` is the join's quorum: how many of the members must succeed for it to settle.
						...(kind === "collect" && step.need !== undefined ? { quorum: step.need } : {}),
						...(step.question ? { criterion: step.question.trim() } : {}),
						...(criteria.length > 0 ? { criteria } : {}),
					},
				}
			: {}),
		since: version,
	};
}

/** The default final step: the last join in the given order, else the last step. */
export function defaultFinal(nodes: readonly Pick<PlanNodeSpec, "id" | "kind">[]): string | undefined {
	return [...nodes].reverse().find((node) => node.kind !== "work")?.id ?? nodes[nodes.length - 1]?.id;
}

/** The node's spec as a restart compares it: doubts are display data, so a doubt never restarts a step. */
function specKey(node: PlanNodeSpec): string {
	const { since: _since, doubts: _doubts, ...spec } = node;
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
	// A removed merge takes the land steps it made with it: left behind, one would run as an ordinary step in the shared checkout.
	for (const node of record.nodes) {
		if (node.kind !== "merge" || !removed.has(node.id)) continue;
		for (const member of node.join?.members ?? []) {
			const land = landStepOf(record, node.id, member);
			if (land) removed.add(land.id);
		}
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
 * (and as the final step when it was), a merge that lands `nodeId` waits for it instead. Undefined when the plan has no room
 * for another step.
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
	const nodes = [...record.nodes.map((node) => wrapDependent(node, nodeId, id)), verify];
	return { nodes, final: record.final === nodeId ? id : record.final };
}

/**
 * A dependent of a wrapped step now waits for its check instead of reading the step. A merge is the exception: it lands the
 * step's own lane, so the step stays its member and the check is ordered before the merge.
 */
function wrapDependent(node: PlanNodeSpec, nodeId: string, checkId: string): PlanNodeSpec {
	if (node.kind === "merge" && node.join?.members.includes(nodeId))
		return { ...node, after: [...new Set([...node.after, checkId])] };
	return replaceEdge(node, nodeId, [checkId]);
}

/** A vote's criteria: the rubric every candidate is judged on, or the one question it names when it states none. */
export function voteCriteria(vote: PlanNodeSpec): readonly string[] {
	const criteria = vote.join?.criteria ?? [];
	return criteria.length > 0 ? criteria : [vote.join?.criterion ?? vote.intent];
}

/**
 * The auto-verify checks a vote has added (S6): verify steps that check one of its members and are ordered before it. The
 * record alone says whether a vote was checked already, so no flag is stored.
 */
export function voteChecksOf(
	record: PlanRecord,
	vote: PlanNodeSpec,
): readonly { readonly id: string; readonly memberId: string }[] {
	const members = new Set(vote.join?.members ?? []);
	return record.nodes.flatMap((node) => {
		const [member] = node.inputs;
		if (
			node.kind !== "verify" ||
			member === undefined ||
			node.inputs.length !== 1 ||
			!vote.after.includes(node.id) ||
			!members.has(member) ||
			node.join?.members.length !== 1 ||
			node.join.members[0] !== member
		)
			return [];
		return [{ id: node.id, memberId: member }];
	});
}

/**
 * Host revision for an unsettled vote (S6, D10): an independent verify step for each of the two `top` candidates, ordered
 * before the vote, so the vote re-decides from their verdicts. Undefined when the plan has no room for two more steps or for
 * another version, the vote was checked already, or a named candidate is not one of its members.
 */
export function voteCheckNodes(
	record: PlanRecord,
	voteId: string,
	top: readonly [string, string],
	version: number,
): { readonly nodes: PlanNodeSpec[] } | undefined {
	const vote = record.nodes.find((node) => node.id === voteId);
	if (vote?.kind !== "vote" || record.nodes.length + top.length > PLAN_LIMITS.nodes || version > PLAN_LIMITS.versions)
		return undefined;
	if (voteChecksOf(record, vote).length > 0) return undefined;
	const members = new Set(vote.join?.members ?? []);
	if (!top.every((id) => members.has(id))) return undefined;
	const taken = new Set(record.nodes.map((node) => node.id));
	const criteria = voteCriteria(vote).join("; ");
	const checks: PlanNodeSpec[] = [];
	for (const candidate of top) {
		const id = freshId(`${voteId}-check-${candidate}`, taken);
		if (id === undefined) return undefined;
		taken.add(id);
		checks.push({
			id,
			kind: "verify",
			intent: `Independently verify step ${candidate} against: ${criteria}`.slice(0, PLAN_LIMITS.intentChars),
			inputs: [candidate],
			after: [],
			writeScope: [],
			requirementIds: [...vote.requirementIds],
			effort: "normal",
			join: { members: [candidate] },
			since: version,
		});
	}
	const nodes = record.nodes.map((node) =>
		node.id === voteId ? { ...node, after: [...new Set([...node.after, ...checks.map((check) => check.id)])] } : node,
	);
	return { nodes: [...nodes, ...checks] };
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

function mentions(node: PlanNodeSpec, other: PlanNodeSpec): boolean {
	return node.intent.includes(other.id) || other.writeScope.some((path) => node.intent.includes(path));
}

/**
 * Dependency candidates (not a refusal): pairs of plain steps that run at the same time and might depend on each other,
 * strongest first. A pair counts when their files overlap, one names the other or a file it changes, or the earlier one
 * changes files. `focus` keeps only pairs touching those ids (a revise asks only about what it changed).
 */
export function dependencyCandidates(
	nodes: readonly PlanNodeSpec[],
	focus?: ReadonlySet<string>,
): { readonly earlier: PlanNodeSpec; readonly later: PlanNodeSpec }[] {
	const scored: { earlier: PlanNodeSpec; later: PlanNodeSpec; score: number }[] = [];
	// Paths are read over the whole plan: two plain steps ordered through a join (a step, its verify step, the step after
	// it) are not concurrent, and asking about them could add an edge that bypasses the join between them.
	for (const [a, b] of concurrentPlanPairs(nodes)) {
		if (a.kind !== "work" || b.kind !== "work") continue;
		if (focus && !focus.has(a.id) && !focus.has(b.id)) continue;
		const overlap = writeScopesOverlap(a.writeScope, b.writeScope) !== undefined ? 3 : 0;
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
