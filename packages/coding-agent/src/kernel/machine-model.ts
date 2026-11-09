/**
 * The vocabulary of the kernel model checker. A model is plain data: initial states, guarded actions, invariants, the faults
 * the environment may inject (crash steps and lossy steps) and the bounds that make exploration finite. This module owns the
 * shape rules a model must meet, the canonical state encoding the explorer keys on, the restart rule, the graph and report
 * types, and the projection of an explored graph onto a `MachineDefinition`. Exploration lives in
 * `machine-model-explore.ts`. Nothing here reads a clock or randomness, and nothing here depends on a package.
 *
 * Two rules belong to the model author, because the checker cannot see them: `apply` returns new states and never mutates
 * its argument (the explorer detects a mutation after the fact, it does not prevent one), and a multiset such as frames in
 * flight is stored in one normalized order, because the encoding keeps array order.
 */

import type { MachineDefinition } from "./machine-spec.ts";

/** One step the model can take. `apply` returns one successor, or several for a nondeterministic step. */
export interface ModelAction<V> {
	readonly name: string;
	readonly actor: string;
	guard(state: V): boolean;
	apply(state: V): V | readonly V[];
	/** A message loss. A path may take at most `bounds.maxDrops` of these; they never count as progress. */
	readonly lossy?: boolean;
}

export interface ModelInvariant<V> {
	readonly name: string;
	holds(state: V): boolean;
	/** The variant that breaks exactly this property. */
	readonly brokenVariant: string;
}

export interface ModelLiveness<V> {
	readonly name: string;
	readonly goal: (state: V) => boolean;
	/** Action names, or `*` patterns, under weak fairness. */
	readonly fair: readonly string[];
	readonly brokenVariant: string;
}

export interface ModelCover {
	readonly path: string;
	readonly symbols: readonly string[];
}

/** The volatile variables one actor loses on restart, with the values they take afterwards. */
export interface ModelCrash<V> {
	readonly actor: string;
	readonly volatile: Partial<V>;
}

export interface ModelBounds {
	/** Most search nodes admitted. Reaching it stops the search and marks the graph not exhausted. */
	readonly maxStates: number;
	/** Most crash steps on one path. */
	readonly maxCrashes: number;
	/** Most lossy steps on one path. */
	readonly maxDrops: number;
}

export interface ModelSpec<V> {
	readonly name: string;
	/** `durable` lists what a crash keeps; `volatile` declares the volatile variables a crash entry may reset. */
	readonly vars: { readonly durable: readonly (keyof V)[]; readonly volatile: Partial<V> };
	readonly init: readonly V[];
	readonly actions: readonly ModelAction<V>[];
	readonly crashes?: readonly ModelCrash<V>[];
	readonly invariants: readonly ModelInvariant<V>[];
	readonly liveness?: readonly ModelLiveness<V>[];
	/** A state with no successor from a step action is a deadlock unless this holds for it. Omitted: no state is terminal. */
	readonly terminal?: (state: V) => boolean;
	readonly bounds: ModelBounds;
	readonly covers: readonly ModelCover[];
	readonly variants: Readonly<Record<string, (spec: ModelSpec<V>) => ModelSpec<V>>>;
	/** The projection onto one adopting machine: `states` labels a state, `events` lists the machine's events. */
	readonly machine?: { readonly states: (state: V) => string; readonly events: readonly string[] };
}

/** One edge of the graph. `step` is progress by a model action, `loss` a lossy action, `crash` a restart. */
export interface ModelEdge {
	readonly action: string;
	readonly kind: "step" | "loss" | "crash";
	/** Index of the node the edge leads to. */
	readonly to: number;
}

/**
 * One node of the search: a state together with the crash and drop counts its path has used, since the bounds depend on
 * them. Nodes are in discovery order, which is breadth-first: depth never decreases as the index grows.
 */
export interface ModelNode<V> {
	readonly index: number;
	readonly state: V;
	/** Canonical encoding of the state alone, without the budgets. */
	readonly key: string;
	/** Position in `init` of the initial state this node's paths start from. */
	readonly init: number;
	readonly depth: number;
	/** The first edge that reached this node; undefined for an initial node. */
	readonly via: { readonly parent: number; readonly action: string } | undefined;
	readonly crashes: number;
	readonly drops: number;
	/** False only when the bound stopped the search before this node's successors were generated. */
	readonly expanded: boolean;
	/** Every edge generated from this node, including self-loops and edges into nodes already seen. */
	readonly edges: readonly ModelEdge[];
}

export interface ModelGraph<V> {
	readonly nodes: readonly ModelNode<V>[];
	/** False when the search stopped at `bounds.maxStates`. Such a graph proves nothing and is never projected. */
	readonly exhausted: boolean;
}

export interface ModelBreach {
	readonly invariant: string;
	/** The counterexample: `init#<i>` then the edge labels to the first state that breaks the invariant. */
	readonly path: readonly string[];
}

export interface ModelReport {
	readonly states: number;
	readonly exhausted: boolean;
	/** One entry per invariant that some reachable state breaks, the shortest path first found. */
	readonly broken: readonly ModelBreach[];
	/** One path per distinct deadlocked state, in the same format as a breach path. */
	readonly deadlocks: readonly (readonly string[])[];
	/** Edge labels taken on at least one edge, sorted. Crash labels are included. */
	readonly fired: readonly string[];
}

/** Returns the spec when it is well formed, and throws when it is not: the explorer relies on every rule it checks. */
export function defineModel<V>(spec: ModelSpec<V>): ModelSpec<V> {
	const failures = modelShapeFailures(spec);
	if (failures.length > 0) throw new Error(`model "${spec.name}" is malformed: ${failures.join("; ")}`);
	return spec;
}

/** Every way the model breaks a rule the explorer or the static checks depend on. Empty when the model is well formed. */
export function modelShapeFailures<V>(spec: ModelSpec<V>): string[] {
	const failures: string[] = [];
	const variants = Object.keys(spec.variants);
	const volatileKeys = Object.keys(spec.vars.volatile);
	const actionNames = spec.actions.map((action) => action.name);
	const crashActors = (spec.crashes ?? []).map((entry) => entry.actor);
	const crashLabels = crashActors.map(crashLabel);
	const livenessNames = (spec.liveness ?? []).map((property) => property.name);
	if (spec.name.length === 0) failures.push("the model has no name");
	if (spec.init.length === 0) failures.push("the model has no initial state");
	for (const name of repeated(actionNames)) failures.push(`action "${name}" is declared more than once`);
	for (const name of actionNames) {
		if (crashLabels.includes(name)) failures.push(`action "${name}" collides with a crash step`);
	}
	for (const name of repeated(spec.invariants.map((invariant) => invariant.name))) {
		failures.push(`invariant "${name}" is declared more than once`);
	}
	for (const name of repeated(livenessNames)) failures.push(`liveness property "${name}" is declared more than once`);
	for (const name of repeated(crashActors)) failures.push(`crash actor "${name}" is declared more than once`);
	for (const property of [...spec.invariants, ...(spec.liveness ?? [])]) {
		if (!variants.includes(property.brokenVariant)) {
			failures.push(`"${property.name}" names no variant "${property.brokenVariant}"`);
		}
	}
	for (const entry of spec.crashes ?? []) {
		for (const key of Object.keys(entry.volatile)) {
			if (!volatileKeys.includes(key)) failures.push(`a crash of "${entry.actor}" resets undeclared "${key}"`);
		}
	}
	for (const key of spec.vars.durable.map(String)) {
		if (volatileKeys.includes(key)) failures.push(`"${key}" is both durable and volatile`);
	}
	const { maxStates, maxCrashes, maxDrops } = spec.bounds;
	if (!Number.isSafeInteger(maxStates) || maxStates < 1)
		failures.push("bounds.maxStates must be an integer of at least 1");
	if (!Number.isSafeInteger(maxCrashes) || maxCrashes < 0)
		failures.push("bounds.maxCrashes must be an integer of at least 0");
	if (!Number.isSafeInteger(maxDrops) || maxDrops < 0)
		failures.push("bounds.maxDrops must be an integer of at least 0");
	if (spec.machine !== undefined) {
		for (const name of actionNames) {
			if (!spec.machine.events.includes(name)) failures.push(`action "${name}" is not an event of the machine`);
		}
	}
	return failures;
}

/** The names that occur more than once in `names`, each listed once. */
function repeated(names: readonly string[]): string[] {
	const seen = new Set<string>();
	const found = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) found.add(name);
		else seen.add(name);
	}
	return [...found];
}

/** The edge label of a restart of `actor`, and the path entry that names it. */
export function crashLabel(actor: string): string {
	return `crash(${actor})`;
}

/** The state after `actor` restarts: its declared volatile values overwrite the state, and nothing else changes. */
export function crash<V>(spec: ModelSpec<V>, actor: string, state: V): V {
	const entry = spec.crashes?.find((candidate) => candidate.actor === actor);
	if (entry === undefined) throw new Error(`model "${spec.name}" declares no crash for actor "${actor}"`);
	return { ...state, ...entry.volatile };
}

/**
 * The canonical key of a state: JSON with object keys sorted at every depth and array order kept. A value that JSON would
 * flatten (undefined, NaN, a Map, a Set, a class instance, a symbol key) is an error here, because two different states
 * would otherwise share one key and the search would prune one of them without a word.
 */
export function encodeState(state: unknown): string {
	if (!isPlainObject(state)) throw new Error("a model state must be a plain object");
	return encodeAt(state, "state");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function encodeAt(value: unknown, where: string): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${where} is ${value}; a model state holds finite numbers only`);
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		const items: string[] = [];
		for (let index = 0; index < value.length; index++) {
			if (!(index in value)) throw new Error(`${where} is a sparse array`);
			items.push(encodeAt(value[index], `${where}[${index}]`));
		}
		return `[${items.join(",")}]`;
	}
	if (!isPlainObject(value)) throw new Error(`${where} is not a JSON value (${typeof value})`);
	if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${where} has a symbol key`);
	const members = Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${encodeAt(value[key], `${where}.${key}`)}`);
	return `{${members.join(",")}}`;
}

/**
 * The machine a model adopts, read off an explored graph: one state per projected label, and one transition per step or
 * loss edge. Crash edges are restarts, not the machine's own events, and are left out. A projection that would need two
 * different targets for one event from one state throws, because a machine table cannot hold that; so does an initial
 * set that projects to more than one state. Only an exhausted graph is projected.
 */
export function projectMachine<V>(spec: ModelSpec<V>, graph: ModelGraph<V>): MachineDefinition<string, string> {
	const machine = spec.machine;
	if (machine === undefined) throw new Error(`model "${spec.name}" declares no machine projection`);
	if (!graph.exhausted) throw new Error(`model "${spec.name}" has a partial exploration; it cannot be projected`);
	const labels = graph.nodes.map((node) => machine.states(node.state));
	const initials = [
		...new Set(graph.nodes.filter((node) => node.via === undefined).map((node) => labels[node.index])),
	];
	if (initials.length !== 1)
		throw new Error(`model "${spec.name}": the initial states project to ${initials.join(", ")}`);
	const states = [...new Set(labels)].sort();
	const transitions: Record<string, Partial<Record<string, string>>> = {};
	for (const state of states) transitions[state] = {};
	for (const node of graph.nodes) {
		const from = labels[node.index];
		for (const edge of node.edges) {
			if (edge.kind === "crash") continue;
			const to = labels[edge.to];
			const row = transitions[from];
			const known = row[edge.action];
			if (known !== undefined && known !== to) {
				throw new Error(
					`model "${spec.name}": event "${edge.action}" from "${from}" leads to both "${known}" and "${to}"`,
				);
			}
			row[edge.action] = to;
		}
	}
	return { name: spec.name, states, initial: initials[0], transitions };
}
