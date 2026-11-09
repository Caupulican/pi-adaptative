/**
 * Bounded, exhaustive exploration of a model. `exploreGraph` runs a breadth-first search over the reachable nodes, where a
 * node is a state with the crash and drop counts its path has used, and it records every edge, including self-loops and
 * edges into nodes already seen, so that later checks (liveness, projection) can read the whole graph. `summarizeModel`
 * checks invariants and deadlocks over that graph; `tracePath` returns the path to any node. Order is fixed: initial states
 * in order, then actions in declaration order with their successors in returned order, then crash entries in declaration
 * order. One model therefore always yields one graph and one report.
 *
 * A search that reaches `bounds.maxStates` stops with `exhausted: false`, which is a failure, never a pass. A node the stop
 * prevented from expanding is never reported as a deadlock. A deadlock is a reachable state, not marked terminal, with no
 * successor from a step action; crash and lossy steps are environment moves and do not count as progress.
 *
 * Counterexample format: `init#<i>` followed by the edge labels from that initial state, where `<i>` is its position in
 * `init` and a crash edge is labelled `crash(<actor>)`. Breaches and deadlocks both use this format.
 */

import type { ModelBreach, ModelEdge, ModelGraph, ModelNode, ModelReport, ModelSpec } from "./machine-model.ts";
import { crash, crashLabel, defineModel, encodeState } from "./machine-model.ts";

/** A node while `exploreGraph` builds it. The same shape as `ModelNode`, with the edge list still growing. */
interface DraftNode<V> {
	index: number;
	state: V;
	key: string;
	init: number;
	depth: number;
	via: ModelNode<V>["via"];
	crashes: number;
	drops: number;
	expanded: boolean;
	edges: ModelEdge[];
}

/** `apply` returns one state or a list of them. A state is a plain object, so an array is always a list. */
function successorsOf<V>(result: V | readonly V[]): readonly V[] {
	return Array.isArray(result) ? result : [result as V];
}

/** Builds the reachable graph of a model. Returns with `exhausted: false` as soon as `bounds.maxStates` would be exceeded. */
export function exploreGraph<V>(spec: ModelSpec<V>): ModelGraph<V> {
	defineModel(spec);
	const { maxStates, maxCrashes, maxDrops } = spec.bounds;
	const nodes: DraftNode<V>[] = [];
	const indexOf = new Map<string, number>();

	// The node for this state and budget, created when it is new. Undefined when creating it would pass `maxStates`.
	const admit = (
		state: V,
		crashes: number,
		drops: number,
		init: number,
		via?: { readonly parent: number; readonly action: string },
	): number | undefined => {
		const key = encodeState(state);
		const id = `${crashes},${drops}|${key}`;
		const known = indexOf.get(id);
		if (known !== undefined) return known;
		if (nodes.length >= maxStates) return undefined;
		const index = nodes.length;
		const depth = via === undefined ? 0 : nodes[via.parent].depth + 1;
		nodes.push({ index, state, key, init, depth, via, crashes, drops, expanded: false, edges: [] });
		indexOf.set(id, index);
		return index;
	};

	// Generates every successor of one node in the fixed order. Returns false when the bound stopped the search.
	const expand = (index: number): boolean => {
		const node = nodes[index];
		const { state } = node;
		for (const action of spec.actions) {
			if (!action.guard(state)) continue;
			const lossy = action.lossy === true;
			if (lossy && node.drops >= maxDrops) continue;
			const drops = node.drops + (lossy ? 1 : 0);
			for (const next of successorsOf(action.apply(state))) {
				const to = admit(next, node.crashes, drops, node.init, { parent: index, action: action.name });
				if (to === undefined) return false;
				node.edges.push({ action: action.name, kind: lossy ? "loss" : "step", to });
			}
		}
		if (node.crashes < maxCrashes) {
			for (const entry of spec.crashes ?? []) {
				const label = crashLabel(entry.actor);
				const next = crash(spec, entry.actor, state);
				const to = admit(next, node.crashes + 1, node.drops, node.init, { parent: index, action: label });
				if (to === undefined) return false;
				node.edges.push({ action: label, kind: "crash", to });
			}
		}
		if (encodeState(state) !== node.key) {
			throw new Error(`model "${spec.name}": an action changed a state it was given; apply must return a new state`);
		}
		node.expanded = true;
		return true;
	};

	for (const [init, state] of spec.init.entries()) {
		if (admit(state, 0, 0, init) === undefined) return { nodes, exhausted: false };
	}
	for (let head = 0; head < nodes.length; head++) {
		if (!expand(head)) return { nodes, exhausted: false };
	}
	return { nodes, exhausted: true };
}

/** The counterexample path to `index`: the initial state's position, then each edge label on the BFS tree down to it. */
export function tracePath<V>(graph: ModelGraph<V>, index: number): string[] {
	const steps: string[] = [];
	let node = graph.nodes[index];
	while (node.via !== undefined) {
		steps.push(node.via.action);
		node = graph.nodes[node.via.parent];
	}
	steps.reverse();
	return [`init#${node.init}`, ...steps];
}

/**
 * Checks every invariant and deadlock over an explored graph. Nodes are visited in discovery order, so the first breach of
 * an invariant, and the first deadlock of a state, are the shortest ones.
 */
export function summarizeModel<V>(spec: ModelSpec<V>, graph: ModelGraph<V>): ModelReport {
	const broken: ModelBreach[] = [];
	const breached = new Set<string>();
	const deadlocks: (readonly string[])[] = [];
	const deadlocked = new Set<string>();
	const fired = new Set<string>();
	for (const node of graph.nodes) {
		for (const invariant of spec.invariants) {
			if (breached.has(invariant.name) || invariant.holds(node.state)) continue;
			breached.add(invariant.name);
			broken.push({ invariant: invariant.name, path: tracePath(graph, node.index) });
		}
		for (const edge of node.edges) fired.add(edge.action);
		const hasStep = node.edges.some((edge) => edge.kind === "step");
		const stuck = node.expanded && !hasStep && spec.terminal?.(node.state) !== true;
		if (stuck && !deadlocked.has(node.key)) {
			deadlocked.add(node.key);
			deadlocks.push(tracePath(graph, node.index));
		}
	}
	return {
		states: graph.nodes.length,
		exhausted: graph.exhausted,
		broken,
		deadlocks,
		fired: [...fired].sort(),
	};
}

/** Explores a model and summarizes it. Callers that need the graph too call `exploreGraph` once and `summarizeModel` on it. */
export function exploreModel<V>(spec: ModelSpec<V>): ModelReport {
	return summarizeModel(spec, exploreGraph(spec));
}
