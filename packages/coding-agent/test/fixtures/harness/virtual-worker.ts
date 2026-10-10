import { EventEmitter } from "node:events";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TranscriptRecallProcessor } from "../../../src/core/memory/providers/transcript-recall-processor.ts";
import { ToolRecoveryLogProcessor } from "../../../src/core/tool-recovery-log-processor.ts";

/** The worker side of a hosted processor's port: what each production `parentPort` adapter provides. */
interface HostedWorkerPort {
	post(message: unknown): void;
	close(): void;
	schedule(callback: () => void): void;
	fail(error: Error): void;
}

/** A production request processor the fixture runs in-thread in place of its worker thread. */
interface HostedProcessor {
	receive(value: unknown): void;
}

type HostedProcessorFactory = (port: HostedWorkerPort) => HostedProcessor;

/** One production worker entry in source mode (`.ts`) and in the built package (`.js`), mapped to the processor its adapter runs. */
function hostedEntry(entry: string, create: HostedProcessorFactory): Array<[string, HostedProcessorFactory]> {
	return [".ts", ".js"].map((extension) => [
		fileURLToPath(new URL(`../../../src/core/${entry}${extension}`, import.meta.url)),
		create,
	]);
}

/**
 * The only worker entries the fixture starts. Each is a thin `parentPort` adapter around a production processor, and the
 * fixture runs that same processor; every other entry is refused.
 */
const HOSTED_WORKERS: ReadonlyMap<string, HostedProcessorFactory> = new Map([
	...hostedEntry("memory/providers/transcript-recall-worker", (port) => new TranscriptRecallProcessor(port)),
	...hostedEntry("tool-recovery-log-worker", (port) => new ToolRecoveryLogProcessor(port)),
]);

/** The native file a worker specifier names, resolved as Node resolves it; undefined for anything else. */
function specifierPath(specifier: unknown): string | undefined {
	if (specifier instanceof URL) return specifier.protocol === "file:" ? fileURLToPath(specifier) : undefined;
	if (typeof specifier !== "string") return undefined;
	if (specifier.startsWith("file:")) return fileURLToPath(specifier);
	return isAbsolute(specifier) || specifier.startsWith("./") || specifier.startsWith("../")
		? resolve(specifier)
		: undefined;
}

/**
 * In-thread stand-in for a production worker thread: the processor its entry adapter runs (see {@link HOSTED_WORKERS})
 * runs against the world's virtual I/O. Every message crosses a structured clone in both directions and arrives
 * on a later turn, as on a real port. Node's event order is kept: an uncaught worker throw or transport loss is
 * `error` then `exit(1)`, a closed port is `exit(0)` after the messages already sent, and `terminate()` is
 * `exit(1)`. Once exit begins nothing more crosses in either direction and no worker-side work runs.
 */
class VirtualHostedWorker extends EventEmitter {
	private readonly host: VirtualWorkerThreads;
	/** Start order within the world, for the scenario's inbound log. */
	readonly id: number;
	private readonly processor: HostedProcessor;
	/** False once the worker side ended (port closed, uncaught throw, terminate, cutoff): no work runs, no sends leave. */
	private running = true;
	/** Set when exit begins: nothing is delivered to the parent after it. */
	private exiting = false;
	/** Set by the harness cutoff: not even an already scheduled exit event reaches production listeners. */
	private cut = false;
	private settleExit: (code: number) => void = () => undefined;
	private readonly exited = new Promise<number>((resolve) => {
		this.settleExit = resolve;
	});
	/** Whether the parent keeps this worker referenced; recorded only, the fixture holds no host handle. */
	referenced = true;

	constructor(host: VirtualWorkerThreads, create: HostedProcessorFactory) {
		super();
		this.host = host;
		this.id = host.started(this);
		this.processor = create({
			post: (response) => this.toParent(response),
			// The worker's port closes after the answers it already sent; the thread then exits cleanly.
			close: () => {
				this.running = false;
				setImmediate(() => this.beginExit(0));
			},
			schedule: (callback) => this.inWorker(callback),
			// Transport loss ends the thread through its uncaught-error path, as the real adapter rethrows it.
			fail: (error) =>
				this.inWorker(() => {
					throw error;
				}),
		});
	}

	postMessage(value: unknown): void {
		const message = structuredClone(value);
		this.host.inbound(this, message);
		this.inWorker(() => this.processor.receive(message));
	}

	ref(): void {
		this.referenced = true;
	}

	unref(): void {
		this.referenced = false;
	}

	terminate(): Promise<number> {
		this.beginExit(1);
		return this.exited;
	}

	/** Harness cutoff after the leak is asserted: fenced without events, so no production listener runs later. */
	cutoff(): void {
		this.running = false;
		this.exiting = true;
		this.cut = true;
		this.settleExit(1);
	}

	private toParent(response: unknown): void {
		// A closed port drops sends; a send that cannot be cloned throws to the processor as transport loss.
		if (!this.running) return;
		const message = structuredClone(response);
		setImmediate(() => {
			if (!this.exiting) this.emit("message", message);
		});
	}

	/** Worker-side work on a later turn; a throw there is the thread's uncaught exception. */
	private inWorker(callback: () => void): void {
		setImmediate(() => {
			if (!this.running) return;
			try {
				callback();
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				this.running = false;
				setImmediate(() => {
					if (this.exiting) return;
					this.emit("error", failure);
					this.beginExit(1);
				});
			}
		});
	}

	private beginExit(code: number): void {
		this.running = false;
		if (this.exiting) return;
		this.exiting = true;
		setImmediate(() => {
			if (this.cut) return;
			this.host.exited(this);
			this.emit("exit", code);
			this.settleExit(code);
		});
	}
}

/**
 * The world's `worker_threads` boundary. Only the hosted production entries start, each running its processor
 * in-thread; any other specifier or option is refused through the guard and recorded as an escape. Started workers are tracked until
 * they exit, so an owner that never terminates its worker fails the close.
 */
export class VirtualWorkerThreads {
	readonly Worker: new (
		...arguments_: unknown[]
	) => EventEmitter;
	/** Every request a started worker received, in arrival order: which worker and which protocol request type. */
	readonly inboundLog: Array<{ readonly worker: number; readonly type: string }> = [];
	private readonly live = new Set<VirtualHostedWorker>();
	private startedCount = 0;
	private readonly intercepts: Array<{ readonly type: string; readonly action: () => void }> = [];

	constructor(reject: (kind: string) => never) {
		const host = this;
		this.Worker = class extends VirtualHostedWorker {
			constructor(...arguments_: unknown[]) {
				const path = arguments_.length === 1 ? specifierPath(arguments_[0]) : undefined;
				// The refusal names the entry it refused, so the close reports which production worker tried to start.
				const create = path === undefined ? undefined : HOSTED_WORKERS.get(path);
				if (create === undefined)
					reject(`worker_threads.Worker(${path === undefined ? "unresolvable specifier" : basename(path)})`);
				super(host, create);
			}
		};
	}

	/** Workers started in this world so far, live or exited. */
	get startedTotal(): number {
		return this.startedCount;
	}

	get liveCount(): number {
		return this.live.size;
	}

	/**
	 * Runs `action` synchronously when the next request of `type` reaches a worker, before the processor sees it: the
	 * scenario changes the world while that read is in flight. The request itself is delivered unchanged afterwards.
	 */
	interceptNext(type: string, action: () => void): void {
		this.intercepts.push({ type, action });
	}

	assertNoPendingIntercepts(): void {
		if (this.intercepts.length) {
			throw new Error(`Worker intercepts never reached: ${this.intercepts.map((entry) => entry.type).join(", ")}`);
		}
	}

	started(worker: VirtualHostedWorker): number {
		this.live.add(worker);
		return ++this.startedCount;
	}

	inbound(worker: VirtualHostedWorker, message: unknown): void {
		const type =
			typeof message === "object" && message !== null && typeof Reflect.get(message, "type") === "string"
				? String(Reflect.get(message, "type"))
				: "malformed";
		this.inboundLog.push({ worker: worker.id, type });
		const index = this.intercepts.findIndex((entry) => entry.type === type);
		if (index < 0) return;
		const [entry] = this.intercepts.splice(index, 1);
		entry?.action();
	}

	exited(worker: VirtualHostedWorker): void {
		this.live.delete(worker);
	}

	assertNoLiveWorkers(): void {
		if (this.live.size) throw new Error(`Fixture worker threads still live: ${this.live.size}`);
	}

	/** Fences every remaining worker before the guard restores the host builtins; the leak is reported by the close check. */
	cutoff(): void {
		for (const worker of this.live) worker.cutoff();
		this.live.clear();
	}
}
