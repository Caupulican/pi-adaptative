/**
 * Dispatch and turn boundaries for the permanent chat. The store owns every durable transition. This runtime claims
 * work, runs compactions, maps their outcomes back to the store, and admits appends and turn snapshots in order.
 * Root turns snapshot the available view without waiting for summary calls. Pending references remain readable
 * through zoom while the background work queue catches up.
 */

import { safeErrorMessage } from "../../kernel/types.ts";
import { AsyncRetainedReleases, type ReleaseOutcome, releaseFailureCause } from "../util/resource-release.ts";
import { SYSTEM_TIMER_PORT, type TimerPort } from "../util/timer-port.ts";
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
import type { ContinuousChatClaim } from "./continuous-chat-scheduler.ts";
import type { ContinuousChatStore, ContinuousChatTurnSnapshot } from "./continuous-chat-store.ts";
import {
	continuousChatNodeFirstMessage,
	continuousChatNodeLabel,
	continuousChatNodeMessageCount,
} from "./continuous-chat-tree.ts";
import {
	CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS,
	type ContinuousChatWorkAbandonment,
	type ContinuousChatWorkItem,
	continuousChatWorkItemKey,
} from "./continuous-chat-work-queue.ts";

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
	/** Retained work-claim releases' backoff; absent means `SYSTEM_TIMER_PORT`. */
	timers?: TimerPort;
}

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
	private started = false;
	private stopping = false;
	/** Set once the store reports its lease lost. Nothing is written after it; claimed work is left for recovery. */
	private leaseLost = false;
	private pumping = false;
	private pumpRequested = false;
	private pumpTask: Promise<void> = Promise.resolve();
	/**
	 * Claims whose release or failure record could not be written. The queue still counts each one as running, so a
	 * leaked claim would hold a compaction slot for good: each is retried on a backoff and on every dispatch pass, and
	 * a success wakes background dispatch.
	 */
	private readonly workReleases: AsyncRetainedReleases<{
		readonly item: ContinuousChatClaim;
		readonly abandonment: ContinuousChatWorkAbandonment;
	}>;

	private constructor(options: ContinuousChatRuntimeOptions) {
		this.store = options.store;
		this.coordinator = new ContinuousChatCompactionCoordinator(options.port, options.store);
		this.prefixHead = options.prefixHead;
		this.warn = options.warn;
		this.stopped = new Promise<void>((resolve) => {
			this.resolveStopped = () => resolve();
		});
		this.workReleases = new AsyncRetainedReleases({
			retryOwner: "continuous-chat runtime",
			timers: options.timers ?? SYSTEM_TIMER_PORT,
			release: async ({ item, abandonment }) => {
				// After a lost lease the store refuses every write: the next owner's startup recovery requeues the claim.
				if (this.leaseLost)
					return { abandoned: "the runtime lease was lost", reaper: "the next owner's startup recovery" };
				await this.recordAbandonment(item, abandonment);
				return "released";
			},
			reportFailure: (entry, error) =>
				this.warn(
					`Continuous-chat work ${continuousChatNodeLabel(entry.value.item)} could not be recorded again: ${releaseFailureCause(error)}`,
				),
			reportListenerFailure: (error) =>
				this.warn(`Continuous-chat work release wake failed: ${safeErrorMessage(error, "unknown error")}`),
		});
		// A recorded claim frees its slot for background dispatch.
		this.workReleases.subscribe(() => this.requestPump());
	}

	/**
	 * Takes the project's runtime lease, then runs startup recovery, which may requeue work a dead owner left claimed.
	 * Only one session per project may run the chat: a live or unprovable owner rejects this call once with
	 * `ContinuousChatLeaseHeldError`, and nothing is retried. Dispatch begins at `start()`. A lease lost later stops the
	 * runtime (see `handleLeaseLost`); `stop()` releases the lease.
	 */
	static async open(options: ContinuousChatRuntimeOptions, signal?: AbortSignal): Promise<ContinuousChatRuntime> {
		signal?.throwIfAborted();
		const runtime = new ContinuousChatRuntime(options);
		await options.store.acquireRuntimeLease(
			{ label: options.label, onLost: () => runtime.handleLeaseLost() },
			signal,
		);
		try {
			signal?.throwIfAborted();
			await options.store.recover(signal);
			signal?.throwIfAborted();
		} catch (error) {
			runtime.reportLeaseRelease(await options.store.releaseRuntimeLease(), "after a failed recovery");
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

	/**
	 * Pins the available persisted view in append order. Summary readiness is not root-turn readiness: the view
	 * represents unbuilt nodes with pending references, and zoom can read their original messages immediately.
	 * A new turn releases failed background work for retry but never joins those model calls.
	 */
	async reserveTurnBoundary(signal?: AbortSignal): Promise<ContinuousChatTurnBoundary> {
		this.assertRunning();
		signal?.throwIfAborted();
		await this.store.noteArrival();
		this.assertRunning();
		signal?.throwIfAborted();
		this.requestPump();
		return this.serial(async () => {
			this.assertRunning();
			signal?.throwIfAborted();
			const snapshot = await this.store.snapshotTurn();
			this.assertRunning();
			signal?.throwIfAborted();
			this.nextBoundaryId++;
			return this.boundaryFor(snapshot);
		});
	}

	/**
	 * Makes failed work retry-eligible and dispatches it, as an arrival with no turn: used when a refused summary model
	 * becomes usable again. A stopped runtime has nothing to retry; a lost lease was already reported.
	 */
	async retryFailedWork(): Promise<void> {
		if (this.stopping) return;
		try {
			await this.store.noteArrival();
		} catch (error) {
			if (this.leaseLost) return;
			throw error;
		}
		this.requestPump();
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
		await this.pumpTask;
		await Promise.all([...this.jobs.values()]);
		// Last pass for claims that could not be recorded; one still unrecorded stays claimed for the next owner's recovery.
		this.workReleases.close();
		const unrecorded = await this.workReleases.retry({ report: false, lastChance: true });
		if (unrecorded.length > 0) {
			this.warn(
				`Continuous-chat stopped with ${this.workReleases.size} claimed work item(s) it could not record (${this.workReleases
					.entriesSnapshot()
					.map((entry) => `${continuousChatNodeLabel(entry.value.item)}: ${entry.cause}`)
					.join("; ")}); the next owner's startup recovery requeues them.`,
			);
		}
		this.reportLeaseRelease(await this.store.releaseRuntimeLease(), "at stop");
	}

	/** A lease release that did not complete is retained by the store (its exit hook stays); say so once. */
	private reportLeaseRelease(outcome: ReleaseOutcome, when: string): void {
		if (outcome.kind === "retained") {
			this.warn(
				`Continuous-chat lease could not be released ${when} (${outcome.cause}); its removal is retried, and it is removed at process exit.`,
			);
		} else if (outcome.kind === "superseded") {
			this.warn(`Continuous-chat lease was not released ${when}: ${outcome.detail}.`);
		}
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
		return { status: "appended", results };
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
			}
		} finally {
			this.pumping = false;
		}
		if (fatal !== undefined) {
			await Promise.all([...this.jobs.values()]);
			this.reportLeaseRelease(await this.store.releaseRuntimeLease(), "after dispatch failure");
		}
	}

	private async claimReady(): Promise<void> {
		// A claim that could not be recorded still holds its slot: every dispatch pass retries it first.
		if (this.workReleases.size > 0) await this.workReleases.retry({ report: false });
		while (!this.stopping && this.jobs.size < CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS) {
			const item = await this.store.claimWork();
			if (item === undefined) {
				if (this.jobs.size === 0) this.emit({ type: "idle" });
				return;
			}
			if (this.stopping) {
				// After a lost lease the claim stays persisted for the next owner's recovery to requeue.
				if (!this.leaseLost) await this.recordOrRetain(item, { kind: "release" });
				return;
			}
			this.startJob(item);
		}
	}

	private startJob(item: ContinuousChatClaim): void {
		const key = continuousChatWorkItemKey(item);
		// `finally` runs after the job is registered, so the map entry is always present when it is removed.
		const job = this.runJob(item).finally(() => {
			this.jobs.delete(key);
			this.requestPump();
		});
		this.jobs.set(key, job);
	}

	private async runJob(item: ContinuousChatClaim): Promise<void> {
		try {
			await this.settle(item, await this.compact(item));
		} catch (error) {
			// After a lost lease the store refuses every write: the claim is left for recovery.
			if (this.leaseLost) return;
			await this.recordOrRetain(
				item,
				this.abort.signal.aborted
					? { kind: "release" }
					: { kind: "fail", reason: safeErrorMessage(error, "Continuous-chat compaction failed.") },
			);
		}
	}

	/** Records how a claim ended; a record that cannot be written is retained, so the claim never leaks its slot. */
	private async recordOrRetain(item: ContinuousChatClaim, abandonment: ContinuousChatWorkAbandonment): Promise<void> {
		try {
			await this.recordAbandonment(item, abandonment);
		} catch (error) {
			const key = continuousChatWorkItemKey(item);
			if (this.workReleases.closed) {
				this.warn(
					`Continuous-chat work ${continuousChatNodeLabel(item)} could not be recorded: ${safeErrorMessage(error)}; the next owner's startup recovery requeues it.`,
				);
				return;
			}
			this.workReleases.retain(key, { item, abandonment }, error);
			this.warn(
				`Continuous-chat work ${continuousChatNodeLabel(item)} could not be recorded; retrying: ${safeErrorMessage(error)}`,
			);
		}
	}

	private async recordAbandonment(
		item: ContinuousChatClaim,
		abandonment: ContinuousChatWorkAbandonment,
	): Promise<void> {
		const settlement =
			abandonment.kind === "release"
				? await this.store.releaseWork(item)
				: await this.store.failWork(item, abandonment.reason);
		if (settlement === "published") {
			this.emit({ type: "node", level: item.level, ordinal: item.ordinal });
		} else if (abandonment.kind === "fail") {
			this.warn(`Continuous-chat compaction ${continuousChatNodeLabel(item)} failed: ${abandonment.reason}`);
			this.emit({ type: "failed", item, reason: abandonment.reason });
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

	private async settle(item: ContinuousChatClaim, outcome: ContinuousChatCompactionOutcome): Promise<void> {
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
				await this.recordOrRetain(item, { kind: "fail", reason: outcome.message });
				return;
			case "cancelled":
				await this.recordOrRetain(item, { kind: "release" });
				return;
		}
	}
}
