/**
 * A declared state machine and an observer of it. `defineMachine` names the states, the events and which event moves a
 * state to which; it is pure data plus two lookups. `observeMachine` is the shadow of a machine that still owns its own
 * transitions elsewhere: the owner reports each change with `record`, which checks it against the table, logs an
 * undeclared one at warn (category `machine`), counts it and keeps the last few for a status view. It never throws and
 * never changes what the owner does. A machine becomes the owner of its transitions only after its shadow ran clean.
 */

import { harnessLog } from "./harness-log.ts";

export interface MachineDefinition<State extends string, Event extends string> {
	readonly name: string;
	readonly states: readonly State[];
	readonly initial: State;
	/** For each state, the state each event leads to. A missing event is not allowed from that state. */
	readonly transitions: Readonly<Record<State, Partial<Record<Event, State>>>>;
	/** Each state in plain words, for a status line. */
	readonly describe?: Readonly<Record<State, string>>;
}

export interface MachineSpec<State extends string, Event extends string> extends MachineDefinition<State, Event> {
	can(from: State, event: Event): boolean;
	/** The state `event` leads to from `from`; undefined when the event is not allowed there. */
	next(from: State, event: Event): State | undefined;
	/** Whether some declared event moves `from` to `to`. */
	allows(from: State, to: State): boolean;
	plain(state: State): string;
}

export function defineMachine<State extends string, Event extends string>(
	definition: MachineDefinition<State, Event>,
): MachineSpec<State, Event> {
	const next = (from: State, event: Event): State | undefined => definition.transitions[from]?.[event];
	return {
		...definition,
		can: (from, event) => next(from, event) !== undefined,
		next,
		allows: (from, to) => Object.values(definition.transitions[from] ?? {}).includes(to),
		plain: (state) => definition.describe?.[state] ?? state,
	};
}

export interface MachineTransition<State extends string = string> {
	readonly from: State;
	readonly to: State;
	readonly reason: string;
	readonly at: number;
	readonly legal: boolean;
}

export interface MachineSnapshot<State extends string = string> {
	readonly name: string;
	readonly state: State;
	readonly plain: string;
	/** Clock time the machine entered `state`. */
	readonly since: number;
	readonly illegalCount: number;
	readonly recent: readonly MachineTransition<State>[];
}

export interface MachineObserver<State extends string = string> {
	/** Reports a transition the owner already made; `reason` is an id or enum name, never user text. Never throws. */
	record(from: State, to: State, reason: string): void;
	snapshot(): MachineSnapshot<State>;
}

export interface MachineObserverOptions<State extends string> {
	readonly onIllegal?: (transition: MachineTransition<State>) => void;
	readonly log?: { warn(category: string, message: string, fields?: () => Record<string, unknown>): void };
	readonly clock?: () => number;
}

const RECENT_LIMIT = 16;

export function observeMachine<State extends string, Event extends string>(
	spec: MachineSpec<State, Event>,
	options: MachineObserverOptions<State> = {},
): MachineObserver<State> {
	const log = options.log ?? harnessLog;
	const clock = options.clock ?? Date.now;
	let state = spec.initial;
	let since = clock();
	let illegalCount = 0;
	const recent: MachineTransition<State>[] = [];
	return {
		record(from, to, reason) {
			try {
				const at = clock();
				const legal = spec.allows(from, to);
				const transition: MachineTransition<State> = { from, to, reason, at, legal };
				recent.push(transition);
				if (recent.length > RECENT_LIMIT) recent.shift();
				if (to !== state) since = at;
				state = to;
				if (legal) return;
				illegalCount++;
				log.warn("machine", "an undeclared state transition", () => ({ machine: spec.name, from, to, reason }));
				options.onIllegal?.(transition);
			} catch {
				// An observer never changes what the machine it watches does.
			}
		},
		snapshot: () => ({ name: spec.name, state, plain: spec.plain(state), since, illegalCount, recent: [...recent] }),
	};
}

const registry = new Set<MachineObserver>();

/** Lists an adopted machine's observer for status views; the returned function removes it (a session's end). */
export function registerMachine(observer: MachineObserver): () => void {
	registry.add(observer);
	return () => {
		registry.delete(observer);
	};
}

export function listMachines(): MachineSnapshot[] {
	return [...registry].map((observer) => observer.snapshot());
}
