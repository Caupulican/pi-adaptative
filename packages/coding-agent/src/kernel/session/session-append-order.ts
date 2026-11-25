/** Orders session append preparation, the disk receipt, and publication for both call styles. */
import { Stats } from "node:fs";
import { MessageChannel, type MessagePort, receiveMessageOnPort, Worker } from "node:worker_threads";
import {
	executeSessionAppendDisk,
	type SessionAppendDiskResult,
	type SessionAppendDiskStep,
} from "./session-append-disk.ts";
import type { SessionAppendWorkerRequest } from "./session-append-worker.ts";

const IDLE_WORKER_MS = 15_000;
const SYNC_JOIN_MS = 2_000;

export type SessionAppendOperation<T> = Generator<SessionAppendDiskStep, T, SessionAppendDiskResult>;
export type SessionAppendFailure = { error: unknown };

/** Publish the caller's receipt effects before a synchronous join can change the branch. */
export function* finishSessionAppend<T>(
	operation: SessionAppendOperation<T>,
	assertAdmitted: () => void,
	finish: (failure?: SessionAppendFailure) => T,
): SessionAppendOperation<T> {
	try {
		assertAdmitted();
		yield* operation;
	} catch (error) {
		return finish({ error });
	}
	return finish();
}

interface DiskJob {
	detach(port: MessagePort): void;
	fail(error: unknown): void;
}

class SessionAppendWorker {
	private readonly worker: Worker;
	private readonly jobs = new Set<DiskJob>();
	private idle?: ReturnType<typeof setTimeout>;
	private failed?: { error: unknown };

	constructor() {
		const specifier = process.versions.bun
			? "./src/kernel/session/session-append-worker.ts"
			: new URL(
					import.meta.url.endsWith(".ts") ? "./session-append-worker.ts" : "./session-append-worker.js",
					import.meta.url,
				);
		this.worker = new Worker(specifier);
		this.worker.on("error", (error) => this.fail(error));
		this.worker.on("exit", (code) => this.fail(new Error(`Session append worker exited with code ${code}.`)));
	}

	private fail(error: unknown): void {
		this.failed = { error };
		if (activeWorker === this) activeWorker = undefined;
		clearTimeout(this.idle);
		for (const job of this.jobs) job.fail(error);
	}

	start(step: SessionAppendDiskStep, settle: (result: SessionAppendDiskResult) => void): () => void {
		if (this.failed) throw this.failed.error;
		clearTimeout(this.idle);
		this.worker.ref();
		const { port1, port2 } = new MessageChannel();
		const state = new Int32Array(new SharedArrayBuffer(4));
		let settled = false;
		const finish = (result: SessionAppendDiskResult): void => {
			if (settled) return;
			settled = true;
			job.detach(port1);
			try {
				if (!("failed" in result)) Object.setPrototypeOf(result.revision, Stats.prototype);
			} catch (error) {
				settle({ failed: true, started: true, error });
				return;
			}
			settle(result);
		};
		const job: DiskJob = {
			detach: (port) => {
				port.close();
				this.jobs.delete(job);
				if (this.jobs.size || this.failed) return;
				this.worker.unref();
				this.idle = setTimeout(() => {
					if (activeWorker === this) activeWorker = undefined;
					void this.worker.terminate().catch(() => undefined);
				}, IDLE_WORKER_MS);
				this.idle.unref();
			},
			fail: (error) => {
				const receipt = receiveMessageOnPort(port1);
				finish(receipt ? (receipt.message as SessionAppendDiskResult) : { failed: true, started: true, error });
			},
		};
		const command: SessionAppendWorkerRequest = {
			request: step.request,
			port: port2,
			signal: state.buffer as SharedArrayBuffer,
		};
		port1.once("message", finish);
		port1.once("messageerror", job.fail);
		this.jobs.add(job);
		try {
			this.worker.postMessage(command, [port2]);
		} catch (error) {
			port2.close();
			finish({ failed: true, started: false, error });
		}
		return () => {
			if (settled) return;
			const deadline = Date.now() + SYNC_JOIN_MS;
			while (!settled) {
				// Observe completion before checking the port. If the worker posts between the
				// check and wait, Atomics.wait sees a changed value and returns immediately.
				const completion = Atomics.load(state, 0);
				const receipt = receiveMessageOnPort(port1);
				if (receipt) {
					finish(receipt.message as SessionAppendDiskResult);
					break;
				}
				const remaining = deadline - Date.now();
				if (remaining <= 0)
					throw new Error("A session write is still committing. Retry this operation when it finishes.");
				Atomics.wait(state, 0, completion, Math.min(remaining, completion === 0 ? 20 : 1));
			}
		};
	}
}

let activeWorker: SessionAppendWorker | undefined;

function complete<T>(operation: SessionAppendOperation<T>, result: SessionAppendDiskResult): T {
	const step = operation.next(result);
	if (!step.done) throw new Error("A session append can issue only one disk request.");
	return step.value;
}

/** A synchronous mutation can join a pending physical write before preparing against the new leaf. */
export class SessionAppendOrder {
	private readonly queue: (() => void)[] = [];
	private readonly idleWaiters: (() => void)[] = [];
	private pending?: { join(): void };
	private operationDepth = 0;

	private inOperation<T>(operation: () => T): T {
		this.operationDepth++;
		try {
			return operation();
		} finally {
			this.operationDepth--;
		}
	}

	private startNext(): void {
		while (!this.pending && this.operationDepth === 0 && this.queue.length > 0) {
			this.inOperation(this.queue.shift()!);
		}
		if (!this.pending && this.operationDepth === 0) {
			for (const resolve of this.idleWaiters.splice(0)) resolve();
		}
	}

	whenIdle(): Promise<void> {
		if (!this.pending && this.operationDepth === 0 && this.queue.length === 0) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	join(): void {
		// A synchronous callback already inside preparation or publication can keep the
		// existing reentrant semantics. No worker request is outstanding in that scope.
		if (this.operationDepth !== 0) return;
		this.startNext();
		while (this.pending) {
			this.pending.join();
			this.startNext();
		}
	}

	sync<T>(operation: SessionAppendOperation<T>): T {
		this.join();
		try {
			return this.inOperation(() => {
				const step = operation.next();
				if (step.done) return step.value;
				return complete(operation, executeSessionAppendDisk(step.value.request, step.value));
			});
		} finally {
			this.startNext();
		}
	}

	run<T>(operation: SessionAppendOperation<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.queue.push(() => {
				try {
					const step = operation.next();
					if (step.done) {
						resolve(step.value);
						return;
					}
					step.value.assertCurrent();
					const pending = { join: () => {} };
					this.pending = pending;
					const finish = (result: SessionAppendDiskResult) => {
						this.inOperation(() => {
							if (this.pending === pending) this.pending = undefined;
							try {
								resolve(complete(operation, result));
							} catch (error) {
								reject(error);
							}
						});
						this.startNext();
					};
					try {
						activeWorker ??= new SessionAppendWorker();
						pending.join = activeWorker.start(step.value, finish);
					} catch (error) {
						finish({ failed: true, started: false, error });
					}
				} catch (error) {
					reject(error);
				}
			});
			this.startNext();
		});
	}
}
