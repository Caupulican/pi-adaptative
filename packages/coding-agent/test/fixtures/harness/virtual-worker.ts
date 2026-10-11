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
	/**
	 * Requests queued behind a held request, in post order. A port is FIFO: while one request is held (the worker is
	 * busy on it) every later one waits behind it, so a hold never lets a later request overtake.
	 */
	private readonly inboundBacklog: Array<{ readonly message: unknown; readonly hold?: WorkerHoldRecord }> = [];
	/** Responses queued behind a held response, in post order: the parent receives none of them before the held one. */
	private readonly outboundBacklog: Array<{ readonly message: unknown; readonly hold?: WorkerHoldRecord }> = [];

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
		const hold = this.host.claimHold("inbound", this, message);
		if (hold === undefined && this.inboundBacklog.length === 0) {
			this.inWorker(() => this.processor.receive(message));
			return;
		}
		this.inboundBacklog.push({ message, hold });
		hold?.held(message, () => this.drainInbound());
	}

	/** Delivers queued requests in post order up to the first one still held. */
	private drainInbound(): void {
		while (this.inboundBacklog.length > 0) {
			const next = this.inboundBacklog[0];
			if (next === undefined || next.hold?.state === "held") return;
			this.inboundBacklog.shift();
			const message = next.message;
			this.inWorker(() => this.processor.receive(message));
		}
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
		const hold = this.host.claimHold("outbound", this, message);
		if (hold === undefined && this.outboundBacklog.length === 0) {
			this.deliver(message);
			return;
		}
		this.outboundBacklog.push({ message, hold });
		hold?.held(message, () => this.drainOutbound());
	}

	private drainOutbound(): void {
		while (this.outboundBacklog.length > 0) {
			const next = this.outboundBacklog[0];
			if (next === undefined || next.hold?.state === "held") return;
			this.outboundBacklog.shift();
			this.deliver(next.message);
		}
	}

	/** One response reaches the parent on a later turn; a delivery witness runs around it (see `onResponse`). */
	private deliver(message: unknown): void {
		setImmediate(() => {
			if (this.exiting) return;
			const witness = this.host.claimWitness(this, message);
			witness?.before(message);
			this.host.outbound(this, message);
			this.emit("message", message);
			// The parent's synchronous handler and its microtask continuation run before the next turn.
			if (witness !== undefined) setImmediate(() => witness.delivered(message));
		});
	}

	/** Worker-side work on a later turn; a throw there is the thread's uncaught exception. */
	private inWorker(callback: () => void): void {
		setImmediate(() => {
			if (!this.running) return;
			try {
				this.host.runInWorker(callback);
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

/** A held request or response: `held` until the scenario releases it. */
interface WorkerHoldRecord {
	readonly name: string;
	readonly direction: "inbound" | "outbound";
	readonly type: string;
	readonly matches: (message: unknown, request: unknown) => boolean;
	state: "armed" | "held" | "released";
	/** Marks the hold reached with its message; `drain` runs when it is released. */
	held(message: unknown, drain: () => void): void;
	/** Lets the held message and its queue move on; idempotent. */
	release(): void;
}

export interface WorkerHold {
	readonly name: string;
	/** Resolves with the message when it reached the port and was held; nothing behind it on that port moves until release. */
	readonly reached: Promise<unknown>;
	/** Delivers the held message and everything queued behind it, in order; idempotent. Releasing an unreached hold fails the close. */
	release(): void;
}

/** One message as the parent saw it cross the port: a request when posted, a response when the parent received it. */
export interface WorkerMessageRecord {
	readonly seq: number;
	readonly worker: number;
	readonly direction: "inbound" | "outbound";
	readonly type: string;
	readonly requestId?: number;
	/** Bounded scalar facts of the payload (session, positions, counts, result status); never bodies or texts. */
	readonly facts: Readonly<Record<string, string | number | boolean>>;
}

const MAX_WORKER_HOOKS = 8;
const MAX_FACT_CHARS = 240;

function field(message: unknown, name: string): unknown {
	return typeof message === "object" && message !== null ? Reflect.get(message, name) : undefined;
}

function messageType(message: unknown): string {
	const type = field(message, "type");
	return typeof type === "string" ? type : "malformed";
}

/** The scalar facts a scenario orders and pairs messages by; a result's status and reason are bounded. */
function messageFacts(message: unknown): Record<string, string | number | boolean> {
	const facts: Record<string, string | number | boolean> = {};
	for (const name of ["generation", "sessionId", "fromIndex", "maxSpans", "seq", "rewritten", "query", "entryId"]) {
		const value = field(message, name);
		if (typeof value === "string") facts[name] = value.slice(0, MAX_FACT_CHARS);
		else if (typeof value === "number" || typeof value === "boolean") facts[name] = value;
	}
	const checks = field(message, "checks");
	if (Array.isArray(checks)) facts.checks = checks.length;
	const result = field(message, "result");
	for (const name of ["status", "reason"]) {
		const value = field(result, name);
		if (typeof value === "string") facts[name] = value.slice(0, MAX_FACT_CHARS);
	}
	const bumps = field(message, "bumps");
	if (Array.isArray(bumps)) facts.bumps = bumps.length;
	const error = field(message, "error");
	if (typeof error === "string") facts.error = error.slice(0, MAX_FACT_CHARS);
	return facts;
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
	/** Requests and responses of every worker in one order, as the parent saw them: the call-order witness for interleavings. */
	readonly messageLog: WorkerMessageRecord[] = [];
	private nextSeq = 1;
	private readonly live = new Set<VirtualHostedWorker>();
	private startedCount = 0;
	private readonly intercepts: Array<{
		readonly type: string;
		readonly action: (message: unknown) => void;
		readonly matches?: (message: unknown) => boolean;
	}> = [];
	private readonly holds: WorkerHoldRecord[] = [];
	private readonly witnesses: Array<{
		readonly name: string;
		readonly type: string;
		readonly matches: (response: unknown, request: unknown) => boolean;
		readonly action?: (response: unknown) => void;
		readonly resolve: (response: unknown) => void;
	}> = [];
	/** Each worker's requests by id until their response is delivered, so a response is judged with the request it answers. */
	private readonly openRequests = new Map<VirtualHostedWorker, Map<number, unknown>>();
	private readonly hookFailures: string[] = [];
	private readonly workerContext: (callback: () => void) => void;

	constructor(
		reject: (kind: string) => never,
		workerContext: (callback: () => void) => void = (callback) => callback(),
	) {
		this.workerContext = workerContext;
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
	 * Runs `action` synchronously when the next request of `type` (that `matches`, when given) reaches a worker, before
	 * the processor sees it: the scenario changes the world while that read is in flight. The request itself is
	 * delivered unchanged afterwards.
	 */
	interceptNext(type: string, action: (message: unknown) => void, matches?: (message: unknown) => boolean): void {
		this.intercepts.push({ type, action, matches });
	}

	/**
	 * Holds the next request of `type` that `matches` at the port, before the processor sees it, and everything posted to
	 * that worker after it (a port is FIFO), until released.
	 */
	holdNext(name: string, type: string, matches: (request: unknown) => boolean = () => true): WorkerHold {
		return this.armHold(name, "inbound", type, (message) => matches(message));
	}

	/**
	 * Holds the next response of `type` that `matches` (judged with the request it answers, when it answers one) before
	 * the parent receives it, and every later response of that worker behind it, until released.
	 */
	holdNextResponse(
		name: string,
		type: string,
		matches: (response: unknown, request: unknown) => boolean = () => true,
	): WorkerHold {
		return this.armHold(name, "outbound", type, matches);
	}

	/**
	 * Witnesses the parent receiving the next response of `type` that `matches` (with the request it answers): `action`
	 * runs synchronously just before the parent receives it, and `delivered` resolves on the turn after, once the parent's
	 * synchronous and microtask continuation of that response has run. Production has no event for those in-memory changes.
	 */
	onResponse(
		name: string,
		type: string,
		matches: (response: unknown, request: unknown) => boolean,
		action?: (response: unknown) => void,
	): Promise<unknown> {
		if (this.witnesses.length >= MAX_WORKER_HOOKS) throw new RangeError("Worker response witnesses must be bounded");
		return new Promise((resolve) => {
			this.witnesses.push({ name, type, matches, action, resolve });
		});
	}

	private armHold(
		name: string,
		direction: "inbound" | "outbound",
		type: string,
		matches: (message: unknown, request: unknown) => boolean,
	): WorkerHold {
		if (this.holds.length >= MAX_WORKER_HOOKS) throw new RangeError("Worker holds must be bounded");
		let reach!: (message: unknown) => void;
		const reached = new Promise<unknown>((resolve) => {
			reach = resolve;
		});
		let drain: (() => void) | undefined;
		const record: WorkerHoldRecord = {
			name,
			direction,
			type,
			matches,
			state: "armed",
			held: (message, onRelease) => {
				drain = onRelease;
				reach(message);
			},
			release: () => {
				if (record.state === "released") return;
				record.state = "released";
				const index = this.holds.indexOf(record);
				if (index >= 0) this.holds.splice(index, 1);
				drain?.();
			},
		};
		this.holds.push(record);
		return {
			name,
			reached,
			release: () => {
				if (record.state === "armed") this.hookFailures.push(`worker hold ${name} was never reached`);
				record.release();
			},
		};
	}

	/** The armed hold this message meets, now marked held; undefined when none does. */
	claimHold(
		direction: "inbound" | "outbound",
		worker: VirtualHostedWorker,
		message: unknown,
	): WorkerHoldRecord | undefined {
		const type = messageType(message);
		const request = direction === "outbound" ? this.requestOf(worker, message) : undefined;
		const record = this.holds.find((candidate) => {
			if (candidate.state !== "armed" || candidate.direction !== direction || candidate.type !== type) return false;
			try {
				return candidate.matches(message, request);
			} catch (error) {
				this.hookFailures.push(`worker hold ${candidate.name} matcher threw: ${String(error)}`);
				return false;
			}
		});
		if (record !== undefined) record.state = "held";
		return record;
	}

	/** The delivery witness this response meets, removed from the armed list; undefined when none does. */
	claimWitness(
		worker: VirtualHostedWorker,
		message: unknown,
	): { before(response: unknown): void; delivered(response: unknown): void } | undefined {
		const type = messageType(message);
		const request = this.requestOf(worker, message);
		const index = this.witnesses.findIndex((candidate) => {
			if (candidate.type !== type) return false;
			try {
				return candidate.matches(message, request);
			} catch (error) {
				this.hookFailures.push(`worker witness ${candidate.name} matcher threw: ${String(error)}`);
				return false;
			}
		});
		if (index < 0) return undefined;
		const [witness] = this.witnesses.splice(index, 1);
		if (witness === undefined) return undefined;
		return {
			before: (response) => {
				try {
					witness.action?.(response);
				} catch (error) {
					this.hookFailures.push(`worker witness ${witness.name} action failed: ${String(error)}`);
				}
			},
			delivered: (response) => witness.resolve(response),
		};
	}

	private requestOf(worker: VirtualHostedWorker, response: unknown): unknown {
		const requestId = field(response, "requestId");
		return typeof requestId === "number" ? this.openRequests.get(worker)?.get(requestId) : undefined;
	}

	/** Runs worker-side work inside the world's worker scope (see the virtual filesystem's `scope: "worker"` faults). */
	runInWorker(callback: () => void): void {
		this.workerContext(callback);
	}

	/** World close, before sessions are disposed: every hold still pending is released (and reported) so no owner waits on it. */
	cutoffHolds(): void {
		for (const record of [...this.holds]) {
			this.hookFailures.push(
				record.state === "held"
					? `worker hold ${record.name} was still held at the world's close`
					: `worker hold ${record.name} was never reached`,
			);
			record.release();
		}
	}

	assertNoPendingIntercepts(): void {
		const problems: string[] = [];
		if (this.intercepts.length)
			problems.push(`Worker intercepts never reached: ${this.intercepts.map((entry) => entry.type).join(", ")}`);
		if (this.holds.length)
			problems.push(`Worker holds never released: ${this.holds.map((hold) => hold.name).join(", ")}`);
		if (this.witnesses.length)
			problems.push(
				`Worker response witnesses never reached: ${this.witnesses.map((entry) => entry.name).join(", ")}`,
			);
		problems.push(...this.hookFailures);
		if (problems.length) throw new Error(problems.join("; "));
	}

	started(worker: VirtualHostedWorker): number {
		this.live.add(worker);
		return ++this.startedCount;
	}

	inbound(worker: VirtualHostedWorker, message: unknown): void {
		const type = messageType(message);
		this.inboundLog.push({ worker: worker.id, type });
		const requestId = field(message, "requestId");
		if (typeof requestId === "number") {
			const open = this.openRequests.get(worker) ?? new Map<number, unknown>();
			open.set(requestId, message);
			this.openRequests.set(worker, open);
		}
		this.messageLog.push({
			seq: this.nextSeq++,
			worker: worker.id,
			direction: "inbound",
			type,
			...(typeof requestId === "number" ? { requestId } : {}),
			facts: messageFacts(message),
		});
		const index = this.intercepts.findIndex((entry) => entry.type === type && (entry.matches?.(message) ?? true));
		if (index < 0) return;
		const [entry] = this.intercepts.splice(index, 1);
		entry?.action(message);
	}

	/** Records a response the parent is receiving now, and closes the request it answers. */
	outbound(worker: VirtualHostedWorker, message: unknown): void {
		const requestId = field(message, "requestId");
		this.messageLog.push({
			seq: this.nextSeq++,
			worker: worker.id,
			direction: "outbound",
			type: messageType(message),
			...(typeof requestId === "number" ? { requestId } : {}),
			facts: messageFacts(message),
		});
		if (typeof requestId === "number") this.openRequests.get(worker)?.delete(requestId);
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
