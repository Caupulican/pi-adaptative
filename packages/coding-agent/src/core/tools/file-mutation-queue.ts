import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isMissingPathError } from "../util/filesystem-errors.ts";

/** Share this object across cooperating controllers on one backend. Keys are backend-canonical identities. */
export interface FileMutationQueueBackend {
	resolveKey(filePath: string): Promise<string>;
}

interface BackendQueueState {
	queues: Map<string, Promise<void>>;
	registration: Promise<void>;
}
const backendQueues = new WeakMap<FileMutationQueueBackend, BackendQueueState>();

// Readers-writer barrier shared by every file mutation (reader) and exclusive bash
// run (writer). File tools stay parallel with each other on different files; bash
// cannot statically declare which files a command touches, so it takes the coarse
// writer lock instead of a per-file one.
let activeReaders = 0;
let readersDrained: (() => void) | undefined;
/** Resolves when the exclusive run at the head of the queue RELEASES the writer lock. */
let writerQueue: Promise<void> = Promise.resolve();
let writerActive: Promise<void> | undefined;

/**
 * Rejects with the signal's reason when it aborts. `dispose` detaches the listener, so a waiter that
 * finished before the abort leaves nothing armed behind it.
 */
function abortRejection(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
	let onAbort!: () => void;
	const promise = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	// Every waiter races this promise and rethrows the reason itself; marking it handled keeps a lost
	// race (the wait finished first, the run aborts later) from surfacing as an unhandled rejection.
	promise.catch(() => undefined);
	return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}

/** Await `promise`, but stop waiting and throw the signal's reason the moment it aborts. */
async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw signal.reason;
	const watch = abortRejection(signal);
	try {
		return await Promise.race([promise, watch.promise]);
	} finally {
		watch.dispose();
	}
}

/**
 * Emission-order bookkeeping for one assistant message's tool-call wave.
 *
 * The barrier's contract - "an exclusive run waits for in-flight file mutations to drain" - is only
 * meaningful if "in-flight" means "emitted before me". A mutation tool joins the reader side deep
 * inside its own execute, after its lease/credential preflight, so a sibling exclusive run
 * dispatched in the same parallel batch reaches the writer lock first and sees no reader at all.
 * Live, `[write rotina.json, bash "tfps run rotina"]` ran the command before the file existed.
 *
 * The host therefore ANNOUNCES every reserved call with its emission index before any body in the
 * wave starts. An exclusive run waits for every earlier-emitted mutation either to join the reader
 * side (`joined`, from then on the reader count covers it) or to be retired at its terminal, before
 * it takes the writer lock. A call nobody announced keeps the pre-announcement behavior.
 */
interface ToolCallAnnouncement {
	/** 0-based position of the call in its assistant message's tool calls. */
	index: number;
	/** True when this call's tool declared a file it will mutate. */
	mutation: boolean;
	/** True once this call's mutation joined the reader side: `activeReaders` covers it from then on. */
	joined: boolean;
	/** Reservation wave identity, when the host supplies one. */
	batchId: string | undefined;
}

const toolCallAnnouncements = new Map<string, ToolCallAnnouncement>();
let announcedBatchId: string | undefined;

interface EarlierMutationWaiter {
	index: number;
	resolve: () => void;
}
const earlierMutationWaiters = new Set<EarlierMutationWaiter>();

function hasPendingMutationBefore(index: number): boolean {
	for (const announcement of toolCallAnnouncements.values()) {
		if (announcement.mutation && !announcement.joined && announcement.index < index) return true;
	}
	return false;
}

function releaseClearedWaiters(): void {
	for (const waiter of [...earlierMutationWaiters]) {
		if (hasPendingMutationBefore(waiter.index)) continue;
		earlierMutationWaiters.delete(waiter);
		waiter.resolve();
	}
}

/**
 * Record a reserved tool call at its emission position, before any body in the wave starts.
 *
 * `mutation` marks a call whose tool declared a file mutation target: only those are waited for.
 * Every other reserved call is still announced, because that is how an exclusive run learns its own
 * emission index. `batchId` names the reservation wave; a wave with a new identity retires whatever
 * the previous one left behind, which can never join any more - its results already produced the
 * assistant message this wave belongs to.
 */
export function announceToolCall(callId: string, index: number, mutation: boolean, batchId?: string): void {
	if (batchId !== undefined && batchId !== announcedBatchId) {
		for (const [announcedCallId, announcement] of toolCallAnnouncements) {
			if (announcement.batchId !== batchId) toolCallAnnouncements.delete(announcedCallId);
		}
		announcedBatchId = batchId;
	}
	toolCallAnnouncements.set(callId, { index, mutation, joined: false, batchId });
	releaseClearedWaiters();
}

/**
 * Drop a call's announcement at its terminal, whether or not a mutation ever joined. An aborted or
 * preflight-rejected write must never park a later exclusive sibling for the rest of the batch.
 */
export function retireToolCall(callId: string): void {
	if (!toolCallAnnouncements.delete(callId)) return;
	releaseClearedWaiters();
}

function joinAnnouncedMutation(callId: string | undefined): void {
	if (callId === undefined) return;
	const announcement = toolCallAnnouncements.get(callId);
	if (!announcement || announcement.joined) return;
	announcement.joined = true;
	releaseClearedWaiters();
}

/**
 * Wait until no mutation announced EARLIER than `callId` is still pending. Returns at once for a
 * call that was never announced, so a host that does not announce sees today's behavior.
 */
export async function waitForAnnouncedMutations(callId: string | undefined, signal?: AbortSignal): Promise<void> {
	if (callId === undefined) return;
	const announcement = toolCallAnnouncements.get(callId);
	if (!announcement || !hasPendingMutationBefore(announcement.index)) return;
	let waiter!: EarlierMutationWaiter;
	const cleared = new Promise<void>((resolveCleared) => {
		waiter = { index: announcement.index, resolve: resolveCleared };
		earlierMutationWaiters.add(waiter);
	});
	try {
		await raceAbort(cleared, signal);
	} finally {
		earlierMutationWaiters.delete(waiter);
	}
}

async function acquireReader(signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw signal.reason;
	// No writer holds or is draining: join immediately (synchronously counted, so a writer that
	// starts checking activeReaders right after can never miss this join).
	if (!writerActive) {
		activeReaders++;
		return;
	}
	// A writer holds (or is waiting to): wait for it to fully release before joining.
	await raceAbort(writerActive, signal);
	activeReaders++;
}

function releaseReader(): void {
	activeReaders--;
	if (activeReaders === 0 && readersDrained) {
		const drained = readersDrained;
		readersDrained = undefined;
		drained();
	}
}

interface ExclusiveHold {
	/** Releases the writer lock and hands the queue on. Set once the run reaches the head of the queue. */
	release?: () => void;
	/** True while the run has not yet reached the head of the exclusive queue. */
	queued: boolean;
	/** Set on a still-queued run: when its turn comes it runs `fn` without taking the lock at all. */
	lockless: boolean;
	/** True once the hold has been released early, or its `fn` has settled: nothing left to release. */
	done: boolean;
}

/** Live exclusive runs that named themselves, keyed by hold id (the tool call id). */
const exclusiveHolds = new Map<string, ExclusiveHold>();

/**
 * Run fn exclusively: waits for all in-flight (running or queued) file mutations to
 * drain, then blocks new ones and other exclusive runs until fn settles. Exclusive
 * runs themselves queue FIFO against each other.
 *
 * `options.signal` makes the WAIT cancellable: an abort while the run is still queued (or still
 * waiting for readers to drain) rejects at once with the signal's reason, never runs fn, and frees
 * the queue position. `options.holdId` names the run so {@link releaseExclusiveHold} can stop it
 * holding the barrier while its work keeps running.
 */
export function withExclusiveMutationBarrier<T>(
	fn: () => Promise<T>,
	options?: { signal?: AbortSignal; holdId?: string },
): Promise<T> {
	const signal = options?.signal;
	// Already cancelled before it queued: nothing to schedule, and no position to release.
	if (signal?.aborted) return Promise.reject(signal.reason);
	const holdId = options?.holdId;
	const hold: ExclusiveHold = { queued: true, lockless: false, done: false };
	if (holdId !== undefined) exclusiveHolds.set(holdId, hold);
	const unregister = (): void => {
		hold.done = true;
		hold.release = undefined;
		if (holdId !== undefined && exclusiveHolds.get(holdId) === hold) exclusiveHolds.delete(holdId);
	};

	const predecessor = writerQueue;
	let handOnQueue!: () => void;
	const queueHandedOn = new Promise<void>((resolveHandOn) => {
		handOnQueue = resolveHandOn;
	});
	// The queue advances when this run releases the writer lock, not when fn settles: a handed-off
	// command keeps running long after it stops being exclusive (see releaseExclusiveHold). Both
	// handlers are given so the chain itself never rejects.
	writerQueue = predecessor.then(
		() => queueHandedOn,
		() => queueHandedOn,
	);

	return (async () => {
		try {
			await raceAbort(predecessor, signal);
		} catch (error) {
			hold.queued = false;
			handOnQueue();
			unregister();
			throw error;
		}
		hold.queued = false;
		// Emission order, before the writer lock is taken: an exclusive run must not outrun a file
		// mutation its own batch emitted earlier but that has not reached the reader side yet. This
		// wait has to happen BEFORE `writerActive` is set, or the mutation it is waiting for would
		// park in `acquireReader` behind this very run.
		try {
			await waitForAnnouncedMutations(holdId, signal);
		} catch (error) {
			handOnQueue();
			unregister();
			throw error;
		}
		if (hold.lockless) {
			// Released while still queued: the run no longer claims exclusivity, so it never takes the
			// writer lock and the queue moves on at once.
			handOnQueue();
			try {
				return await fn();
			} finally {
				unregister();
			}
		}
		let releaseWriter!: () => void;
		const active = new Promise<void>((resolveWriter) => {
			releaseWriter = resolveWriter;
		});
		writerActive = active;
		let lockHeld = true;
		const release = (): void => {
			if (!lockHeld) return;
			lockHeld = false;
			if (writerActive === active) writerActive = undefined;
			releaseWriter();
			handOnQueue();
		};
		hold.release = release;
		try {
			if (activeReaders > 0) {
				let drained!: () => void;
				const drain = new Promise<void>((resolveDrain) => {
					drained = resolveDrain;
					readersDrained = resolveDrain;
				});
				try {
					await raceAbort(drain, signal);
				} catch (error) {
					// An abandoned drain wait must not leave its resolver armed for the next reader.
					if (readersDrained === drained) readersDrained = undefined;
					throw error;
				}
			}
			return await fn();
		} finally {
			release();
			unregister();
		}
	})();
}

/**
 * Stop holding the exclusive barrier for `holdId` while its command keeps running.
 *
 * A handed-off command is a detached session task: it has already answered the batch that started
 * it, so it must not keep every file mutation and every sibling exclusive run parked behind it for
 * the rest of its life. Returns true when this call released a hold that was still holding the
 * writer lock or still queued; false for an unknown, already-released or already-settled hold.
 */
export function releaseExclusiveHold(holdId: string): boolean {
	const hold = exclusiveHolds.get(holdId);
	if (!hold || hold.done) return false;
	if (hold.queued) {
		hold.done = true;
		hold.lockless = true;
		return true;
	}
	const release = hold.release;
	if (!release) return false;
	hold.done = true;
	hold.release = undefined;
	release();
	return true;
}

async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	try {
		return await realpath(resolvedPath);
	} catch (error) {
		if (isMissingPathError(error)) {
			return resolvedPath;
		}
		throw error;
	}
}

export const localFileMutationQueueBackend: FileMutationQueueBackend = Object.freeze({
	resolveKey: getMutationQueueKey,
});

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(
	filePath: string,
	fn: () => Promise<T>,
	backend: FileMutationQueueBackend = localFileMutationQueueBackend,
	options?: { signal?: AbortSignal; callId?: string },
): Promise<T> {
	let state = backendQueues.get(backend);
	if (!state) {
		state = { queues: new Map(), registration: Promise.resolve() };
		backendQueues.set(backend, state);
	}
	const queues = state.queues;
	const registration = state.registration.then(async () => {
		const key = await backend.resolveKey(filePath);
		if (typeof key !== "string" || key.length === 0)
			throw new Error("Mutation backend returned an invalid resource identity.");
		const currentQueue = queues.get(key) ?? Promise.resolve();

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		queues.set(key, chainedQueue);

		return { key, currentQueue, chainedQueue, releaseNext };
	});
	state.registration = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	let joinedReaders = false;
	try {
		// Join the reader side as soon as this call is admitted, before waiting on the
		// per-file queue: a mutation already queued behind another on the same file must
		// still count as in-flight for the exclusive barrier, not just the one executing.
		await acquireReader(options?.signal);
		joinedReaders = true;
		// The announcement this call was reserved with stops being "pending" exactly here: the reader
		// count now covers it, so an exclusive run waiting on it can stop waiting and start draining.
		joinAnnouncedMutation(options?.callId);
		await currentQueue;
		return await fn();
	} finally {
		// A cancelled wait never joined the reader side; releasing it would credit a reader that was
		// never counted and let an exclusive run start while others are still in flight.
		if (joinedReaders) releaseReader();
		releaseNext();
		if (queues.get(key) === chainedQueue) {
			queues.delete(key);
		}
	}
}
