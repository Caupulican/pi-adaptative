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

export class SessionMutationBusyError extends Error {
	readonly code = "PI_SESSION_WRITE_BUSY";
	constructor() {
		super("A session write is still committing. Await the session mutation or retry after it finishes.");
		this.name = "SessionMutationBusyError";
	}
}

export type SessionAppendOperation<T> = Generator<SessionAppendDiskStep, T, SessionAppendDiskResult>;
export type SessionAppendFailure = { error: unknown };
export interface AdjacentMutationReplacement<T> {
	readonly key: object;
	readonly superseded: T;
}

type QueuedMutation = (() => void) & { replacement?: { key: object; supersede(): void } };

/** Publish the caller's receipt effects before admitting another mutation. */
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

	start(step: SessionAppendDiskStep, settle: (result: SessionAppendDiskResult) => void): void {
		if (this.failed) throw this.failed.error;
		clearTimeout(this.idle);
		this.worker.ref();
		const { port1, port2 } = new MessageChannel();
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
	}
}

let activeWorker: SessionAppendWorker | undefined;

function complete<T>(operation: SessionAppendOperation<T>, result: SessionAppendDiskResult): T {
	const step = operation.next(result);
	if (!step.done) throw new Error("A session append can issue only one disk request.");
	return step.value;
}

/** Off-thread appends and awaited mutations share admission and publish in order. */
export class SessionAppendOrder {
	private readonly queue: QueuedMutation[] = [];
	private readonly idleWaiters: (() => void)[] = [];
	private pending = false;
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

	assertSynchronousAdmission(): void {
		if (this.operationDepth === 0 && (this.pending || this.queue.length > 0)) throw new SessionMutationBusyError();
	}

	sync<T>(operation: SessionAppendOperation<T>): T {
		this.assertSynchronousAdmission();
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

	private enqueue<T>(
		operation: (resolve: (value: T) => void, reject: (error: unknown) => void) => void,
		replacement?: AdjacentMutationReplacement<T>,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const queued: QueuedMutation = () => {
				try {
					operation(resolve, reject);
				} catch (error) {
					reject(error);
				}
			};
			if (replacement) {
				queued.replacement = { key: replacement.key, supersede: () => resolve(replacement.superseded) };
				const tail = this.queue.at(-1)?.replacement;
				if (tail?.key === replacement.key) {
					this.queue.pop();
					tail.supersede();
				}
			}
			this.queue.push(queued);
			this.startNext();
		});
	}

	/** An optional replacement may supersede only the adjacent, unstarted snapshot with its key. */
	mutate<T>(operation: () => T, replacement?: AdjacentMutationReplacement<T>): Promise<T> {
		return this.enqueue((resolve) => resolve(operation()), replacement);
	}

	run<T>(operation: SessionAppendOperation<T>): Promise<T> {
		return this.enqueue((resolve, reject) => {
			const step = operation.next();
			if (step.done) {
				resolve(step.value);
				return;
			}
			step.value.assertCurrent();
			this.pending = true;
			const finish = (result: SessionAppendDiskResult) => {
				this.inOperation(() => {
					this.pending = false;
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
				activeWorker.start(step.value, finish);
			} catch (error) {
				finish({ failed: true, started: false, error });
			}
		});
	}
}
