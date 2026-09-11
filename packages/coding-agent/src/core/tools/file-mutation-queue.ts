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

/**
 * Group lock shared by file mutations and command runs.
 *
 * File tools stay parallel with each other on different files; a shell command cannot statically
 * declare which files it touches, so it takes this coarse lock instead of a per-file one. What the
 * lock arbitrates is GROUPS, not individual callers:
 *
 * - `mutation` - a file mutation. Mutations hold the lock together (per-file ordering is the
 *   separate per-path queue below).
 * - `shell` - a command run the host announced. Announced command runs hold the lock together, so a
 *   wave of commands the model emitted in one message actually runs together on the shell lane pool.
 * - `exclusive` - a command run nobody announced. It holds the lock alone, which is what every
 *   caller saw before the group lock existed.
 *
 * Admission is strictly in arrival order: the first waiter that cannot share with the current
 * holders stops admission until they drain, so a continuous stream of one group can never starve
 * the other.
 */
type LockGroup = "mutation" | "shell" | "exclusive";

let lockHolders: { readonly group: LockGroup; count: number } | undefined;

interface LockWaiter {
	group: LockGroup;
	admit: () => void;
	/** Detaches the abort listener, so a waiter admitted normally leaves nothing armed behind it. */
	detach: () => void;
}

const lockWaiters: LockWaiter[] = [];
/** Armed by runs that gave up the lock but must still not start in the middle of somebody's write. */
const mutationDrainWaiters = new Set<() => void>();

function groupsShareTheLock(waiting: LockGroup, holding: LockGroup): boolean {
	return waiting === holding && waiting !== "exclusive";
}

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

/** Admit every waiter at the front of the queue that can share the lock with the current holders. */
function pumpLock(): void {
	while (lockWaiters.length > 0) {
		const head = lockWaiters[0];
		if (lockHolders && !groupsShareTheLock(head.group, lockHolders.group)) return;
		lockWaiters.shift();
		head.detach();
		if (lockHolders) lockHolders.count += 1;
		else lockHolders = { group: head.group, count: 1 };
		head.admit();
	}
}

/**
 * Join `group`. Joins synchronously when the lock is free or already held by the same group and
 * nobody is queued, so a run that starts checking the holders right after can never miss this join.
 */
function acquireLock(group: LockGroup, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason);
	if (lockWaiters.length === 0 && (!lockHolders || groupsShareTheLock(group, lockHolders.group))) {
		if (lockHolders) lockHolders.count += 1;
		else lockHolders = { group, count: 1 };
		return Promise.resolve();
	}
	return new Promise<void>((admit, reject) => {
		let waiter!: LockWaiter;
		const onAbort = (): void => {
			const position = lockWaiters.indexOf(waiter);
			if (position !== -1) lockWaiters.splice(position, 1);
			reject(signal?.reason);
			// The abandoned position may have been the one blocking everything behind it.
			pumpLock();
		};
		waiter = { group, admit, detach: () => signal?.removeEventListener("abort", onAbort) };
		lockWaiters.push(waiter);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function releaseLock(): void {
	if (!lockHolders) return;
	lockHolders.count -= 1;
	if (lockHolders.count > 0) return;
	const released = lockHolders.group;
	lockHolders = undefined;
	if (released === "mutation") {
		// Resolve from a snapshot: each waiter removes its own entry when it wakes.
		const waiters = [...mutationDrainWaiters];
		mutationDrainWaiters.clear();
		for (const waiter of waiters) waiter();
	}
	pumpLock();
}

/**
 * Wait until no file mutation holds the lock. Aborting the wait removes this waiter, so an abandoned
 * wait never leaves a resolver armed for the next drain.
 */
async function waitForMutationsToDrain(signal: AbortSignal | undefined): Promise<void> {
	if (lockHolders?.group !== "mutation") return;
	let waiter!: () => void;
	const drained = new Promise<void>((resolveDrained) => {
		waiter = resolveDrained;
		mutationDrainWaiters.add(waiter);
	});
	try {
		await raceAbort(drained, signal);
	} finally {
		mutationDrainWaiters.delete(waiter);
	}
}

/**
 * Emission-order bookkeeping for one assistant message's tool-call wave.
 *
 * The group lock's contract - "a command run and a file mutation never overlap" - is only meaningful
 * if the two are ordered the way the model emitted them. A mutation tool joins the lock deep inside
 * its own execute, after its lease/credential preflight, so a sibling command run dispatched in the
 * same parallel batch reaches the lock first and sees no mutation at all. Live,
 * `[write rotina.json, bash "tfps run rotina"]` ran the command before the file existed.
 *
 * The host therefore ANNOUNCES every reserved call with its emission index before any body in the
 * wave starts. Fairness is that index, in both directions: a command run waits for every
 * earlier-emitted mutation, and a mutation waits for every earlier-emitted command run, until that
 * call either joins the lock (from then on the holders cover it) or reaches its terminal. A call
 * nobody announced keeps the pre-announcement behavior.
 */
export type ToolCallKind = "mutation" | "shell" | "other";

interface ToolCallAnnouncement {
	/** 0-based position of the call in its assistant message's tool calls. */
	index: number;
	/** What this call does to the workspace, as far as the host and the call itself have declared. */
	kind: ToolCallKind;
	/** True once this call joined the lock, or can never join it any more. */
	joined: boolean;
	/** Reservation wave identity, when the host supplies one. */
	batchId: string | undefined;
}

const toolCallAnnouncements = new Map<string, ToolCallAnnouncement>();
let announcedBatchId: string | undefined;

interface EarlierCallWaiter {
	index: number;
	awaited: ToolCallKind;
	resolve: () => void;
}
const earlierCallWaiters = new Set<EarlierCallWaiter>();

function hasPendingCallBefore(index: number, kind: ToolCallKind): boolean {
	for (const announcement of toolCallAnnouncements.values()) {
		if (announcement.kind === kind && !announcement.joined && announcement.index < index) return true;
	}
	return false;
}

function releaseClearedWaiters(): void {
	for (const waiter of [...earlierCallWaiters]) {
		if (hasPendingCallBefore(waiter.index, waiter.awaited)) continue;
		earlierCallWaiters.delete(waiter);
		waiter.resolve();
	}
}

/**
 * Record a reserved tool call at its emission position, before any body in the wave starts.
 *
 * `kind` says what the call does: `"mutation"` (or the legacy `true`) for a call whose tool declared
 * a file mutation target, `"shell"` for a command run, `"other"` (or the legacy `false`) for
 * anything else. Every reserved call is announced, because that is how a command run learns its own
 * emission index; a run announced as `"other"` declares itself a shell run when it takes the lock.
 * `batchId` names the reservation wave; a wave with a new identity retires whatever the previous one
 * left behind, which can never join any more - its results already produced the assistant message
 * this wave belongs to.
 */
export function announceToolCall(callId: string, index: number, kind: boolean | ToolCallKind, batchId?: string): void {
	const resolvedKind: ToolCallKind = typeof kind === "boolean" ? (kind ? "mutation" : "other") : kind;
	if (batchId !== undefined && batchId !== announcedBatchId) {
		for (const [announcedCallId, announcement] of toolCallAnnouncements) {
			if (announcement.batchId !== batchId) toolCallAnnouncements.delete(announcedCallId);
		}
		announcedBatchId = batchId;
	}
	toolCallAnnouncements.set(callId, { index, kind: resolvedKind, joined: false, batchId });
	releaseClearedWaiters();
}

/**
 * Drop a call's announcement at its terminal, whether or not it ever joined the lock. An aborted or
 * preflight-rejected write must never park a later command run for the rest of the batch.
 */
export function retireToolCall(callId: string): void {
	if (!toolCallAnnouncements.delete(callId)) return;
	releaseClearedWaiters();
}

/** The announcement stops being "pending": it joined the lock, or it never will. */
function markAnnouncementJoined(callId: string | undefined): void {
	if (callId === undefined) return;
	const announcement = toolCallAnnouncements.get(callId);
	if (!announcement || announcement.joined) return;
	announcement.joined = true;
	releaseClearedWaiters();
}

/**
 * Declare an announced call a command run. Taking the group lock is the declaration: only the run
 * itself knows it is one, since the host announces a command exactly like any other non-mutating
 * tool. Returns false for a call nobody announced, which keeps the pre-announcement behavior.
 */
function declareAnnouncedShellRun(callId: string | undefined): boolean {
	if (callId === undefined) return false;
	const announcement = toolCallAnnouncements.get(callId);
	if (!announcement || announcement.kind === "mutation") return false;
	announcement.kind = "shell";
	return true;
}

/**
 * Wait until no call of `awaited` announced EARLIER than `callId` is still pending. Returns at once
 * for a call that was never announced, so a host that does not announce sees today's behavior.
 */
async function waitForEarlierAnnouncedCalls(
	callId: string | undefined,
	awaited: ToolCallKind,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (callId === undefined) return;
	const announcement = toolCallAnnouncements.get(callId);
	if (!announcement || !hasPendingCallBefore(announcement.index, awaited)) return;
	let waiter!: EarlierCallWaiter;
	const cleared = new Promise<void>((resolveCleared) => {
		waiter = { index: announcement.index, awaited, resolve: resolveCleared };
		earlierCallWaiters.add(waiter);
	});
	try {
		await raceAbort(cleared, signal);
	} finally {
		earlierCallWaiters.delete(waiter);
	}
}

/** Wait until no mutation announced EARLIER than `callId` is still pending. */
export function waitForAnnouncedMutations(callId: string | undefined, signal?: AbortSignal): Promise<void> {
	return waitForEarlierAnnouncedCalls(callId, "mutation", signal);
}

interface ExclusiveHold {
	/** Releases this run's place in the lock. Set once the run has actually joined. */
	release?: () => void;
	/** True while the run has not joined the lock yet. */
	queued: boolean;
	/** Set on a still-queued run: when its turn comes it runs `fn` without holding the lock at all. */
	lockless: boolean;
	/** True once the hold has been released early, or its `fn` has settled: nothing left to release. */
	done: boolean;
}

/** Live command runs that named themselves, keyed by hold id (the tool call id). */
const exclusiveHolds = new Map<string, ExclusiveHold>();

/**
 * Run fn against the shell-group lock: it waits for all in-flight (running or queued) file mutations
 * to drain, then blocks new ones until fn settles. An ANNOUNCED run joins the shell group, so the
 * command runs one assistant message emitted together overlap; a run nobody announced holds the lock
 * alone, against mutations and against every other run.
 *
 * `options.signal` makes the WAIT cancellable: an abort while the run is still waiting for the lock
 * rejects at once with the signal's reason, never runs fn, and frees the queue position.
 * `options.holdId` names the run so {@link releaseExclusiveHold} can stop it holding the lock while
 * its work keeps running, and is also the announcement this run is ordered by.
 */
export function withExclusiveMutationBarrier<T>(
	fn: () => Promise<T>,
	options?: { signal?: AbortSignal; holdId?: string },
): Promise<T> {
	const signal = options?.signal;
	// Already cancelled before it queued: nothing to schedule, and no position to release.
	if (signal?.aborted) return Promise.reject(signal.reason);
	const holdId = options?.holdId;
	// Declared synchronously, before any await: from here on a later-emitted mutation knows there is
	// a command run ahead of it that has not taken the lock yet.
	const group: LockGroup = declareAnnouncedShellRun(holdId) ? "shell" : "exclusive";
	const hold: ExclusiveHold = { queued: true, lockless: false, done: false };
	if (holdId !== undefined) exclusiveHolds.set(holdId, hold);
	const unregister = (): void => {
		hold.done = true;
		hold.release = undefined;
		// A run that never joined the lock never will: a mutation ordered behind this announcement
		// must stop waiting at this run's terminal, not at the host's retire.
		markAnnouncementJoined(holdId);
		if (holdId !== undefined && exclusiveHolds.get(holdId) === hold) exclusiveHolds.delete(holdId);
	};

	return (async () => {
		// Emission order, before the lock is touched: a command run must not outrun a file mutation
		// its own batch emitted earlier but that has not reached the lock yet. This wait has to happen
		// BEFORE this run joins, or the mutation it is waiting for would park behind this very run.
		try {
			await waitForEarlierAnnouncedCalls(holdId, "mutation", signal);
		} catch (error) {
			unregister();
			throw error;
		}
		if (hold.lockless) {
			// Released before it joined: the run no longer claims a place in the group, so it never
			// takes the lock. It still waits for the mutations that were already in flight when it
			// arrived - "nobody waits for this run any more" is not "this run may start in the middle
			// of somebody else's write".
			try {
				await waitForMutationsToDrain(signal);
				return await fn();
			} finally {
				unregister();
			}
		}
		try {
			await acquireLock(group, signal);
		} catch (error) {
			unregister();
			throw error;
		}
		hold.queued = false;
		let holdsLock = true;
		const release = (): void => {
			if (!holdsLock) return;
			holdsLock = false;
			releaseLock();
		};
		if (hold.lockless) {
			// Handed off while it was still waiting for the lock. It has the lock now; giving it back
			// at once is the same thing as never having taken it, minus a race with the hand-off.
			release();
			try {
				await waitForMutationsToDrain(signal);
				return await fn();
			} finally {
				unregister();
			}
		}
		hold.release = release;
		markAnnouncementJoined(holdId);
		try {
			return await fn();
		} finally {
			release();
			unregister();
		}
	})();
}

/**
 * Stop holding the group lock for `holdId` while its command keeps running.
 *
 * A handed-off command is a detached session task: it has already answered the batch that started
 * it, so it must not keep every file mutation and every sibling command run parked behind it for
 * the rest of its life. Returns true when this call released a hold that was still holding the lock
 * or still waiting for it; false for an unknown, already-released or already-settled hold.
 */
export function releaseExclusiveHold(holdId: string): boolean {
	const hold = exclusiveHolds.get(holdId);
	if (!hold || hold.done) return false;
	// It stops claiming the lock here, so nothing ordered behind this announcement may keep waiting
	// for it to take one - a handed-off command runs for as long as it likes.
	markAnnouncementJoined(holdId);
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
	let holdsLock = false;
	try {
		// Emission order, before the lock is touched: a mutation must not outrun a command run its own
		// batch emitted earlier but that has not reached the lock yet.
		await waitForEarlierAnnouncedCalls(options?.callId, "shell", options?.signal);
		// Join the mutation group as soon as this call is admitted, before waiting on the per-file
		// queue: a mutation already queued behind another on the same file must still count as
		// in-flight for a command run, not just the one executing.
		await acquireLock("mutation", options?.signal);
		holdsLock = true;
		// The announcement this call was reserved with stops being "pending" exactly here: the lock
		// holders now cover it, so a command run waiting on it can stop waiting.
		markAnnouncementJoined(options?.callId);
		await currentQueue;
		return await fn();
	} finally {
		// A cancelled wait never joined the lock; releasing it would credit a holder that was never
		// counted and let a command run start while mutations are still in flight.
		if (holdsLock) releaseLock();
		releaseNext();
		if (queues.get(key) === chainedQueue) {
			queues.delete(key);
		}
	}
}
