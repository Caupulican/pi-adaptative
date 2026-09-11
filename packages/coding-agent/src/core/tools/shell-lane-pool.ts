/**
 * An elastic pool of reusable execution lanes.
 *
 * A persistent shell runs one command at a time, so a single session turns a wave of commands the
 * model emitted together into a queue. The pool keeps a small set of warm, reusable lanes instead:
 * commands take an idle lane at once, the pool grows on demand up to a cap when every lane is busy,
 * a command that arrives at the cap waits in arrival order for the first lane released, and a lane
 * beyond the warm minimum that has been idle long enough is disposed so a burst does not leave
 * processes behind forever.
 *
 * The pool owns lane lifetime and nothing else. What a lane IS (a persistent POSIX shell session
 * key, a Windows engine coordinator key) belongs to the caller, which supplies `createLane` and
 * `disposeLane`.
 */

import { disposePersistentShellSession, ShellExportLedger } from "./shell-session.ts";

/** Warm lanes created on the first acquire; these are never retired. */
export const DEFAULT_MIN_SHELL_LANES = 3;
/** Hard ceiling on concurrent lanes. Beyond it, callers wait in arrival order. */
export const DEFAULT_MAX_SHELL_LANES = 8;
/** How long a lane beyond the warm minimum may sit idle before it is disposed. */
export const DEFAULT_SHELL_LANE_IDLE_RETIRE_MS = 60_000;

export interface ShellLanePoolOptions<TLane> {
	/** Build lane number `index`. Called at most once per index; indexes are never reused. */
	createLane: (index: number) => TLane;
	/** Release everything the lane owns. Awaited by {@link ShellLanePool.dispose}. */
	disposeLane: (lane: TLane) => Promise<void> | void;
	minLanes?: number;
	maxLanes?: number;
	/** Zero or less keeps every lane the pool ever created. */
	idleRetireMs?: number;
	/** Injectable clock; the retire deadline is checked against it, not against timer delivery. */
	now?: () => number;
	/** Injectable timer pair, so tests drive retirement without real time. */
	setTimeout?: (handler: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
}

export interface ShellLanePoolStats {
	lanes: number;
	idle: number;
	busy: number;
	waiting: number;
}

interface LaneEntry<TLane> {
	lane: TLane;
	index: number;
	busy: boolean;
	/** Clock reading at the moment the lane last became idle. */
	idleSince: number;
	retireHandle: unknown;
}

interface LaneWaiter<TLane> {
	admit: (lane: TLane) => void;
	reject: (reason: unknown) => void;
	/** Detaches the abort listener, so a waiter served normally leaves nothing armed behind it. */
	detach: () => void;
}

function armDefaultTimer(handler: () => void, ms: number): unknown {
	const handle = setTimeout(handler, ms);
	// The pool must never be the reason a process stays alive: a lane waiting to be retired is not
	// work, it is bookkeeping.
	if (typeof handle === "object" && handle !== null && "unref" in handle) handle.unref();
	return handle;
}

function disposedError(): Error {
	return new Error("The shell lane pool is disposed.");
}

export class ShellLanePool<TLane> {
	private readonly createLane: (index: number) => TLane;
	private readonly disposeLane: (lane: TLane) => Promise<void> | void;
	private readonly minLanes: number;
	private readonly maxLanes: number;
	private readonly idleRetireMs: number;
	private readonly now: () => number;
	private readonly armTimer: (handler: () => void, ms: number) => unknown;
	private readonly disarmTimer: (handle: unknown) => void;
	private readonly lanes: LaneEntry<TLane>[] = [];
	private readonly waiters: LaneWaiter<TLane>[] = [];
	/** Disposals still in flight, so `dispose()` resolves only once every lane is really gone. */
	private readonly disposals = new Set<Promise<void>>();
	private nextIndex = 0;
	private disposed = false;

	constructor(options: ShellLanePoolOptions<TLane>) {
		this.createLane = options.createLane;
		this.disposeLane = options.disposeLane;
		this.minLanes = Math.max(1, options.minLanes ?? DEFAULT_MIN_SHELL_LANES);
		this.maxLanes = Math.max(this.minLanes, options.maxLanes ?? DEFAULT_MAX_SHELL_LANES);
		this.idleRetireMs = options.idleRetireMs ?? DEFAULT_SHELL_LANE_IDLE_RETIRE_MS;
		this.now = options.now ?? Date.now;
		this.armTimer = options.setTimeout ?? armDefaultTimer;
		this.disarmTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	stats(): ShellLanePoolStats {
		let busy = 0;
		for (const entry of this.lanes) if (entry.busy) busy += 1;
		return { lanes: this.lanes.length, idle: this.lanes.length - busy, busy, waiting: this.waiters.length };
	}

	/**
	 * Take a lane. Resolves at once with an idle lane, or with a newly created one while the pool is
	 * below its cap; at the cap it waits in arrival order. An abort rejects with the signal's reason
	 * and removes the wait, so an abandoned caller never holds a lane it will not use.
	 */
	acquire(signal?: AbortSignal): Promise<TLane> {
		if (this.disposed) return Promise.reject(disposedError());
		if (signal?.aborted) return Promise.reject(signal.reason);
		this.ensureWarmLanes();
		const idle = this.lanes.find((entry) => !entry.busy);
		if (idle) return Promise.resolve(this.occupy(idle));
		if (this.lanes.length < this.maxLanes) return Promise.resolve(this.occupy(this.addLane()));
		return this.waitForLane(signal);
	}

	/**
	 * Give a lane back. The oldest waiter takes it over directly; otherwise the lane goes idle and,
	 * when it is one of the on-demand lanes, arms its retirement.
	 */
	release(lane: TLane): void {
		const entry = this.lanes.find((candidate) => candidate.lane === lane);
		// A lane retired or disposed while its command was running is no longer the pool's: the
		// command owned it to the end, and there is nothing to hand on.
		if (!entry) return;
		entry.busy = false;
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter.detach();
			entry.busy = true;
			waiter.admit(entry.lane);
			return;
		}
		entry.idleSince = this.now();
		this.armRetirement(entry);
	}

	/** Dispose every lane and reject every waiter. Resolves once all lane disposals have settled. */
	dispose(): Promise<void> {
		if (!this.disposed) {
			this.disposed = true;
			for (const waiter of this.waiters.splice(0)) {
				waiter.detach();
				waiter.reject(disposedError());
			}
			for (const entry of this.lanes.splice(0)) {
				this.disarmRetirement(entry);
				this.trackDisposal(entry.lane);
			}
		}
		return Promise.all([...this.disposals]).then(() => undefined);
	}

	private ensureWarmLanes(): void {
		while (this.lanes.length < this.minLanes) this.addLane();
	}

	private addLane(): LaneEntry<TLane> {
		const index = this.nextIndex++;
		const entry: LaneEntry<TLane> = {
			lane: this.createLane(index),
			index,
			busy: false,
			idleSince: this.now(),
			retireHandle: undefined,
		};
		this.lanes.push(entry);
		return entry;
	}

	private occupy(entry: LaneEntry<TLane>): TLane {
		this.disarmRetirement(entry);
		entry.busy = true;
		return entry.lane;
	}

	private waitForLane(signal: AbortSignal | undefined): Promise<TLane> {
		return new Promise<TLane>((admit, reject) => {
			let waiter!: LaneWaiter<TLane>;
			const onAbort = (): void => {
				const position = this.waiters.indexOf(waiter);
				if (position !== -1) this.waiters.splice(position, 1);
				reject(signal?.reason);
			};
			waiter = {
				admit,
				reject,
				detach: () => signal?.removeEventListener("abort", onAbort),
			};
			this.waiters.push(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private armRetirement(entry: LaneEntry<TLane>): void {
		// The warm lanes are the pool's floor: they stay for the life of the session.
		if (entry.index < this.minLanes || this.idleRetireMs <= 0 || this.disposed) return;
		entry.retireHandle = this.armTimer(() => this.retire(entry), this.idleRetireMs);
	}

	private disarmRetirement(entry: LaneEntry<TLane>): void {
		if (entry.retireHandle === undefined) return;
		this.disarmTimer(entry.retireHandle);
		entry.retireHandle = undefined;
	}

	private retire(entry: LaneEntry<TLane>): void {
		entry.retireHandle = undefined;
		if (this.disposed || entry.busy) return;
		// The clock, not the timer, decides: a timer that fires early (or a lane that went idle again
		// after a short use) re-arms instead of disposing a lane that is still within its window.
		const idleFor = this.now() - entry.idleSince;
		if (idleFor < this.idleRetireMs) {
			entry.retireHandle = this.armTimer(() => this.retire(entry), this.idleRetireMs - idleFor);
			return;
		}
		const position = this.lanes.indexOf(entry);
		if (position === -1) return;
		this.lanes.splice(position, 1);
		this.trackDisposal(entry.lane);
	}

	private trackDisposal(lane: TLane): void {
		const settled = Promise.resolve(this.disposeLane(lane)).then(
			() => {
				this.disposals.delete(settled);
			},
			(error: unknown) => {
				this.disposals.delete(settled);
				throw error;
			},
		);
		this.disposals.add(settled);
		// `dispose()` awaits `settled` itself and still sees a disposal failure. This subscription
		// only marks the background retirement path as handled, so a failure cannot surface as an
		// unhandled rejection in a process nobody asked to tear the pool down.
		settled.catch(() => undefined);
	}
}

/**
 * The lane pool of one agent's persistent shell session.
 *
 * A lane is a session KEY, not a session object: every command resolves its lane through
 * `acquirePersistentShellSession`, so a session replaced underneath the pool (a shell-kind change,
 * a reset after a timeout) is picked up lazily instead of being retained as a dead object.
 *
 * The pool, not the lane, owns the working directory and the exported variables. A `cd` on any lane
 * moves the whole pool: the directory a command reports becomes the directory every later command
 * starts in, which is what "one persistent shell session" meant before the pool existed. An
 * `export` on any lane reaches the whole pool through the {@link ShellExportLedger}: each lane
 * contributes the delta its commands produced and replays what it lacks before its next command.
 */
export class ShellSessionLanes {
	readonly pool: ShellLanePool<string>;
	/** Directory the pool is standing in; undefined until a command has reported one. */
	currentCwd: string | undefined;
	/** Exported variables of the session, merged from every lane's reports. */
	readonly exports = new ShellExportLedger();

	constructor(sessionKey: string) {
		this.pool = new ShellLanePool<string>({
			createLane: (index) => `${sessionKey}#lane-${index}`,
			disposeLane: (laneKey) => disposePersistentShellSession(laneKey),
		});
	}
}

const shellSessionLanes = new Map<string, ShellSessionLanes>();

/** Get or lazily create the lane pool for one shell session key. */
export function acquireShellSessionLanes(sessionKey: string): ShellSessionLanes {
	const existing = shellSessionLanes.get(sessionKey);
	if (existing) return existing;
	const lanes = new ShellSessionLanes(sessionKey);
	shellSessionLanes.set(sessionKey, lanes);
	return lanes;
}

/** Kill and forget every shell a session's lanes own. Safe for keys that never ran a command. */
export function disposeShellSessionLanes(sessionKey: string): Promise<void> {
	const lanes = shellSessionLanes.get(sessionKey);
	if (!lanes) return Promise.resolve();
	shellSessionLanes.delete(sessionKey);
	return lanes.pool.dispose();
}
