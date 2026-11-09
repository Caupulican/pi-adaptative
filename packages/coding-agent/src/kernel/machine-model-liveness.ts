/**
 * Liveness over an explored model graph, for the kernel model checker. A liveness property says that every fair run reaches its
 * goal. `checkLiveness` reports the ways a fair run can avoid the goal. A stall is a reachable state where the goal is unmet and no
 * fair action is enabled, so the run may stop there under weak fairness. A fair cycle is a non-trivial strongly connected set of
 * step edges inside the states that miss the goal, in which every fair action is either disabled in some state or taken on an edge
 * of the set. Crash and lossy edges consume a budget, so no cycle contains one: cycles are made of step edges only. Strong
 * components come from an iterative Tarjan pass, so a large graph cannot overflow the call stack. A breach carries the path format
 * of `tracePath`; the checking script merges these breaches with the invariant breaches of `summarizeModel`.
 */

import type { ModelAction, ModelGraph, ModelSpec } from "./machine-model.ts";
import { tracePath } from "./machine-model-explore.ts";

export interface LivenessBreach {
	readonly name: string;
	/** The path to the first state of the failing run, in the format of `tracePath`. */
	readonly path: readonly string[];
	/** The edge labels of the cycle that repeats forever, from the first state back to itself. Empty for a stall. */
	readonly cycle: readonly string[];
}

/** Whether `name` matches `pattern`, where `*` matches any run of characters and every other character stands for itself. */
function globMatches(pattern: string, name: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`).test(name);
}

/** The action names of the model that some pattern in `patterns` names, in declaration order. */
export function fairNamesOf<V>(spec: ModelSpec<V>, patterns: readonly string[]): string[] {
	return spec.actions
		.map((action) => action.name)
		.filter((name) => patterns.some((pattern) => globMatches(pattern, name)));
}

/** Every way a liveness property's fair list is malformed: no entry, or a pattern that names no action of the model. */
export function livenessShapeFailures<V>(spec: ModelSpec<V>): string[] {
	const failures: string[] = [];
	for (const property of spec.liveness ?? []) {
		if (property.fair.length === 0) failures.push(`liveness "${property.name}" has no fair action`);
		for (const pattern of property.fair) {
			if (fairNamesOf(spec, [pattern]).length === 0)
				failures.push(`liveness "${property.name}" names no action for the fair pattern "${pattern}"`);
		}
	}
	return failures;
}

/** Strong components of the graph whose edges are `successors`, in reverse topological order. Iterative, so depth is unbounded. */
function strongComponents(count: number, successors: readonly (readonly number[])[]): number[][] {
	const index = new Array<number>(count).fill(-1);
	const low = new Array<number>(count).fill(0);
	const onStack = new Array<boolean>(count).fill(false);
	const stack: number[] = [];
	const components: number[][] = [];
	let counter = 0;
	for (let root = 0; root < count; root++) {
		if (index[root] !== -1) continue;
		const work: { node: number; next: number }[] = [{ node: root, next: 0 }];
		index[root] = counter;
		low[root] = counter;
		counter++;
		stack.push(root);
		onStack[root] = true;
		while (work.length > 0) {
			const frame = work[work.length - 1];
			const out = successors[frame.node];
			if (frame.next < out.length) {
				const target = out[frame.next];
				frame.next++;
				if (index[target] === -1) {
					index[target] = counter;
					low[target] = counter;
					counter++;
					stack.push(target);
					onStack[target] = true;
					work.push({ node: target, next: 0 });
				} else if (onStack[target]) {
					low[frame.node] = Math.min(low[frame.node], index[target]);
				}
				continue;
			}
			work.pop();
			const parent = work[work.length - 1];
			if (parent !== undefined) low[parent.node] = Math.min(low[parent.node], low[frame.node]);
			if (low[frame.node] !== index[frame.node]) continue;
			const component: number[] = [];
			for (;;) {
				const member = stack.pop();
				if (member === undefined) break;
				onStack[member] = false;
				component.push(member);
				if (member === frame.node) break;
			}
			components.push(component);
		}
	}
	return components;
}

/** The labels of the BFS tree path from `start` down to `node`. */
function labelsFrom(
	prev: ReadonlyMap<number, { readonly from: number; readonly action: string }>,
	start: number,
	node: number,
): string[] {
	const labels: string[] = [];
	let at = node;
	while (at !== start) {
		const step = prev.get(at);
		if (step === undefined) break;
		labels.push(step.action);
		at = step.from;
	}
	return labels.reverse();
}

/** One cycle from `start` back to itself through step edges that stay inside the set `inside` accepts. */
function cycleThrough<V>(graph: ModelGraph<V>, start: number, inside: (index: number) => boolean): string[] {
	const prev = new Map<number, { readonly from: number; readonly action: string }>();
	const queue: number[] = [start];
	for (let head = 0; head < queue.length; head++) {
		const current = queue[head];
		for (const edge of graph.nodes[current].edges) {
			if (edge.kind !== "step" || !inside(edge.to)) continue;
			if (edge.to === start) return [...labelsFrom(prev, start, current), edge.action];
			if (prev.has(edge.to)) continue;
			prev.set(edge.to, { from: current, action: edge.action });
			queue.push(edge.to);
		}
	}
	return [];
}

/**
 * Every liveness breach of an explored graph, one per property (the shortest one found). A partial graph yields only real breaches:
 * a stall depends on the guards of expanded states and a cycle on explored edges, so a breach found there is in the model; a clean
 * partial graph proves nothing about the states it did not reach.
 */
export function checkLiveness<V>(spec: ModelSpec<V>, graph: ModelGraph<V>): LivenessBreach[] {
	const breaches: LivenessBreach[] = [];
	const actions = new Map(spec.actions.map((action) => [action.name, action] as const));
	for (const property of spec.liveness ?? []) {
		const fairActions = fairNamesOf(spec, property.fair)
			.map((name) => actions.get(name))
			.filter((action): action is ModelAction<V> => action !== undefined);
		const missesGoal = (index: number): boolean => !property.goal(graph.nodes[index].state);

		// A stall: the run stops at a state that misses the goal, and no fair action can move it on.
		const stalled = graph.nodes.find(
			(node) => node.expanded && missesGoal(node.index) && !fairActions.some((action) => action.guard(node.state)),
		);
		if (stalled !== undefined) {
			breaches.push({ name: property.name, path: tracePath(graph, stalled.index), cycle: [] });
			continue;
		}

		// A fair cycle among the states that miss the goal.
		const successors = graph.nodes.map((node) =>
			missesGoal(node.index)
				? node.edges.filter((edge) => edge.kind === "step" && missesGoal(edge.to)).map((edge) => edge.to)
				: [],
		);
		const components = strongComponents(graph.nodes.length, successors);
		let found = false;
		for (const component of components) {
			if (found) break;
			const first = component[0];
			if (!missesGoal(first)) continue;
			const nontrivial = component.length > 1 || successors[first].includes(first);
			if (!nontrivial) continue;
			const members = new Set(component);
			const inside = (index: number): boolean => members.has(index);
			const weaklyFair = fairActions.every(
				(action) =>
					component.some((index) => !action.guard(graph.nodes[index].state)) ||
					component.some((index) =>
						graph.nodes[index].edges.some(
							(edge) => edge.kind === "step" && edge.action === action.name && inside(edge.to),
						),
					),
			);
			if (!weaklyFair) continue;
			breaches.push({
				name: property.name,
				path: tracePath(graph, first),
				cycle: cycleThrough(graph, first, inside),
			});
			found = true;
		}
	}
	return breaches;
}
