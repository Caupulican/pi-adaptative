/**
 * ICM turn state. A fresh user turn first logs every persisted entry, then pins the view it is sent with, so the
 * view never contains the turn's own user message. Phases: idle, awaitingPrefix (settling the log and obtaining the snapshot
 * boundary), running (the turn holds the snapshot boundary), stopping (its submission was aborted; it ends at `end`).
 */

import type { AgentMessage } from "../../kernel/index.ts";
import type { ContinuousChatIngestor } from "./continuous-chat-ingest.ts";
import type { ContinuousChatRuntime, ContinuousChatTurnBoundary } from "./continuous-chat-runtime.ts";

export type IcmTurnPhase = "idle" | "awaitingPrefix" | "running" | "stopping";

export interface IcmTurnHandle {
	readonly turnId: number;
	readonly boundary: ContinuousChatTurnBoundary;
	readonly startedAt: number;
	/** `alreadyLogged` documents whether the start already exists in the log. */
	markStart(firstMessage: AgentMessage, alreadyLogged?: boolean): void;
	readonly startMessage: AgentMessage | undefined;
}

class IcmTurn implements IcmTurnHandle {
	readonly turnId: number;
	readonly boundary: ContinuousChatTurnBoundary;
	readonly startedAt: number;
	private started: AgentMessage | undefined;

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
}

export interface IcmTurnCoordinatorDeps {
	runtime: Pick<ContinuousChatRuntime, "reserveTurnBoundary">;
	ingestor: Pick<ContinuousChatIngestor, "flush" | "settled">;
	/** Settles once the host has imported the legacy history and started dispatch: no turn pins an earlier history. */
	started: Promise<void>;
}

/** The start of the chat, or the abort that ends a turn's wait for it. */
function startedOrAborted(started: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
	if (signal === undefined) return started;
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		started.then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
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
	async begin(signal?: AbortSignal): Promise<IcmTurnHandle> {
		if (this.currentPhase !== "idle")
			throw new Error(`ICM turn cannot begin while the turn is ${this.currentPhase}.`);
		this.setPhase("awaitingPrefix");
		let boundary: ContinuousChatTurnBoundary;
		try {
			await startedOrAborted(this.deps.started, signal);
			await this.deps.ingestor.flush();
			await this.deps.ingestor.settled();
			signal?.throwIfAborted();
			boundary = await this.deps.runtime.reserveTurnBoundary(signal);
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
