/**
 * Dispatch and turn boundaries for the permanent chat. The store owns every durable transition. This runtime claims
 * work, runs compactions, maps their outcomes back to the store, and admits appends and turn snapshots in order.
 * Nothing here polls: every wait wakes on a change in the runtime's own state.
 */

import { safeErrorMessage } from "../../kernel/types.ts";
import {
	ContinuousChatCompactionCoordinator,
	type ContinuousChatCompactionOutcome,
	type ContinuousChatCompactionPort,
	type ContinuousChatCompactionPrefix,
	type ContinuousChatCompactionTarget,
} from "./continuous-chat-compaction.ts";
import {
	type ContinuousChatAppendInput,
	type ContinuousChatAppendResult,
	type ContinuousChatRecord,
	normalizeContinuousChatAppend,
} from "./continuous-chat-contracts.ts";
import type { ContinuousChatNavigationSource } from "./continuous-chat-navigation.ts";
import type { ContinuousChatStore, ContinuousChatTurnSnapshot } from "./continuous-chat-store.ts";
import {
	continuousChatNodeFirstMessage,
	continuousChatNodeLabel,
	continuousChatNodeMessageCount,
} from "./continuous-chat-tree.ts";
import {
	CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS,
	type ContinuousChatWorkItem,
	type ContinuousChatWorkQueueState,
	continuousChatBuiltLeafPrefix,
	continuousChatFailedLeafCount,
	continuousChatUnbuiltLeafCount,
	continuousChatWorkItemKey,
} from "./continuous-chat-work-queue.ts";

/** Raised when a turn cannot see every logged message: nothing is ready or running, so waiting would never end. */
export class ContinuousChatPrefixUnavailableError extends Error {
	readonly reasons: string[];

	constructor(reasons: string[]) {
		super(`Continuous-chat prefix is unavailable: ${reasons.join("; ") || "no work is ready or running"}`);
		this.name = "ContinuousChatPrefixUnavailableError";
		this.reasons = reasons;
	}
}

/** How far a waiting turn's leaf build has come: `built` of `needed` leaves, `failed` of the rest awaiting a retry. */
export interface ContinuousChatPrefixWaitProgress {
	readonly built: number;
	readonly needed: number;
	readonly failed: number;
}

export interface ContinuousChatTurnBoundary {
	readonly boundaryId: number;
	readonly totalMessages: number;
	readonly viewRevision: number;
	/** Rendered `<chat>` of messages [0, totalMessages). It excludes the arriving user message. */
	readonly view: string;
	/** Idempotent no-op release hook retained on the boundary handle. */
	release(): void;
}

export type ContinuousChatRuntimeEvent =
	| { type: "message"; id: number }
	| { type: "node"; level: number; ordinal: number }
	| { type: "failed"; item: ContinuousChatWorkItem; reason: string }
	| { type: "idle" };

/** The foreground system prompt and tool set. Compactions must send exactly these to share the turns' cache prefix. */
export type ContinuousChatCompactionPrefixHead = Pick<ContinuousChatCompactionPrefix, "systemPrompt" | "tools">;

export interface ContinuousChatRuntimeOptions {
	store: ContinuousChatStore;
	port: ContinuousChatCompactionPort;
	prefixHead: () => ContinuousChatCompactionPrefixHead;
	warn: (message: string) => void;
	/** Names this session in the project lease, so a refused session can see which session holds the chat. */
	label?: string;
}

type TurnAttempt =
	| { status: "reserved"; boundary: ContinuousChatTurnBoundary }
	| { status: "waiting"; queue: ContinuousChatWorkQueueState; totalMessages: number };

type AppendAttempt = { status: "appended"; results: ContinuousChatAppendResult[] };

interface CausalTarget {
	target: ContinuousChatCompactionTarget;
	/** Exclusive end of the messages the causal view may show. */
	end: number;
}

export class ContinuousChatRuntime {
	readonly store: ContinuousChatStore;
	private readonly coordinator: ContinuousChatCompactionCoordinator;
	private readonly prefixHead: () => ContinuousChatCompactionPrefixHead;
	private readonly warn: (message: string) => void;
	/** Resolves once, when this runtime stops accepting work: at `stop()`, or when its lease is lost. Never rejects. */
	readonly stopped: Promise<void>;
	private resolveStopped: () => void = () => undefined;
	private readonly listeners = new Set<(event: ContinuousChatRuntimeEvent) => void>();
	private readonly jobs = new Map<string, Promise<void>>();
	private readonly abort = new AbortController();
	private serialTail: Promise<void> = Promise.resolve();
	private nextBoundaryId = 0;
	/** Advances on every runtime change. A waiter that observed an older value must re-check instead of sleeping. */
	private version = 0;
	private waiters: Array<() => void> = [];
	private started = false;
	private stopping = false;
	/** Set once the store reports its lease lost. Nothing is written after it; claimed work is left for recovery. */
	private leaseLost = false;
	private pumping = false;
	private pumpRequested = false;
	private pumpTask: Promise<void> = Promise.resolve();

	private constructor(options: ContinuousChatRuntimeOptions) {
		this.store = options.store;
		this.coordinator = new ContinuousChatCompactionCoordinator(options.port, options.store);
		this.prefixHead = options.prefixHead;
		this.warn = options.warn;
		this.stopped = new Promise<void>((resolve) => {
			this.resolveStopped = () => resolve();
		});
	}

	/**
	 * Takes the project's runtime lease, then runs startup recovery, which may requeue work a dead owner left claimed.
	 * Only one session per project may run the chat: a live or unprovable owner rejects this call once with
	 * `ContinuousChatLeaseHeldError`, and nothing is retried. Dispatch begins at `start()`. A lease lost later stops the
	 * runtime (see `handleLeaseLost`); `stop()` releases the lease.
	 */
	static async open(options: ContinuousChatRuntimeOptions): Promise<ContinuousChatRuntime> {
		const runtime = new ContinuousChatRuntime(options);
		await options.store.acquireRuntimeLease({ label: options.label, onLost: () => runtime.handleLeaseLost() });
		try {
			await options.store.recover();
		} catch (error) {
			await options.store.releaseRuntimeLease().catch((releaseError: unknown) => {
				options.warn(`Continuous-chat lease could not be released: ${safeErrorMessage(releaseError)}`);
			});
			throw error;
		}
		return runtime;
	}

	/** The only path that logs a message. */
	async append(input: ContinuousChatAppendInput): Promise<ContinuousChatAppendResult> {
		const [result] = await this.appendMany([input]);
		if (result === undefined) throw new TypeError("Continuous-chat append produced no result.");
		return result;
	}

	/** Logs up to CONTINUOUS_CHAT_MAX_BULK_INPUTS messages in one locked publication. A batch whose every unit is already logged is answered at once. */
	async appendMany(inputs: readonly ContinuousChatAppendInput[]): Promise<ContinuousChatAppendResult[]> {
		if (inputs.length === 0) return [];
		const answered = await this.answerIfLogged(inputs);
		if (answered !== undefined) return answered;
		return (await this.serial(() => this.tryAppend(inputs))).results;
	}

	/** Every unit of every input is already logged: the read-only answer. Undefined when any unit is new. */
	private async answerIfLogged(
		inputs: readonly ContinuousChatAppendInput[],
	): Promise<ContinuousChatAppendResult[] | undefined> {
		this.assertRunning();
		const logged: ContinuousChatRecord[][] = [];
		for (const input of inputs) {
			const records: ContinuousChatRecord[] = [];
			for (const unit of normalizeContinuousChatAppend(input)) {
				const record = await this.store.findBySourceKey(unit.sourceKey);
				if (record === undefined) return undefined;
				records.push(record);
			}
			logged.push(records);
		}
		const revision = await this.store.rootRevision();
		return logged.map((records) => ({ revision, records, deduplicated: true }));
	}

	/** Waits until every logged message has a built leaf, then snapshots the turn's view and boundary. Throws ContinuousChatPrefixUnavailableError when nothing is ready or running. */
	async reserveTurnBoundary(
		signal?: AbortSignal,
		onWaiting?: (progress: ContinuousChatPrefixWaitProgress) => void,
	): Promise<ContinuousChatTurnBoundary> {
		await this.store.noteArrival();
		this.requestPump();
		let first: { unbuilt: number; total: number } | undefined;
		let reported = "";
		for (;;) {
			this.assertRunning();
			signal?.throwIfAborted();
			const observed = this.version;
			const attempt = await this.serial(() => this.tryReserve());
			if (attempt.status === "reserved") return attempt.boundary;
			const { queue } = attempt;
			if (onWaiting !== undefined) {
				const unbuilt = continuousChatUnbuiltLeafCount(queue);
				first ??= { unbuilt, total: attempt.totalMessages };
				// Messages that arrive while waiting join the target, so `built` never exceeds `needed`.
				const needed = first.unbuilt + (attempt.totalMessages - first.total);
				const progress = {
					built: Math.max(0, needed - unbuilt),
					needed,
					failed: continuousChatFailedLeafCount(queue),
				};
				const key = `${progress.built}/${progress.needed}/${progress.failed}`;
				if (key !== reported) {
					reported = key;
					onWaiting(progress);
				}
			}
			if (queue.running.length === 0 && queue.readyLeaves.length === 0 && queue.readyParents.length === 0) {
				throw new ContinuousChatPrefixUnavailableError(this.failureReasons(queue));
			}
			await this.waitForChange(observed, signal);
		}
	}

	subscribe(listener: (event: ContinuousChatRuntimeEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	navigationSource(): ContinuousChatNavigationSource {
		return this.store;
	}

	start(): void {
		if (this.started || this.stopping) return;
		this.started = true;
		this.requestPump();
	}

	/**
	 * Aborts in-flight compactions, releases their claimed work, refuses further appends and turns, then releases the
	 * project lease. A lease already lost releases nothing.
	 */
	async stop(): Promise<void> {
		this.refuseWork();
		this.abort.abort();
		this.notifyChange();
		await this.pumpTask;
		await Promise.all([...this.jobs.values()]);
		await this.store.releaseRuntimeLease();
	}

	/**
	 * The store found its lease taken or removed. Dispatch stops and in-flight compactions are aborted. Their results
	 * and claims are not written, since the store refuses every write once the lease is lost.
	 */
	private handleLeaseLost(): void {
		if (this.leaseLost) return;
		this.leaseLost = true;
		this.refuseWork();
		this.abort.abort();
		this.notifyChange();
		this.warn("Continuous-chat runtime lease was lost; this session no longer runs the ICM chat.");
	}

	/** Stops accepting work. `stopped` resolves at the first call; later calls change nothing. */
	private refuseWork(): void {
		this.stopping = true;
		this.resolveStopped();
	}

	private assertRunning(): void {
		if (this.stopping) throw new Error("Continuous-chat runtime is stopped.");
	}

	/** Runs one runtime-level step at a time, in arrival order. Waiting never happens inside a step. */
	private serial<T>(run: () => Promise<T>): Promise<T> {
		const result = this.serialTail.then(run);
		this.serialTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async tryAppend(inputs: readonly ContinuousChatAppendInput[]): Promise<AppendAttempt> {
		this.assertRunning();
		// Ids are contiguous, so every id at or above the published count before this append is new.
		const firstNewId = await this.store.totalMessages();
		const results = await this.store.appendMany(inputs);
		for (const result of results) {
			for (const record of result.records) {
				if (record.id >= firstNewId) this.emit({ type: "message", id: record.id });
			}
		}
		this.requestPump();
		this.notifyChange();
		return { status: "appended", results };
	}

	private async tryReserve(): Promise<TurnAttempt> {
		const snapshot = await this.store.snapshotTurn();
		if (continuousChatBuiltLeafPrefix(snapshot.queue) < snapshot.totalMessages) {
			return { status: "waiting", queue: snapshot.queue, totalMessages: snapshot.totalMessages };
		}
		this.nextBoundaryId++;
		return { status: "reserved", boundary: this.boundaryFor(snapshot) };
	}

	private boundaryFor(snapshot: ContinuousChatTurnSnapshot): ContinuousChatTurnBoundary {
		return {
			boundaryId: this.nextBoundaryId,
			totalMessages: snapshot.totalMessages,
			viewRevision: snapshot.viewRevision,
			view: snapshot.view,
			release: () => undefined,
		};
	}

	/** The failures the waiting turn is blocked on, as persisted with the queue. */
	private failureReasons(queue: ContinuousChatWorkQueueState): string[] {
		return queue.blocked.map((entry) => entry.reason);
	}

	private notifyChange(): void {
		this.version++;
		const waiters = this.waiters;
		this.waiters = [];
		for (const wake of waiters) wake();
	}

	/** Resolves at the next change after `since`, or at once when a change already happened. Abort rejects. */
	private waitForChange(since: number, signal?: AbortSignal): Promise<void> {
		if (this.version !== since) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			if (signal?.aborted) {
				reject(signal.reason);
				return;
			}
			const onAbort = (): void => {
				this.waiters = this.waiters.filter((waiter) => waiter !== wake);
				reject(signal?.reason);
			};
			const wake = (): void => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			this.waiters.push(wake);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private emit(event: ContinuousChatRuntimeEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				this.warn(`Continuous-chat listener failed: ${safeErrorMessage(error, "unknown error")}`);
			}
		}
	}

	/** Starts a dispatch pass unless one is running. A pass that is running re-checks once more before it exits. */
	private requestPump(): void {
		if (!this.started || this.stopping) return;
		this.pumpRequested = true;
		if (this.pumping) return;
		this.pumping = true;
		this.pumpTask = this.drain();
	}

	private async drain(): Promise<void> {
		let fatal: unknown;
		try {
			do {
				this.pumpRequested = false;
				await this.claimReady();
			} while (this.pumpRequested && !this.stopping);
		} catch (error) {
			// A lost lease was already reported by `handleLeaseLost`.
			if (!this.leaseLost) {
				fatal = error;
				this.warn(`Continuous-chat dispatch failed: ${safeErrorMessage(error, "unknown error")}`);
				this.refuseWork();
				this.abort.abort(error);
				this.notifyChange();
			}
		} finally {
			this.pumping = false;
		}
		if (fatal !== undefined) {
			await Promise.all([...this.jobs.values()]);
			await this.store.releaseRuntimeLease().catch((releaseError: unknown) => {
				this.warn(
					`Continuous-chat lease could not be released after dispatch failure: ${safeErrorMessage(releaseError)}`,
				);
			});
		}
	}

	private async claimReady(): Promise<void> {
		while (!this.stopping && this.jobs.size < CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS) {
			const item = await this.store.claimWork();
			if (item === undefined) {
				if (this.jobs.size === 0) this.emit({ type: "idle" });
				return;
			}
			if (this.stopping) {
				// After a lost lease the claim stays persisted for the next owner's recovery to requeue.
				if (!this.leaseLost) await this.store.releaseWork(item);
				return;
			}
			this.startJob(item);
		}
	}

	private startJob(item: ContinuousChatWorkItem): void {
		const key = continuousChatWorkItemKey(item);
		// `finally` runs after the job is registered, so the map entry is always present when it is removed.
		const job = this.runJob(item).finally(() => {
			this.jobs.delete(key);
			this.notifyChange();
			this.requestPump();
		});
		this.jobs.set(key, job);
	}

	private async runJob(item: ContinuousChatWorkItem): Promise<void> {
		try {
			await this.settle(item, await this.compact(item));
		} catch (error) {
			await this.abandon(item, error).catch((secondary: unknown) => {
				const label = continuousChatNodeLabel(item);
				this.warn(`Continuous-chat work ${label} could not be recorded: ${safeErrorMessage(secondary)}`);
			});
		}
	}

	private async compact(item: ContinuousChatWorkItem): Promise<ContinuousChatCompactionOutcome> {
		const { target, end } = await this.causalTarget(item);
		const causal = await this.store.readCausalPrefix(end);
		const head = this.prefixHead();
		return this.coordinator.run({
			target,
			prefix: { systemPrompt: head.systemPrompt, tools: head.tools, view: causal.text },
			signal: this.abort.signal,
		});
	}

	private async causalTarget(item: ContinuousChatWorkItem): Promise<CausalTarget> {
		if (item.level === 0) {
			const record = await this.store.readMessageById(item.ordinal);
			if (record === undefined) throw new Error(`Continuous-chat message ${item.ordinal} is not logged.`);
			return { target: { kind: "leaf", record }, end: record.id };
		}
		const leftCoordinate = { level: item.level - 1, ordinal: item.ordinal * 2 };
		const rightCoordinate = { level: item.level - 1, ordinal: item.ordinal * 2 + 1 };
		const left = await this.store.readNode(leftCoordinate);
		const right = await this.store.readNode(rightCoordinate);
		if (left === undefined || right === undefined) {
			throw new Error(`Continuous-chat children of ${continuousChatNodeLabel(item)} are not built.`);
		}
		const firstMessage = continuousChatNodeFirstMessage(rightCoordinate);
		const end = firstMessage + continuousChatNodeMessageCount(rightCoordinate.level);
		return { target: { kind: "merge", left, right }, end };
	}

	private async settle(item: ContinuousChatWorkItem, outcome: ContinuousChatCompactionOutcome): Promise<void> {
		// After a lost lease the store refuses every write: the outcome is dropped and the claim left for recovery.
		if (this.leaseLost) return;
		switch (outcome.status) {
			case "published":
				if (outcome.existing) {
					// The node was already in the tree, so the sink never completed this item.
					await this.store.completeWork(item);
				} else {
					this.emit({ type: "node", level: item.level, ordinal: item.ordinal });
				}
				return;
			case "failed":
				await this.fail(item, outcome.message);
				return;
			case "cancelled":
				await this.store.releaseWork(item);
				return;
		}
	}

	private async fail(item: ContinuousChatWorkItem, reason: string): Promise<void> {
		await this.store.failWork(item, reason);
		this.warn(`Continuous-chat compaction ${continuousChatNodeLabel(item)} failed: ${reason}`);
		this.emit({ type: "failed", item, reason });
	}

	private async abandon(item: ContinuousChatWorkItem, error: unknown): Promise<void> {
		if (this.leaseLost) return;
		if (this.abort.signal.aborted) {
			await this.store.releaseWork(item);
			return;
		}
		await this.fail(item, safeErrorMessage(error, "Continuous-chat compaction failed."));
	}
}
