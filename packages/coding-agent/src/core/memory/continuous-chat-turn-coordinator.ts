/**
 * ICM turn state. A fresh user turn first logs every persisted entry, then pins the view it is sent with, so the
 * view never contains the turn's own user message. Phases: idle, awaitingPrefix (settling the log and obtaining the snapshot
 * boundary), running (the turn holds the snapshot boundary), stopping (its submission was aborted; it ends at `end`).
 */

import type { AgentMessage } from "../../kernel/index.ts";
import type { ContinuousChatIngestor } from "./continuous-chat-ingest.ts";
import type {
	ContinuousChatPrefixWaitProgress,
	ContinuousChatRuntime,
	ContinuousChatTurnBoundary,
} from "./continuous-chat-runtime.ts";

export type IcmTurnPhase = "idle" | "awaitingPrefix" | "running" | "stopping";

/**
 * The entry a checkpoint kept verbatim directly before its summary: the turn's start. A rebuild re-materializes a custom
 * message as a new object, so the planned message is recognized by the entry it came from, never by object identity.
 */
export interface IcmTurnRetainedStart {
	readonly entryId: string;
	matches(message: AgentMessage): boolean;
}

/** A host compaction this turn applied to its own messages, and the start entry that checkpoint kept before its summary. */
export interface IcmTurnCompaction {
	readonly entryId: string;
	readonly retainedStart: IcmTurnRetainedStart | undefined;
}

export interface IcmTurnHandle {
	readonly turnId: number;
	readonly boundary: ContinuousChatTurnBoundary;
	readonly startedAt: number;
	/** `alreadyLogged` documents whether the start already exists in the log. */
	markStart(firstMessage: AgentMessage, alreadyLogged?: boolean): void;
	readonly startMessage: AgentMessage | undefined;
	/**
	 * Records a host compaction scoped to this turn. From then on the turn's messages begin at that checkpoint's
	 * summary (or the start entry it kept before the summary), not at the start message it summarized.
	 */
	noteCompaction(entryId: string, retainedStart: IcmTurnRetainedStart | undefined): void;
	/** The latest compaction this turn applied, if any. */
	readonly latestCompaction: IcmTurnCompaction | undefined;
	/** Every compaction entry id this turn applied: the only summaries its wire may carry. */
	readonly notedCompactions: ReadonlySet<string>;
}

class IcmTurn implements IcmTurnHandle {
	readonly turnId: number;
	readonly boundary: ContinuousChatTurnBoundary;
	readonly startedAt: number;
	private started: AgentMessage | undefined;
	private latest: IcmTurnCompaction | undefined;
	private readonly noted = new Set<string>();

	constructor(turnId: number, boundary: ContinuousChatTurnBoundary, startedAt: number) {
		this.turnId = turnId;
		this.boundary = boundary;
		this.startedAt = startedAt;
	}

	get startMessage(): AgentMessage | undefined {
		return this.started;
	}

	/**
	 * Records the exact message that owns the turn. The boundary is a coherent snapshot, not an append lock: later
	 * arrivals receive higher permanent ids and are intentionally outside the pinned view.
	 */
	markStart(firstMessage: AgentMessage, alreadyLogged = false): void {
		if (this.started !== undefined) throw new Error(`ICM turn ${this.turnId} already has its start message.`);
		this.started = firstMessage;
		void alreadyLogged;
		this.boundary.release();
	}

	get latestCompaction(): IcmTurnCompaction | undefined {
		return this.latest;
	}

	get notedCompactions(): ReadonlySet<string> {
		return this.noted;
	}

	noteCompaction(entryId: string, retainedStart: IcmTurnRetainedStart | undefined): void {
		if (this.started === undefined) {
			throw new Error(`ICM turn ${this.turnId} cannot record a compaction before its start message.`);
		}
		if (this.noted.has(entryId)) throw new Error(`ICM turn ${this.turnId} already recorded compaction ${entryId}.`);
		this.noted.add(entryId);
		this.latest = { entryId, retainedStart };
	}
}

export interface IcmTurnCoordinatorDeps {
	runtime: Pick<ContinuousChatRuntime, "reserveTurnBoundary">;
	ingestor: Pick<ContinuousChatIngestor, "flush" | "settled">;
	/** Settles once the host has imported the legacy history and started dispatch: no turn pins an earlier history. */
	started: Promise<void>;
}

/** The awaited step's result, or the abort that ends a turn's wait for it. */
function untilAborted<T>(step: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return step;
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(signal.reason);
		// `step` is always observed, even when the abort already happened: a later failure of it stays handled.
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		step.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export class IcmTurnCoordinator {
	private readonly deps: IcmTurnCoordinatorDeps;
	private currentPhase: IcmTurnPhase = "idle";
	private turn: IcmTurn | undefined;
	private turnCount = 0;
	/** The view the latest turn pinned, kept after it ends: the persisted view a worker is born with between turns. */
	private pinned: { view: string; timestamp: number } | undefined;
	private detachAbort: (() => void) | undefined;
	private readonly listeners = new Set<(phase: IcmTurnPhase) => void>();

	constructor(deps: IcmTurnCoordinatorDeps) {
		this.deps = deps;
	}

	/**
	 * Starts a fresh user turn. Every announced entry is logged first: a failed log rejects here and the turn does not
	 * start, so it never proceeds with earlier messages missing. Then the boundary is pinned. Rejects on abort.
	 */
	async begin(
		signal?: AbortSignal,
		onWaiting?: (progress: ContinuousChatPrefixWaitProgress) => void,
	): Promise<IcmTurnHandle> {
		if (this.currentPhase !== "idle")
			throw new Error(`ICM turn cannot begin while the turn is ${this.currentPhase}.`);
		this.setPhase("awaitingPrefix");
		let boundary: ContinuousChatTurnBoundary;
		try {
			await untilAborted(this.deps.started, signal);
			await untilAborted(this.deps.ingestor.flush(), signal);
			await untilAborted(this.deps.ingestor.settled(), signal);
			signal?.throwIfAborted();
			boundary = await this.deps.runtime.reserveTurnBoundary(signal, onWaiting);
		} catch (error) {
			this.setPhase("idle");
			throw error;
		}
		if (signal?.aborted) {
			boundary.release();
			this.setPhase("idle");
			signal.throwIfAborted();
		}
		const turn = new IcmTurn(++this.turnCount, boundary, Date.now());
		this.turn = turn;
		this.pinned = { view: boundary.view, timestamp: turn.startedAt };
		if (signal) {
			const onAbort = () => {
				if (this.turn === turn && this.currentPhase === "running") this.setPhase("stopping");
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.detachAbort = () => signal.removeEventListener("abort", onAbort);
		}
		this.setPhase("running");
		return turn;
	}

	/** Ends the turn and releases its boundary. Ending a handle that is not the current turn does nothing. */
	end(handle: IcmTurnHandle): void {
		if (this.turn !== handle) return;
		this.detachAbort?.();
		this.detachAbort = undefined;
		handle.boundary.release();
		this.turn = undefined;
		this.setPhase("idle");
	}

	current(): IcmTurnHandle | undefined {
		return this.turn;
	}

	/** The chat view a worker is born with: the running turn's pinned view, else the view the latest turn pinned. */
	birthView(): { view: string; timestamp: number } | undefined {
		const running = this.turn;
		return running ? { view: running.boundary.view, timestamp: running.startedAt } : this.pinned;
	}

	phase(): IcmTurnPhase {
		return this.currentPhase;
	}

	subscribe(listener: (phase: IcmTurnPhase) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private setPhase(phase: IcmTurnPhase): void {
		this.currentPhase = phase;
		for (const listener of this.listeners) listener(phase);
	}
}
