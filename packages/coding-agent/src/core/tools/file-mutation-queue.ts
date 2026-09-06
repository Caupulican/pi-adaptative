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
let writerQueue: Promise<void> = Promise.resolve();
let writerActive: Promise<void> | undefined;

function acquireReader(): Promise<void> {
	// No writer holds or is draining: join immediately (synchronously counted, so a
	// writer that starts checking activeReaders right after can never miss this join).
	if (!writerActive) {
		activeReaders++;
		return Promise.resolve();
	}
	// A writer holds (or is waiting to): wait for it to fully release before joining.
	return writerActive.then(() => {
		activeReaders++;
	});
}

function releaseReader(): void {
	activeReaders--;
	if (activeReaders === 0 && readersDrained) {
		const drained = readersDrained;
		readersDrained = undefined;
		drained();
	}
}

/**
 * Run fn exclusively: waits for all in-flight (running or queued) file mutations to
 * drain, then blocks new ones and other exclusive runs until fn settles. Exclusive
 * runs themselves queue FIFO against each other.
 */
export function withExclusiveMutationBarrier<T>(fn: () => Promise<T>): Promise<T> {
	const run = writerQueue.then(async () => {
		let release!: () => void;
		writerActive = new Promise<void>((resolveWriter) => {
			release = resolveWriter;
		});
		try {
			if (activeReaders > 0) {
				await new Promise<void>((resolveDrain) => {
					readersDrained = resolveDrain;
				});
			}
			return await fn();
		} finally {
			writerActive = undefined;
			release();
		}
	});
	writerQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
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
	try {
		// Join the reader side as soon as this call is admitted, before waiting on the
		// per-file queue: a mutation already queued behind another on the same file must
		// still count as in-flight for the exclusive barrier, not just the one executing.
		await acquireReader();
		await currentQueue;
		return await fn();
	} finally {
		releaseReader();
		releaseNext();
		if (queues.get(key) === chainedQueue) {
			queues.delete(key);
		}
	}
}
