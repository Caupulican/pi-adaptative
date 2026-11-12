import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { basename, dirname, resolve, sep } from "node:path";
import nativeProcess from "node:process";
import type { DatabaseSync as NativeDatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { PassThrough, Writable } from "node:stream";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { getSystemErrorMap } from "node:util";
import * as undici from "undici";
import { disposeHttpDispatcher, HTTP_INSTALL_GLOBAL_NAMES } from "../../../src/core/http-dispatcher.ts";
import { builtinBoundary } from "./builtin-boundary.ts";
import {
	type SqliteDenial,
	type SqliteFaultOperation,
	type SqliteFaultResult,
	VirtualSqlite,
	type VirtualSqliteSnapshot,
} from "./sqlite-io.ts";
import type { VirtualNetwork } from "./virtual-net.ts";
import { VirtualWorkerThreads } from "./virtual-worker.ts";

interface VirtualNode {
	kind: "file" | "directory" | "symlink";
	data: Buffer;
	target?: string;
	modified: number;
	changed?: number;
	identity: number;
	/** Permission bits a creator or `chmod` gave a file; absent means the default, 0644. */
	mode?: number;
}

export interface IoOperation {
	readonly kind: string;
	readonly path: string;
	readonly destination?: string;
	/** Bytes returned by a successful modeled file read, including descriptor and stream reads. */
	readonly bytesRead?: number;
	/** The open flags, on an `open` operation handed to a fault or observer matcher (never in the ledger). */
	readonly flags?: string;
}

/** An operation that failed: its natural or injected error code, and the ledger length when it failed (its position). */
export interface IoFailedOperation extends IoOperation {
	readonly code: string;
	readonly at: number;
}

export type IoFaultKind =
	| "write"
	| "append"
	| "unlink"
	| "link"
	| "rm"
	| "rename"
	| "watch.close"
	| "read"
	| "open"
	| "stat"
	| "readdir"
	| "mkdir"
	| "watch";

export interface IoFault {
	readonly name: string;
	readonly kind: IoFaultKind;
	readonly matches: (operation: IoOperation, data?: Buffer) => boolean;
	readonly code?: string;
	readonly phase?: "before" | "after";
	readonly times?: number;
	/**
	 * `worker`: only operations made while a hosted worker callback runs, such as the recall processor's synchronous
	 * session reads; the owner's own reads of the same file still succeed (a read that fails for the index only).
	 */
	readonly scope?: "worker";
}

/** A persistent fault: every matching operation fails until the scenario clears it. Close fails if it is never cleared or never hit. */
export interface IoDenial {
	readonly name: string;
	/** Operations refused so far. */
	readonly hits: number;
	/** Restores the operation; returns the number of refused operations. */
	clear(): number;
}

/** A one-shot synchronous observation inside the matching operation: it throws nothing and changes nothing. */
export interface IoObserver {
	readonly name: string;
	readonly kind: IoFaultKind | "readdir.callback";
	readonly phase?: "before" | "after";
	readonly matches: (operation: IoOperation, data?: Buffer) => boolean;
	readonly onMatch: (operation: IoOperation, data?: Buffer) => void;
}

/** The asynchronous operations a scenario can hold at their call: the operation runs, against the state then current, on release. */
export type IoHoldKind = "readFile" | "readdir" | "mkdir" | "writeFile" | "rename";

export interface IoHold {
	readonly name: string;
	/** Resolves when a production call reached the hold; the operation has not run yet. */
	readonly reached: Promise<IoOperation>;
	/** Runs the held operation now; idempotent. Releasing an unreached hold disarms it and fails the close. */
	release(): void;
}

/** A crash-state capture of one directory tree: every file's bytes and every directory, by native path. */
export interface VirtualTreeCapture {
	readonly root: string;
	readonly files: ReadonlyMap<string, Buffer>;
	readonly directories: readonly string[];
}

/** The libuv errno Node reports for a system error code on this platform; absent for codes that are not system errors. */
const SYSTEM_ERRNO: ReadonlyMap<string, number> = new Map(
	[...getSystemErrorMap()].map(([errno, [name]]): [string, number] => [name, errno]),
);

/** The syscall a real operation of each fault kind names in its error (`watch.close` is no syscall). */
const FAULT_SYSCALL: Readonly<Record<IoFaultKind, string | undefined>> = {
	write: "write",
	append: "write",
	unlink: "unlink",
	link: "link",
	rm: "rm",
	rename: "rename",
	"watch.close": undefined,
	read: "read",
	open: "open",
	stat: "stat",
	readdir: "scandir",
	mkdir: "mkdir",
	watch: undefined,
};

const MAX_PENDING_HOLDS = 8;
const MAX_OBSERVERS = 8;

interface OpenFile {
	path: string;
	readonly node: VirtualNode;
	position: number;
	append: boolean;
	writable: boolean;
	/** Where the file was opened, kept only when `PI_HARNESS_TRACE_OPENS` is set: names the owner of a leaked handle. */
	readonly openedAt?: string;
}

export interface VirtualWatcherSnapshot {
	readonly id: number;
	readonly path: string;
	readonly recursive: boolean;
	readonly listenerCount: number;
}

interface VirtualWatcher {
	readonly id: number;
	readonly path: string;
	readonly emitter: EventEmitter;
	readonly recursive: boolean;
}

/**
 * A Node-shaped system error: `code`, `path`, and, for a system error code, the platform `errno` and the `syscall` the
 * real operation names, so production classifies it as it classifies a real one. The message stays the fixture's.
 */
function ioError(code: string, path: string, syscall?: string): NodeJS.ErrnoException {
	const errno = SYSTEM_ERRNO.get(code);
	return Object.assign(
		new Error(`${code}: virtual filesystem '${path}'`),
		{ code, path },
		errno !== undefined && syscall !== undefined ? { errno, syscall } : {},
	);
}

interface HoldRecord {
	readonly name: string;
	readonly kind: IoHoldKind;
	readonly matches: (operation: IoOperation) => boolean;
	state: "armed" | "reached" | "released";
	readonly gate: Promise<void>;
	readonly open: () => void;
	readonly reach: (operation: IoOperation) => void;
}

function bytes(value: unknown): Buffer {
	if (typeof value === "string") return Buffer.from(value);
	if (value instanceof Uint8Array) return Buffer.from(value);
	throw new TypeError("Virtual write requires string or Uint8Array data");
}

function fileTypeMethods(node: VirtualNode) {
	return {
		isDirectory: () => node.kind === "directory",
		isFile: () => node.kind === "file",
		isSymbolicLink: () => node.kind === "symlink",
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isFIFO: () => false,
		isSocket: () => false,
	};
}

/** Only modeled namespace/content/metadata mutations notify watchers; observations stay in the IO ledger. */
const WATCH_CHANGE_OPERATIONS: ReadonlySet<string> = new Set([
	"write",
	"append",
	"mkdir",
	"unlink",
	"rm",
	"change",
	"truncate",
	"utimes",
]);

interface OpenMode {
	create: boolean;
	exclusive: boolean;
	truncate: boolean;
	append: boolean;
	writable: boolean;
}

/** Decode both Node open flag spellings: the string forms and the numeric `fs.constants` bit masks. */
function decodeOpenFlags(flags: unknown): OpenMode {
	if (typeof flags === "string") {
		return {
			create: flags.startsWith("w") || flags.startsWith("a"),
			exclusive: flags.includes("x"),
			truncate: flags.startsWith("w"),
			append: flags.startsWith("a"),
			writable: flags.includes("+") || flags.startsWith("w") || flags.startsWith("a"),
		};
	}
	if (typeof flags !== "number" || !Number.isInteger(flags))
		throw new Error("Virtual open requires string or integer flags");
	const { O_WRONLY, O_RDWR, O_CREAT, O_EXCL, O_TRUNC, O_APPEND } = fs.constants;
	return {
		create: (flags & O_CREAT) !== 0,
		exclusive: (flags & O_EXCL) !== 0,
		truncate: (flags & O_TRUNC) !== 0,
		append: (flags & O_APPEND) !== 0,
		writable: (flags & (O_WRONLY | O_RDWR)) !== 0,
	};
}

/** All fixture and production-store bytes live here. Unimplemented operations fail, never fall through. */
export class VirtualFileSystem {
	readonly operations: IoOperation[] = [];
	readonly cwd: string;
	private readonly nodes = new Map<string, VirtualNode>();
	private readonly descriptors = new Map<number, OpenFile>();
	private readonly watchers = new Set<VirtualWatcher>();
	private nextWatcher = 1;
	/** Bounded physical closure evidence, separate from the native owner's retained disposer/fence. */
	readonly watcherClosures: Array<{
		readonly id: number;
		readonly path: string;
		readonly reason: "close" | "cutoff";
	}> = [];
	private readonly streams = new Set<Writable>();
	private readonly directories = new Set<object>();
	private nextDescriptor = 100;
	private nextIdentity = 1;
	private nextTemporary = 1;
	/** The last modification time handed out: wall clock, strictly increasing, so write order is kept and ages are real. */
	private lastModified = 0;
	private readonly faults: Array<{
		readonly fault: IoFault;
		remaining: number;
		readonly denial?: { hits: number; cleared: boolean };
	}> = [];
	readonly consumedFaults: string[] = [];
	/** Persistent faults by name, kept after clearing so the close can check each was hit. */
	private readonly denials = new Map<string, { hits: number; cleared: boolean }>();
	private readonly observers: IoObserver[] = [];
	readonly consumedObservers: string[] = [];
	private readonly holds: HoldRecord[] = [];
	/** Hook misuse found while production ran (a throwing observer, a hold released unreached or at cutoff); reported at close. */
	private readonly hookFailures: string[] = [];
	/** Every operation that failed, natural or injected, in order: what a scenario waits on for a refused attempt. */
	readonly failedOperations: IoFailedOperation[] = [];
	private readonly operationWaiters = new Set<{
		readonly matches: (operation: IoOperation & { readonly code?: string }) => boolean;
		readonly resolve: (operation: IoOperation & { readonly code?: string }) => void;
	}>();
	/** Depth of hosted worker callbacks running now: a `scope: "worker"` fault applies only inside one. */
	private workerDepth = 0;
	/** Promise-export settles awaiting their turn, in call order (see {@link settled}). */
	private readonly settleQueue: Array<() => void> = [];
	private settleScheduled = false;
	/** Scenario conditions re-read after each modeled mutation; see {@link waitForMutation}. */
	private readonly mutationWaiters = new Set<{
		readonly holds: () => boolean;
		readonly resolve: () => void;
		readonly reject: (error: unknown) => void;
	}>();

	constructor(cwd = "/harness/project") {
		this.cwd = resolve(cwd);
		this.mkdirSync(this.cwd, { recursive: true });
		this.operations.length = 0;
	}

	failNext(fault: IoFault): void {
		const remaining = fault.times ?? 1;
		if (!Number.isSafeInteger(remaining) || remaining < 1 || remaining > 32 || this.faults.length >= 32)
			throw new RangeError("Virtual IO fault queue must be bounded");
		if (fault.matches.constructor.name === "AsyncFunction") throw new TypeError("IO fault matching is synchronous");
		this.faults.push({ fault, remaining });
	}

	/** Fails every matching operation until `clear()`; see {@link IoDenial}. */
	denyUntilCleared(fault: Omit<IoFault, "times">): IoDenial {
		if (this.faults.length >= 32) throw new RangeError("Virtual IO fault queue must be bounded");
		if (fault.matches.constructor.name === "AsyncFunction") throw new TypeError("IO fault matching is synchronous");
		if (this.denials.has(fault.name)) throw new Error(`IO denial ${fault.name} is already declared`);
		const denial = { hits: 0, cleared: false };
		this.denials.set(fault.name, denial);
		const entry = { fault, remaining: Number.POSITIVE_INFINITY, denial };
		this.faults.push(entry);
		const faults = this.faults;
		return {
			name: fault.name,
			get hits() {
				return denial.hits;
			},
			clear: () => {
				const index = faults.indexOf(entry);
				if (index >= 0) faults.splice(index, 1);
				denial.cleared = true;
				return denial.hits;
			},
		};
	}

	/** Arms a one-shot synchronous observation; see {@link IoObserver}. Close fails if it never matched. */
	observeNext(observer: IoObserver): void {
		if (this.observers.length >= MAX_OBSERVERS) throw new RangeError("Virtual IO observers must be bounded");
		for (const callback of [observer.matches, observer.onMatch]) {
			if (callback.constructor.name === "AsyncFunction") throw new TypeError("IO observation is synchronous");
		}
		this.observers.push(observer);
	}

	/**
	 * Holds the next matching asynchronous call of `kind` at its call, before it touches the tree; the scenario releases
	 * it. The callback API is built from the promise exports, so one hold also covers a callback caller (proper-lockfile's
	 * `mkdir`). A call that matches no hold runs exactly as before.
	 */
	holdNext(hold: {
		readonly name: string;
		readonly kind: IoHoldKind;
		readonly matches: (operation: IoOperation) => boolean;
	}): IoHold {
		if (this.holds.length >= MAX_PENDING_HOLDS) throw new RangeError("Virtual IO holds must be bounded");
		if (hold.matches.constructor.name === "AsyncFunction") throw new TypeError("IO hold matching is synchronous");
		let open!: () => void;
		const gate = new Promise<void>((resolveGate) => {
			open = resolveGate;
		});
		let reach!: (operation: IoOperation) => void;
		const reached = new Promise<IoOperation>((resolveReached) => {
			reach = resolveReached;
		});
		const record: HoldRecord = { ...hold, state: "armed", gate, open, reach };
		this.holds.push(record);
		return {
			name: hold.name,
			reached,
			release: () => this.releaseHold(record, false),
		};
	}

	private releaseHold(record: HoldRecord, cutoff: boolean): void {
		const index = this.holds.indexOf(record);
		if (index < 0) return;
		this.holds.splice(index, 1);
		if (record.state === "armed") this.hookFailures.push(`IO hold ${record.name} was never reached`);
		else if (cutoff) this.hookFailures.push(`IO hold ${record.name} was still held at the world's close`);
		record.state = "released";
		record.open();
	}

	/** World close, before sessions are disposed: every hold still pending is released (and reported) so no owner waits on it. */
	cutoffHolds(): void {
		for (const record of [...this.holds]) this.releaseHold(record, true);
	}

	/**
	 * Settles one promise-export operation on a later event-loop turn, as real I/O does. `run` executes at the call (or, for a
	 * held call, at its release), so the operation's effects keep their call order; only the promise waits a turn. Settles are
	 * queued in the order they were run and flushed together on one turn, so a later operation never settles before an
	 * earlier one. A caller therefore never resumes inside the turn it called in, and a loop of awaits cannot starve timers.
	 */
	private settled<T>(run: () => T): Promise<T> {
		type Outcome = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
		let outcome: Outcome | undefined;
		return new Promise<T>((resolveSettled, rejectSettled) => {
			// Queued before `run`: a waiter woken by this operation's own log settles behind it, never ahead of it.
			this.enqueueSettle(() => {
				if (outcome === undefined) throw new Error("virtual IO settled an operation before running it");
				if (outcome.ok) resolveSettled(outcome.value);
				else rejectSettled(outcome.error);
			});
			try {
				outcome = { ok: true, value: run() };
			} catch (error) {
				outcome = { ok: false, error };
			}
		});
	}

	private enqueueSettle(settle: () => void): void {
		this.settleQueue.push(settle);
		if (this.settleScheduled) return;
		this.settleScheduled = true;
		setImmediate(() => this.flushSettles());
	}

	private flushSettles(): void {
		this.settleScheduled = false;
		for (const settle of this.settleQueue.splice(0)) settle();
		// The owner whose awaited operation just settled runs its bookkeeping before the waiters read it on the next turn.
		this.wakeMutationWaiters();
	}

	/** A held call waits at its gate and then runs; any other call runs at once, exactly as without holds. */
	private whenReleased<T>(kind: IoHoldKind, operation: IoOperation | undefined, run: () => T): Promise<T> {
		const record =
			operation === undefined
				? undefined
				: this.holds.find(
						(candidate) => candidate.state === "armed" && candidate.kind === kind && candidate.matches(operation),
					);
		if (record === undefined || operation === undefined) return this.settled(run);
		record.state = "reached";
		record.reach(operation);
		return record.gate.then(() => this.settled(run));
	}

	/** The native path a held call names, or undefined when it names none (an unopened descriptor). */
	private holdPath(value: unknown): string | undefined {
		try {
			return this.path(value);
		} catch {
			return undefined;
		}
	}

	assertFaultsConsumed(): void {
		const problems: string[] = [];
		const pending = this.faults.filter((entry) => entry.denial === undefined);
		if (pending.length)
			problems.push(
				`Unconsumed IO faults: ${pending.map(({ fault, remaining }) => `${fault.name}:${remaining}`).join(",")}`,
			);
		for (const [name, denial] of this.denials) {
			if (!denial.cleared) problems.push(`IO denial ${name} was never cleared`);
			else if (denial.hits === 0) problems.push(`IO denial ${name} refused no operation`);
		}
		if (this.observers.length)
			problems.push(`Unconsumed IO observers: ${this.observers.map((observer) => observer.name).join(",")}`);
		if (this.holds.length) problems.push(`Unreleased IO holds: ${this.holds.map((hold) => hold.name).join(",")}`);
		problems.push(...this.hookFailures);
		if (problems.length) throw new Error(problems.join("; "));
	}

	/** Runs one hosted worker callback with the worker scope set (see {@link IoFault.scope}); the processors read synchronously. */
	runInWorker(callback: () => void): void {
		this.workerDepth++;
		try {
			callback();
		} finally {
			this.workerDepth--;
		}
	}

	private fault(operation: IoOperation, phase: "before" | "after", data?: Buffer): void {
		this.observe(operation, phase, data);
		const index = this.faults.findIndex(
			({ fault }) =>
				fault.kind === operation.kind &&
				(fault.phase ?? "before") === phase &&
				(fault.scope !== "worker" || this.workerDepth > 0) &&
				fault.matches(operation, data),
		);
		if (index < 0) return;
		const entry = this.faults[index]!;
		if (entry.denial !== undefined) entry.denial.hits++;
		else if (--entry.remaining === 0) this.faults.splice(index, 1);
		this.consumedFaults.push(entry.fault.name);
		const code = entry.fault.code ?? "EIO";
		this.recordFailure(operation, code);
		throw Object.assign(ioError(code, operation.path, FAULT_SYSCALL[entry.fault.kind]), {
			message: `Scripted IO fault ${entry.fault.name}: ${operation.kind} '${operation.path}'`,
			faultName: entry.fault.name,
		});
	}

	private observe(operation: IoOperation, phase: "before" | "after", data?: Buffer): void {
		if (this.observers.length === 0) return;
		const index = this.observers.findIndex((observer) => {
			if (observer.kind !== operation.kind || (observer.phase ?? "before") !== phase) return false;
			try {
				return observer.matches(operation, data);
			} catch (error) {
				this.hookFailures.push(`IO observer ${observer.name} matcher threw: ${String(error)}`);
				return false;
			}
		});
		if (index < 0) return;
		const [observer] = this.observers.splice(index, 1);
		if (observer === undefined) return;
		this.consumedObservers.push(observer.name);
		try {
			observer.onMatch(operation, data);
		} catch (error) {
			// An observation never perturbs the operation it watches; its own failure is reported at close.
			this.hookFailures.push(
				`IO observer ${observer.name} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** A natural failure: recorded with its position, then returned for the caller to throw. */
	private failure(
		kind: string,
		code: string,
		path: string,
		syscall?: string,
		destination?: string,
	): NodeJS.ErrnoException {
		this.recordFailure({ kind, path, ...(destination === undefined ? {} : { destination }) }, code);
		return ioError(code, path, syscall);
	}

	private recordFailure(operation: IoOperation, code: string): void {
		const failed: IoFailedOperation = {
			kind: operation.kind,
			path: operation.path,
			...(operation.destination === undefined ? {} : { destination: operation.destination }),
			code,
			at: this.operations.length,
		};
		this.failedOperations.push(failed);
		this.notifyOperation(failed);
	}

	/**
	 * Event-driven wait for one operation: a ledger entry or a failed attempt that `matches`, recorded after this call.
	 * Resolved on a later turn, so the owner that ran it finishes its synchronous work first. The caller bounds the wait.
	 */
	waitForOperation(
		matches: (operation: IoOperation & { readonly code?: string }) => boolean,
	): Promise<IoOperation & { readonly code?: string }> {
		return new Promise((resolveWait) => {
			this.operationWaiters.add({ matches, resolve: resolveWait });
		});
	}

	private notifyOperation(operation: IoOperation & { readonly code?: string }): void {
		for (const waiter of [...this.operationWaiters]) {
			if (!waiter.matches(operation)) continue;
			this.operationWaiters.delete(waiter);
			this.enqueueSettle(() => waiter.resolve(operation));
		}
	}

	/** Appends to the ledger and wakes operation waiters. */
	private log(operation: IoOperation): void {
		this.operations.push(operation);
		if (this.operationWaiters.size > 0) this.notifyOperation(operation);
	}

	/** A modification time: the wall clock, never equal to or below the last one handed out. */
	private stamp(): number {
		this.lastModified = Math.max(Date.now(), this.lastModified + 1);
		return this.lastModified;
	}

	private touchDirectory(path: string): void {
		const node = this.nodes.get(path);
		if (node?.kind !== "directory") return;
		const stamp = this.stamp();
		node.modified = stamp;
		node.changed = stamp;
	}

	/** The bytes of a file now, for scenario inspection: no ledger entry, no fault, no hold. */
	peekFile(path: string): string | undefined {
		const node = this.nodes.get(this.path(path));
		return node?.kind === "file" ? node.data.toString() : undefined;
	}

	/** The identity of a file now, for scenario inspection: no ledger entry, no fault, no hold. */
	peekIdentity(path: string): number | undefined {
		const node = this.nodes.get(this.path(path));
		return node?.kind === "file" ? node.identity : undefined;
	}

	/** Every file and directory under `root` (inclusive), byte exact, without touching the ledger, faults or holds. */
	captureTree(root: string): VirtualTreeCapture {
		const base = this.path(root);
		const inside = (path: string): boolean => path === base || path.startsWith(`${base}${sep}`);
		const files = new Map<string, Buffer>();
		const directories: string[] = [];
		for (const [path, node] of this.nodes) {
			if (!inside(path)) continue;
			if (node.kind === "file") files.set(path, Buffer.from(node.data));
			else if (node.kind === "directory") directories.push(path);
		}
		directories.sort();
		return { root: base, files, directories };
	}

	/**
	 * Puts `root` back to exactly `capture`, as an external writer would (modeled operations, so watchers and waiters see
	 * them): everything under it the capture lacks is removed, then the captured directories and file bytes are written.
	 * Throws unless the tree then equals the capture.
	 */
	restoreTree(capture: VirtualTreeCapture): void {
		const now = this.captureTree(capture.root);
		const keptDirectories = new Set(capture.directories);
		for (const path of now.files.keys()) if (!capture.files.has(path)) this.unlinkSync(path);
		for (const path of [...now.directories].reverse()) {
			if (!keptDirectories.has(path) && this.nodes.has(path)) this.rmSync(path, { recursive: true });
		}
		for (const path of capture.directories) this.mkdirSync(path, { recursive: true });
		for (const [path, data] of capture.files) {
			if (!this.nodes.get(path)?.data.equals(data)) this.writeFileSync(path, data);
		}
		const after = this.captureTree(capture.root);
		const same =
			after.directories.join("\n") === capture.directories.join("\n") &&
			after.files.size === capture.files.size &&
			[...capture.files].every(([path, data]) => after.files.get(path)?.equals(data) === true);
		if (!same) throw new Error(`The tree under ${capture.root} does not equal its capture after the restore`);
	}

	path(value: unknown, syscall = "open"): string {
		if (value instanceof URL) return resolve(fileURLToPath(value));
		if (typeof value === "number") {
			const descriptor = this.descriptors.get(value);
			if (!descriptor) throw ioError("EBADF", String(value), syscall);
			return descriptor.path;
		}
		if (Buffer.isBuffer(value)) return resolve(this.cwd, value.toString());
		if (typeof value !== "string")
			throw new TypeError("Virtual path requires string, URL, Buffer or open descriptor");
		return resolve(this.cwd, value);
	}

	seed(path: string, value: string): void {
		this.mkdirSync(dirname(this.path(path)), { recursive: true });
		this.writeFileSync(path, value);
	}

	fileEntries(directory?: string): ReadonlyMap<string, string> {
		const root = directory === undefined ? undefined : this.path(directory);
		const prefix = root === undefined ? undefined : root.endsWith(sep) ? root : `${root}${sep}`;
		const entries = new Map<string, string>();
		for (const [path, node] of this.nodes) {
			if (node.kind !== "file") continue;
			if (prefix !== undefined && !path.startsWith(prefix)) continue;
			entries.set(path, node.data.toString());
		}
		return entries;
	}

	existsSync(value: unknown): boolean {
		try {
			return this.resolveExisting(value) !== undefined;
		} catch {
			return false;
		}
	}

	/** The canonical path `value` names when it exists, following symlinks; undefined when it does not. Records nothing. */
	private resolveExisting(value: unknown): string | undefined {
		let path = this.path(value);
		const seen = new Set<string>();
		while (this.nodes.get(path)?.kind === "symlink") {
			if (seen.has(path)) return undefined;
			seen.add(path);
			path = resolve(dirname(path), this.nodes.get(path)?.target ?? "");
		}
		return this.nodes.has(path) ? path : undefined;
	}

	realpathSync(value: unknown, syscall = "realpath", kind = "realpath"): string {
		let path = this.path(value, syscall);
		const seen = new Set<string>();
		while (this.nodes.get(path)?.kind === "symlink") {
			if (seen.has(path)) throw this.failure(kind, "ELOOP", path, syscall);
			seen.add(path);
			path = resolve(dirname(path), this.nodes.get(path)?.target ?? "");
		}
		if (!this.nodes.has(path)) throw this.failure(kind, "ENOENT", path, syscall);
		return path;
	}

	readFileSync(value: unknown, options?: unknown): Buffer | string {
		if (typeof value === "number") return this.readDescriptorFile(value, options);
		const path = this.realpathSync(value, "open", "read");
		this.fault({ kind: "read", path }, "before");
		const node = this.nodes.get(path)!;
		if (node.kind !== "file") throw this.failure("read", "EISDIR", path, "read");
		this.log({ kind: "read", path, bytesRead: node.data.length });
		const encoding = typeof options === "string" ? options : (options as { encoding?: string } | undefined)?.encoding;
		return encoding ? node.data.toString(encoding as BufferEncoding) : Buffer.from(node.data);
	}

	writeFileSync(value: unknown, data: unknown, options?: unknown): void {
		if (typeof value === "number") {
			this.writeDescriptor(value, bytes(data));
			return;
		}
		const path = this.path(value);
		const flag = (options as { flag?: string } | undefined)?.flag;
		if (flag?.includes("x") && this.nodes.has(path)) throw this.failure("write", "EEXIST", path, "open");
		if (flag?.startsWith("a")) {
			this.appendFileSync(value, data);
			return;
		}
		this.fault({ kind: "write", path }, "before", bytes(data));
		if (!this.nodes.has(dirname(path))) throw this.failure("write", "ENOENT", dirname(path), "open");
		if (this.nodes.get(path)?.kind === "directory") throw this.failure("write", "EISDIR", path, "open");
		const created = !this.nodes.has(path);
		this.setFileData(path, bytes(data));
		const requestedMode = (options as { mode?: unknown } | undefined)?.mode;
		if (created && typeof requestedMode === "number") this.setMode(path, requestedMode);
		this.note("write", path);
		this.fault({ kind: "write", path }, "after", bytes(data));
	}

	/** The permission bits of a file, as `stat` reports them. Directories keep their fixed mode. */
	private setMode(path: string, mode: number): void {
		const node = this.nodes.get(path);
		if (node?.kind === "file") {
			node.mode = mode & 0o777;
			node.changed = this.stamp();
		}
	}

	appendFileSync(value: unknown, data: unknown): void {
		const path = this.path(value);
		this.fault({ kind: "append", path }, "before", bytes(data));
		const previous = this.nodes.get(path);
		if (previous && previous.kind !== "file") throw this.failure("append", "EISDIR", path, "open");
		if (!this.nodes.has(dirname(path))) throw this.failure("append", "ENOENT", dirname(path), "open");
		this.setFileData(path, previous ? Buffer.concat([previous.data, bytes(data)]) : bytes(data));
		this.note("append", path);
		this.fault({ kind: "append", path }, "after", bytes(data));
	}

	private setFileData(path: string, data: Buffer): void {
		const node = this.nodes.get(path);
		if (node) {
			node.data = data;
			node.modified = this.stamp();
			node.changed = node.modified;
		} else {
			const stamp = this.stamp();
			this.nodes.set(path, {
				kind: "file",
				data,
				modified: stamp,
				changed: stamp,
				identity: this.nextIdentity++,
			});
			this.touchDirectory(dirname(path));
		}
	}

	mkdirSync(value: unknown, options?: unknown): string | undefined {
		const path = this.path(value, "mkdir");
		const recursive = (options as { recursive?: boolean } | undefined)?.recursive === true;
		if (this.nodes.has(path)) {
			if (!recursive || this.nodes.get(path)?.kind !== "directory")
				throw this.failure("mkdir", "EEXIST", path, "mkdir");
			return undefined;
		}
		this.fault({ kind: "mkdir", path }, "before");
		const parent = dirname(path);
		if (parent !== path && !this.nodes.has(parent)) {
			if (!recursive) throw this.failure("mkdir", "ENOENT", parent, "mkdir");
			this.mkdirSync(parent, { recursive: true });
		}
		const stamp = this.stamp();
		this.nodes.set(path, {
			kind: "directory",
			data: Buffer.alloc(0),
			modified: stamp,
			changed: stamp,
			identity: this.nextIdentity++,
		});
		this.touchDirectory(parent);
		this.note("mkdir", path);
		return recursive ? path : undefined;
	}

	mkdtempSync(prefix: unknown): string {
		const start = this.path(prefix, "mkdtemp");
		const parent = dirname(start);
		if (this.nodes.get(parent)?.kind !== "directory") throw this.failure("mkdtemp", "ENOENT", parent, "mkdtemp");
		for (let attempt = 0; attempt < 1000; attempt++) {
			const path = `${start}${(this.nextTemporary++).toString(36).padStart(6, "0")}`;
			if (this.nodes.has(path)) continue;
			this.mkdirSync(path);
			this.note("mkdtemp", path);
			return path;
		}
		throw this.failure("mkdtemp", "EEXIST", start, "mkdtemp");
	}

	/**
	 * `fs.statSync` and `fs.lstatSync` with Node's `throwIfNoEntry: false`: a path that names nothing yields undefined instead of
	 * ENOENT, and records no failed operation. A descriptor always names something or fails with EBADF, so it is never absent.
	 */
	private statUnlessAbsent(value: unknown, options: unknown, lstat: boolean) {
		const quiet =
			typeof value !== "number" && (options as { throwIfNoEntry?: unknown } | undefined)?.throwIfNoEntry === false;
		if (quiet) {
			const absent = lstat ? !this.nodes.has(this.path(value)) : this.resolveExisting(value) === undefined;
			if (absent) return undefined;
		}
		return this.statSync(value, lstat ? { ...(options as object | undefined), lstat: true } : options);
	}

	statSync(value: unknown, options?: unknown) {
		const descriptor = typeof value === "number" ? this.descriptors.get(value) : undefined;
		if (typeof value === "number" && !descriptor) throw this.failure("stat", "EBADF", String(value), "fstat");
		const lstat = (options as { lstat?: boolean } | undefined)?.lstat === true;
		const syscall = descriptor ? "fstat" : lstat ? "lstat" : "stat";
		const path = descriptor
			? descriptor.path
			: lstat
				? this.path(value, syscall)
				: this.realpathSync(value, syscall, "stat");
		const node = descriptor?.node ?? this.nodes.get(path);
		if (!node) throw this.failure("stat", "ENOENT", path, syscall);
		this.fault({ kind: "stat", path }, "before");
		const changed = node.changed ?? node.modified;
		const snapshot = {
			size: node.data.length,
			mtimeMs: node.modified,
			ctimeMs: changed,
			birthtimeMs: 1000,
			atimeMs: node.modified,
			mtime: new Date(node.modified),
			ctime: new Date(changed),
			birthtime: new Date(1000),
			atime: new Date(node.modified),
			mode: node.kind === "directory" ? 0o40755 : 0o100000 | (node.mode ?? 0o644),
			dev: 1,
			ino: node.identity,
			nlink: [...this.nodes.values()].filter((linked) => linked === node).length,
			uid: 1000,
			gid: 1000,
			rdev: 0,
			blksize: 4096,
			blocks: 1,
			...fileTypeMethods(node),
		};
		if ((options as { bigint?: boolean } | undefined)?.bigint) {
			const modifiedNs = BigInt(Math.trunc(node.modified)) * 1_000_000n;
			const changedNs = BigInt(Math.trunc(changed)) * 1_000_000n;
			return {
				...snapshot,
				size: BigInt(snapshot.size),
				dev: BigInt(snapshot.dev),
				ino: BigInt(snapshot.ino),
				nlink: BigInt(snapshot.nlink),
				uid: BigInt(snapshot.uid),
				gid: BigInt(snapshot.gid),
				rdev: BigInt(snapshot.rdev),
				mode: BigInt(snapshot.mode),
				blksize: BigInt(snapshot.blksize),
				blocks: BigInt(snapshot.blocks),
				mtimeMs: BigInt(Math.trunc(snapshot.mtimeMs)),
				ctimeMs: BigInt(Math.trunc(snapshot.ctimeMs)),
				atimeMs: BigInt(Math.trunc(snapshot.atimeMs)),
				birthtimeMs: BigInt(snapshot.birthtimeMs),
				mtimeNs: modifiedNs,
				ctimeNs: changedNs,
				atimeNs: modifiedNs,
				birthtimeNs: BigInt(snapshot.birthtimeMs) * 1_000_000n,
			};
		}
		return snapshot;
	}

	readdirSync(value: unknown, options?: unknown): unknown[] {
		const path = this.realpathSync(value, "scandir", "readdir");
		if (this.nodes.get(path)?.kind !== "directory") throw this.failure("readdir", "ENOTDIR", path, "scandir");
		this.fault({ kind: "readdir", path }, "before");
		const children = [...this.nodes].filter(([child]) => child !== path && dirname(child) === path);
		const entries = children
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([child, node]) => {
				if (!(options as { withFileTypes?: boolean } | undefined)?.withFileTypes) return basename(child);
				return {
					name: basename(child),
					parentPath: path,
					path,
					...fileTypeMethods(node),
				};
			});
		// A directory syscall has captured its entries before another process's boundary callback can change the namespace.
		this.log({ kind: "readdir", path });
		this.observe({ kind: "readdir", path }, "after");
		return entries;
	}

	opendirSync(value: unknown) {
		const path = this.realpathSync(value, "opendir", "readdir");
		const entries = this.readdirSync(path, { withFileTypes: true });
		let position = 0;
		let closed = false;
		const readNext = () => {
			if (closed) throw ioError("ERR_DIR_CLOSED", path);
			return entries[position++] ?? null;
		};
		const readSettled = () => this.settled(readNext);
		const directory = {
			path,
			readSync: readNext,
			read: readSettled,
			closeSync: () => {
				closed = true;
				this.directories.delete(directory);
			},
			close: () =>
				this.settled(() => {
					closed = true;
					this.directories.delete(directory);
				}),
			// Each entry is one promise-export read, so a drain of a directory yields to the event loop per entry.
			[Symbol.asyncIterator]: async function* () {
				try {
					for (let entry = await readSettled(); entry !== null; entry = await readSettled()) yield entry;
				} finally {
					await directory.close();
				}
			},
		};
		this.directories.add(directory);
		return directory;
	}

	unlinkSync(value: unknown): void {
		const path = this.path(value, "unlink");
		this.fault({ kind: "unlink", path }, "before");
		if (!this.nodes.has(path)) throw this.failure("unlink", "ENOENT", path, "unlink");
		if (this.nodes.get(path)?.kind === "directory") throw this.failure("unlink", "EISDIR", path, "unlink");
		const node = this.nodes.get(path)!;
		this.nodes.delete(path);
		if ([...this.nodes.values()].includes(node)) node.changed = this.stamp();
		this.touchDirectory(dirname(path));
		this.note("unlink", path);
		this.fault({ kind: "unlink", path }, "after");
	}

	rmSync(value: unknown, options?: unknown, syscall = "rm"): void {
		const path = this.path(value, syscall);
		this.fault({ kind: "rm", path }, "before");
		const flags = options as { force?: boolean; recursive?: boolean } | undefined;
		if (!this.nodes.has(path)) {
			if (flags?.force) return;
			throw this.failure("rm", "ENOENT", path, syscall);
		}
		const children = [...this.nodes.keys()].filter((child) => child.startsWith(`${path}${sep}`));
		if (children.length && !flags?.recursive) throw this.failure("rm", "ENOTEMPTY", path, syscall);
		for (const child of children) this.nodes.delete(child);
		this.nodes.delete(path);
		this.touchDirectory(dirname(path));
		this.note("rm", path);
		this.fault({ kind: "rm", path }, "after");
	}

	renameSync(source: unknown, destination: unknown): void {
		const from = this.path(source, "rename");
		const to = this.path(destination, "rename");
		this.fault({ kind: "rename", path: from, destination: to }, "before");
		if (!this.nodes.has(from) || !this.nodes.has(dirname(to)))
			throw this.failure("rename", "ENOENT", from, "rename", to);
		const entries = [...this.nodes].filter(([path]) => path === from || path.startsWith(`${from}${sep}`));
		const stamp = this.stamp();
		for (const [path, node] of entries) {
			this.nodes.delete(path);
			if (path === from) node.changed = stamp;
			this.nodes.set(`${to}${path.slice(from.length)}`, node);
		}
		this.touchDirectory(dirname(from));
		if (dirname(to) !== dirname(from)) this.touchDirectory(dirname(to));
		for (const descriptor of this.descriptors.values()) if (descriptor.path === from) descriptor.path = to;
		this.log({ kind: "rename", path: from, destination: to });
		this.note("change", to);
		this.fault({ kind: "rename", path: from, destination: to }, "after");
	}

	/** A hard link is a second path to the same node: shared bytes, identity and link count. */
	linkSync(existing: unknown, created: unknown): void {
		const from = this.path(existing, "link");
		const to = this.path(created, "link");
		this.fault({ kind: "link", path: from, destination: to }, "before");
		const node = this.nodes.get(from);
		if (!node || !this.nodes.has(dirname(to))) throw this.failure("link", "ENOENT", from, "link", to);
		if (node.kind === "directory") throw this.failure("link", "EPERM", from, "link", to);
		if (this.nodes.has(to)) throw this.failure("link", "EEXIST", to, "link", from);
		this.nodes.set(to, node);
		node.changed = this.stamp();
		this.touchDirectory(dirname(to));
		this.log({ kind: "link", path: from, destination: to });
		this.note("change", to);
		this.fault({ kind: "link", path: from, destination: to }, "after");
	}

	copyFileSync(source: unknown, destination: unknown, flags = 0): void {
		const from = this.realpathSync(source, "copyfile", "copy");
		const to = this.path(destination, "copyfile");
		if ((flags & fs.constants.COPYFILE_EXCL) !== 0 && this.nodes.has(to))
			throw this.failure("copy", "EEXIST", to, "copyfile");
		this.writeFileSync(to, this.readFileSync(from));
		this.log({ kind: "copy", path: from, destination: to });
	}

	openSync(value: unknown, flags: unknown, creationMode?: unknown): number {
		const path = this.path(value);
		const mode = decodeOpenFlags(flags);
		const creation = typeof creationMode === "number" ? { mode: creationMode } : undefined;
		this.fault({ kind: "open", path, flags: typeof flags === "string" ? flags : String(flags) }, "before");
		if (mode.exclusive && this.nodes.has(path)) throw this.failure("open", "EEXIST", path, "open");
		if (mode.truncate && (mode.create || this.nodes.has(path))) this.writeFileSync(path, "", creation);
		else if (mode.create && !this.nodes.has(path)) this.writeFileSync(path, "", creation);
		else if (!this.nodes.has(path)) throw this.failure("open", "ENOENT", path, "open");
		const fd = this.nextDescriptor++;
		this.descriptors.set(fd, {
			...(process.env.PI_HARNESS_TRACE_OPENS ? { openedAt: new Error("opened here").stack } : {}),
			path,
			node: this.nodes.get(path)!,
			position: 0,
			append: mode.append,
			writable: mode.writable,
		});
		return fd;
	}

	open(value: unknown, flags: unknown) {
		return this.settled(() => this.openHandle(value, flags));
	}

	private openHandle(value: unknown, flags: unknown) {
		const descriptor = this.openSync(value, flags);
		let closed = false;
		return {
			get fd() {
				return closed ? -1 : descriptor;
			},
			read: (buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset, position: number | null = null) =>
				this.settled(() => ({
					bytesRead: this.readDescriptor(descriptor, buffer, offset, length, position),
					buffer,
				})),
			write: (buffer: Uint8Array | string, offset = 0, length?: number, position: number | null = null) =>
				this.settled(() => {
					const data = bytes(buffer);
					const selected =
						typeof buffer === "string" ? data : data.subarray(offset, offset + (length ?? data.length - offset));
					return { bytesWritten: this.writeDescriptor(descriptor, selected, position), buffer };
				}),
			readFile: (options?: unknown) => this.settled(() => this.readDescriptorFile(descriptor, options)),
			createReadStream: (options?: {
				encoding?: BufferEncoding;
				start?: number;
				end?: number;
				signal?: AbortSignal;
			}) => {
				const stream = new PassThrough({
					...(options?.encoding ? { encoding: options.encoding } : {}),
					...(options?.signal ? { signal: options.signal } : {}),
				});
				this.streams.add(stream);
				stream.once("close", () => this.streams.delete(stream));
				queueMicrotask(() => {
					try {
						stream.end(this.readDescriptorRange(descriptor, options?.start ?? 0, options?.end));
					} catch (error) {
						stream.destroy(error instanceof Error ? error : new Error(String(error)));
					}
				});
				return stream;
			},
			writeFile: (data: unknown) =>
				this.settled(() => {
					this.writeDescriptor(descriptor, bytes(data));
				}),
			appendFile: (data: unknown) =>
				this.settled(() => {
					this.writeDescriptor(descriptor, bytes(data), Number(this.statSync(descriptor).size));
				}),
			stat: (options?: unknown) => this.settled(() => this.statSync(descriptor, options)),
			truncate: (length = 0) => this.settled(() => this.truncateDescriptor(descriptor, length)),
			sync: () =>
				this.settled(() => {
					this.path(descriptor);
				}),
			datasync: () =>
				this.settled(() => {
					this.path(descriptor);
				}),
			close: () =>
				this.settled(() => {
					if (!closed) {
						closed = true;
						this.closeSync(descriptor);
					}
				}),
		};
	}

	closeSync(fd: unknown): void {
		if (typeof fd !== "number" || !this.descriptors.delete(fd))
			throw this.failure("close", "EBADF", String(fd), "close");
	}

	/**
	 * Event-driven wait for durable state: `holds` is evaluated now and then on a later turn after every modeled mutation
	 * (write, rename, removal) and after every settle batch of the promise exports (a read can move an owner's state too),
	 * never on a timer. The caller bounds the wait with its own deadline.
	 */
	waitForMutation(holds: () => boolean): Promise<void> {
		if (holds()) return Promise.resolve();
		return new Promise((resolve, reject) => {
			this.mutationWaiters.add({ holds, resolve, reject });
		});
	}

	assertNoOpenResources(): void {
		if (this.descriptors.size || this.watchers.size || this.streams.size || this.directories.size) {
			// The paths of the open files name the owner that never closed them.
			const open = [...this.descriptors.values()]
				.slice(0, 8)
				.map((file) => (file.openedAt ? `${file.path} (${file.openedAt})` : file.path));
			throw new Error(
				`Virtual IO leaked: files=${this.descriptors.size}; watchers=${this.watchers.size}; streams=${this.streams.size}; directories=${this.directories.size}${open.length ? `; open=${open.join(", ")}` : ""}`,
			);
		}
	}

	/** Derive only already-open physical observers; inspection never creates or closes one. */
	getWatcherSnapshot(): readonly VirtualWatcherSnapshot[] {
		return [...this.watchers].map((record) => ({
			id: record.id,
			path: record.path,
			recursive: record.recursive,
			listenerCount: record.emitter.eventNames().reduce((sum, name) => sum + record.emitter.listenerCount(name), 0),
		}));
	}

	/** Deliver an error through an existing watched handle, preserving the real listener and close lifecycle. */
	emitWatcherError(id: number, error: Error): void {
		const watcher = [...this.watchers].find((record) => record.id === id);
		if (!watcher) throw new Error(`No active virtual watcher ${id}`);
		watcher.emitter.emit("error", error);
	}

	/**
	 * External transport cutoff ONLY after a scenario proves this exact observer was retained by a failed
	 * native cleanup. It does not invoke/repair the native disposer or remove any native fence.
	 */
	cutoffRetainedWatcher(expected: Pick<VirtualWatcherSnapshot, "id" | "path">): void {
		const matches = [...this.watchers].filter((record) => record.id === expected.id && record.path === expected.path);
		if (matches.length !== 1) throw new Error(`No exact retained watcher ${expected.id} at ${expected.path}`);
		this.closeWatcher(matches[0]!, "cutoff");
	}

	private closeWatcher(record: VirtualWatcher, reason: "close" | "cutoff"): void {
		if (!this.watchers.delete(record)) return;
		record.emitter.removeAllListeners();
		if (this.watcherClosures.length === 256) this.watcherClosures.shift();
		this.watcherClosures.push({ id: record.id, path: record.path, reason });
	}

	nodeFsPromisesExports(): Record<string, unknown> {
		return {
			mkdtemp: (prefix: unknown) => this.settled(() => this.mkdtempSync(prefix)),
			opendir: (path: unknown) => this.settled(() => this.opendirSync(path)),
			open: (path: unknown, flags: unknown) => this.open(path, flags),
			readFile: (path: unknown, options?: unknown) => {
				const target = this.holdPath(path);
				return this.whenReleased(
					"readFile",
					target === undefined ? undefined : { kind: "read", path: target },
					() => this.readFileSync(path, options),
				);
			},
			writeFile: (path: unknown, data: unknown, options?: unknown) => {
				const target = this.holdPath(path);
				return this.whenReleased(
					"writeFile",
					target === undefined ? undefined : { kind: "write", path: target },
					() => this.writeFileSync(path, data, options),
				);
			},
			appendFile: (path: unknown, data: unknown) => this.settled(() => this.appendFileSync(path, data)),
			mkdir: (path: unknown, options?: unknown) => {
				const target = this.holdPath(path);
				return this.whenReleased("mkdir", target === undefined ? undefined : { kind: "mkdir", path: target }, () =>
					this.mkdirSync(path, options),
				);
			},
			readdir: (path: unknown, options?: unknown) => {
				const target = this.holdPath(path);
				return this.whenReleased(
					"readdir",
					target === undefined ? undefined : { kind: "readdir", path: target },
					() => this.readdirSync(path, options),
				);
			},
			stat: (path: unknown, options?: unknown) => this.settled(() => this.statSync(path, options)),
			lstat: (path: unknown, options?: unknown) =>
				this.settled(() => this.statSync(path, { ...(options as { bigint?: boolean } | undefined), lstat: true })),
			access: (path: unknown) =>
				this.settled(() => {
					this.note("access", this.realpathSync(path, "access", "access"));
				}),
			realpath: (path: unknown) => this.settled(() => this.realpathSync(path)),
			unlink: (path: unknown) => this.settled(() => this.unlinkSync(path)),
			rm: (path: unknown, options?: unknown) => this.settled(() => this.rmSync(path, options)),
			rmdir: (path: unknown) => this.settled(() => this.rmSync(path, undefined, "rmdir")),
			rename: (from: unknown, to: unknown) => {
				const source = this.holdPath(from);
				const target = this.holdPath(to);
				return this.whenReleased(
					"rename",
					source === undefined || target === undefined
						? undefined
						: { kind: "rename", path: source, destination: target },
					() => this.renameSync(from, to),
				);
			},
			copyFile: (from: unknown, to: unknown, flags?: number) =>
				this.settled(() => this.copyFileSync(from, to, flags)),
			truncate: (path: unknown, length = 0) => this.settled(() => this.truncateSync(path, Number(length))),
			chmod: (path: unknown, mode: unknown) =>
				this.settled(() => {
					const resolved = this.realpathSync(path, "chmod", "chmod");
					if (typeof mode === "number") this.setMode(resolved, mode);
				}),
			utimes: (path: unknown, _atime: unknown, mtime: unknown) => this.settled(() => this.setTimes(path, mtime)),
		};
	}

	nodeFsExports(): Record<string, unknown> {
		const api: Record<string, unknown> = {
			constants: fs.constants,
			promises: this.nodeFsPromisesExports(),
			existsSync: (path: unknown) => this.existsSync(path),
			readFileSync: (path: unknown, options?: unknown) => this.readFileSync(path, options),
			writeFileSync: (path: unknown, data: unknown, options?: unknown) => this.writeFileSync(path, data, options),
			appendFileSync: (path: unknown, data: unknown) => this.appendFileSync(path, data),
			mkdirSync: (path: unknown, options?: unknown) => this.mkdirSync(path, options),
			mkdtempSync: (prefix: unknown) => this.mkdtempSync(prefix),
			readdirSync: (path: unknown, options?: unknown) => this.readdirSync(path, options),
			opendirSync: (path: unknown) => this.opendirSync(path),
			statSync: (path: unknown, options?: unknown) => this.statUnlessAbsent(path, options, false),
			fstatSync: (fd: unknown, options?: unknown) => this.statSync(fd, options),
			lstatSync: (path: unknown, options?: unknown) => this.statUnlessAbsent(path, options, true),
			realpathSync: Object.assign((path: unknown) => this.realpathSync(path), {
				native: (path: unknown) => this.realpathSync(path),
			}),
			accessSync: (path: unknown) => {
				this.realpathSync(path, "access", "access");
			},
			unlinkSync: (path: unknown) => this.unlinkSync(path),
			rmSync: (path: unknown, options?: unknown) => this.rmSync(path, options),
			rmdirSync: (path: unknown) => this.rmSync(path, undefined, "rmdir"),
			renameSync: (from: unknown, to: unknown) => this.renameSync(from, to),
			copyFileSync: (from: unknown, to: unknown, flags?: number) => this.copyFileSync(from, to, flags),
			linkSync: (existing: unknown, created: unknown) => this.linkSync(existing, created),
			truncateSync: (path: unknown, length = 0) => this.truncateSync(path, Number(length)),
			ftruncateSync: (fd: unknown, length = 0) => this.truncateSync(fd, Number(length)),
			chmodSync: (path: unknown, mode: unknown) => {
				const resolved = this.realpathSync(path, "chmod", "chmod");
				if (typeof mode === "number") this.setMode(resolved, mode);
			},
			utimesSync: (path: unknown, _atime: unknown, mtime: unknown) => this.setTimes(path, mtime),
			openSync: (path: unknown, flags: unknown, mode?: unknown) => this.openSync(path, flags, mode),
			closeSync: (fd: unknown) => this.closeSync(fd),
			fsyncSync: (fd: unknown) => {
				this.path(fd);
			},
			readSync: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null) =>
				this.readDescriptor(fd, buffer, offset, length, position),
			writeSync: (fd: number, data: unknown, offset?: number, length?: number, position?: number | null) =>
				this.writeDescriptor(
					fd,
					bytes(data).subarray(offset ?? 0, (offset ?? 0) + (length ?? bytes(data).length)),
					position,
				),
			createReadStream: (path: unknown) => {
				const stream = new PassThrough();
				this.streams.add(stream);
				stream.once("close", () => this.streams.delete(stream));
				queueMicrotask(() => {
					try {
						stream.end(this.readFileSync(path));
					} catch (error) {
						stream.destroy(error instanceof Error ? error : new Error(String(error)));
					}
				});
				return stream;
			},
			createWriteStream: (path: unknown, options?: unknown) => {
				const chunks: Buffer[] = [];
				const stream = new Writable({
					write(chunk: unknown, _encoding, callback) {
						chunks.push(bytes(chunk));
						callback();
					},
					final: (callback) => {
						try {
							this.writeFileSync(path, Buffer.concat(chunks), options);
							callback();
						} catch (error) {
							callback(error instanceof Error ? error : new Error(String(error)));
						}
					},
				});
				this.streams.add(stream);
				stream.once("close", () => this.streams.delete(stream));
				return stream;
			},
			watch: (value: unknown, options?: unknown, listener?: unknown) => {
				const path = this.realpathSync(value);
				this.fault({ kind: "watch", path }, "before");
				if (this.watchers.size >= 256) throw new Error("Virtual watcher admission exceeds bounded capacity");
				const emitter = new EventEmitter();
				const record = {
					id: this.nextWatcher++,
					path,
					emitter,
					recursive: (options as { recursive?: boolean } | undefined)?.recursive === true,
				};
				this.watchers.add(record);
				const callback = typeof options === "function" ? options : listener;
				if (typeof callback === "function") emitter.on("change", (event, name) => callback(event, name));
				return Object.assign(emitter, {
					close: () => {
						this.fault({ kind: "watch.close", path }, "before");
						this.closeWatcher(record, "close");
						this.fault({ kind: "watch.close", path }, "after");
					},
					ref: () => emitter,
					unref: () => emitter,
				});
			},
		};
		for (const [name, operation] of Object.entries(this.nodeFsPromisesExports())) {
			if (typeof operation !== "function") continue;
			api[name] = (...arguments_: unknown[]) => {
				const callback = arguments_.pop();
				if (typeof callback !== "function") throw new TypeError(`fs.${name} requires a callback`);
				const callbackPath = name === "readdir" ? this.holdPath(arguments_[0]) : undefined;
				Promise.resolve()
					.then(() => operation(...arguments_))
					.then(
						(result) => {
							try {
								callback(null, result);
							} finally {
								if (callbackPath !== undefined)
									this.observe({ kind: "readdir.callback", path: callbackPath }, "after");
							}
						},
						(error) => {
							callback(error);
						},
					);
			};
		}
		api.open = (path: unknown, flags: unknown, optionsOrCallback: unknown, optionalCallback?: unknown) => {
			const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback;
			if (typeof callback !== "function") throw new TypeError("fs.open requires callback");
			queueMicrotask(() => {
				try {
					callback(null, this.openSync(path, flags));
				} catch (error) {
					callback(error);
				}
			});
		};
		api.close = (fd: unknown, callback: unknown) => {
			if (typeof callback !== "function") throw new TypeError("fs.close requires callback");
			queueMicrotask(() => {
				try {
					this.closeSync(fd);
					callback(null);
				} catch (error) {
					callback(error);
				}
			});
		};
		api.fstat = (fd: unknown, optionsOrCallback: unknown, optionalCallback?: unknown) => {
			const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : optionalCallback;
			if (typeof callback !== "function") throw new TypeError("fs.fstat requires callback");
			queueMicrotask(() => {
				try {
					callback(null, this.statSync(fd, optionsOrCallback));
				} catch (error) {
					callback(error);
				}
			});
		};
		return api;
	}

	private fileDescriptor(fd: number): OpenFile {
		const descriptor = this.descriptors.get(fd);
		if (!descriptor) throw this.failure("read", "EBADF", String(fd), "read");
		if (descriptor.node.kind !== "file") throw this.failure("read", "EISDIR", descriptor.path, "read");
		return descriptor;
	}

	private readDescriptorFile(fd: number, options?: unknown): Buffer | string {
		const descriptor = this.fileDescriptor(fd);
		this.fault({ kind: "read", path: descriptor.path }, "before");
		const node = descriptor.node;
		const result = node.data.subarray(descriptor.position);
		descriptor.position = node.data.length;
		const encoding = typeof options === "string" ? options : (options as { encoding?: string } | undefined)?.encoding;
		this.log({ kind: "read", path: descriptor.path, bytesRead: result.length });
		return encoding ? result.toString(encoding as BufferEncoding) : Buffer.from(result);
	}

	/** An inclusive byte range of the open file, as a handle read stream delivers it; the descriptor position is untouched. */
	private readDescriptorRange(fd: number, start: number, end?: number): Buffer {
		const descriptor = this.fileDescriptor(fd);
		this.fault({ kind: "read", path: descriptor.path }, "before");
		const data = descriptor.node.data;
		const result = Buffer.from(data.subarray(start, end === undefined ? data.length : end + 1));
		this.log({ kind: "read", path: descriptor.path, bytesRead: result.length });
		return result;
	}

	private readDescriptor(
		fd: number,
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number | null,
	): number {
		const descriptor = this.fileDescriptor(fd);
		this.fault({ kind: "read", path: descriptor.path }, "before");
		const node = descriptor.node;
		const start = position ?? descriptor.position;
		const amount = Math.max(0, Math.min(length, node.data.length - start));
		buffer.set(node.data.subarray(start, start + amount), offset);
		if (position === null) descriptor.position += amount;
		this.log({ kind: "read", path: descriptor.path, bytesRead: amount });
		return amount;
	}

	private writeDescriptor(fd: number, data: Buffer, position?: number | null): number {
		const descriptor = this.descriptors.get(fd);
		if (!descriptor) throw this.failure("write", "EBADF", String(fd), "write");
		if (!descriptor.writable) throw this.failure("write", "EBADF", descriptor.path, "write");
		const node = descriptor.node;
		if (node?.kind !== "file") throw this.failure("write", "EISDIR", descriptor.path, "write");
		const operation = descriptor.append ? "append" : "write";
		this.fault({ kind: operation, path: descriptor.path }, "before", data);
		const start = descriptor.append ? node.data.length : (position ?? descriptor.position);
		const replacement = Buffer.alloc(Math.max(node.data.length, start + data.length));
		node.data.copy(replacement);
		data.copy(replacement, start);
		node.data = replacement;
		node.modified = this.stamp();
		node.changed = node.modified;
		if (position === null || position === undefined) descriptor.position = start + data.length;
		this.note(operation, descriptor.path);
		this.fault({ kind: operation, path: descriptor.path }, "after", data);
		return data.length;
	}

	truncateSync(value: unknown, length = 0): void {
		if (typeof value === "number") {
			this.truncateDescriptor(value, length);
			return;
		}
		const path = this.realpathSync(value, "truncate", "write");
		const node = this.nodes.get(path);
		if (!node) throw this.failure("write", "ENOENT", path, "truncate");
		if (node.kind !== "file") throw this.failure("write", "EISDIR", path, "truncate");
		if (!Number.isSafeInteger(length) || length < 0) throw this.failure("write", "EINVAL", path, "truncate");
		const replacement = Buffer.alloc(length);
		node.data.copy(replacement, 0, 0, length);
		this.fault({ kind: "write", path }, "before", replacement);
		node.data = replacement;
		node.modified = this.stamp();
		node.changed = node.modified;
		this.note("truncate", path);
		this.fault({ kind: "write", path }, "after", replacement);
	}

	private truncateDescriptor(fd: number, length: number): void {
		const descriptor = this.descriptors.get(fd);
		if (!descriptor?.writable) throw this.failure("truncate", "EBADF", String(fd), "ftruncate");
		if (!Number.isSafeInteger(length) || length < 0)
			throw this.failure("truncate", "EINVAL", descriptor.path, "ftruncate");
		const node = descriptor.node;
		const replacement = Buffer.alloc(length);
		node.data.copy(replacement, 0, 0, length);
		node.data = replacement;
		node.modified = this.stamp();
		node.changed = node.modified;
		this.note("truncate", descriptor.path);
	}

	private setTimes(value: unknown, mtime: unknown): void {
		const path = this.realpathSync(value, "utime", "utimes");
		const milliseconds = mtime instanceof Date ? mtime.getTime() : Number(mtime) * 1000;
		if (!Number.isFinite(milliseconds)) throw new TypeError("Virtual utimes requires finite time");
		const node = this.nodes.get(path)!;
		node.modified = milliseconds;
		node.changed = this.stamp();
		this.note("utimes", path);
	}

	/**
	 * Re-reads every {@link waitForMutation} condition on a later turn: after a modeled file mutation, and after a RAM
	 * SQLite statement commits, so a condition on queue rows is read after the write that settles it even when no file
	 * is written afterwards.
	 */
	wakeMutationWaiters(): void {
		if (this.mutationWaiters.size === 0) return;
		// A later turn: the owner that wrote finishes its synchronous bookkeeping before the condition is read.
		setImmediate(() => {
			for (const waiter of [...this.mutationWaiters]) {
				try {
					if (!waiter.holds()) continue;
					this.mutationWaiters.delete(waiter);
					waiter.resolve();
				} catch (error) {
					this.mutationWaiters.delete(waiter);
					waiter.reject(error);
				}
			}
		});
	}

	private note(kind: string, path: string): void {
		this.log({ kind, path });
		if (!WATCH_CHANGE_OPERATIONS.has(kind)) return;
		this.wakeMutationWaiters();
		for (const record of this.watchers) {
			if (
				record.path === path ||
				dirname(path) === record.path ||
				(record.recursive && path.startsWith(`${record.path}${sep}`))
			) {
				queueMicrotask(() => {
					if (this.watchers.has(record)) record.emitter.emit("change", "change", basename(path));
				});
			}
		}
	}
}

export interface EffectPorts {
	/** All allowed process operations return scripted results, never call the original function. */
	process?(operation: string, arguments_: readonly unknown[]): unknown;
	/** Virtual process-table signaling/liveness. No signal is sent to a host process. */
	signal?(pid: number, signal?: NodeJS.Signals | number): boolean;
	/** Current virtual generation's PID, read by the real owner-id constructors; restored with the guard. */
	pid?(): number;
	fetch?: typeof globalThis.fetch;
	/**
	 * The scripted socket one `new WebSocket(url, protocols)` returns, or undefined to refuse it. Without this port every
	 * construction is refused; either way no socket leaves the process.
	 */
	webSocket?: (url: string, protocols: unknown) => object | undefined;
	/** Keep the native SQL engine but route every database's storage to RAM. */
	sqlite?: "memory";
	/** An in-memory network of unix-socket endpoints in place of the refused `net` entry points. Nothing leaves the process. */
	net?: VirtualNetwork;
}

/**
 * Whether two own-property descriptors describe the same property, or both are absent. Only descriptor fields are compared: no
 * property value is read, so a lazy global is not evaluated by the check.
 */
function sameOwnProperty(actual: PropertyDescriptor | undefined, expected: PropertyDescriptor | undefined): boolean {
	if (actual === undefined || expected === undefined) return actual === expected;
	return (
		actual.value === expected.value &&
		actual.get === expected.get &&
		actual.set === expected.set &&
		actual.writable === expected.writable &&
		actual.enumerable === expected.enumerable &&
		actual.configurable === expected.configurable
	);
}

/** The globals the guard keeps pinned to its ports for the whole world. */
type PinnedGlobal = "fetch" | "WebSocket";

/** Installs at the external builtin boundary, before constructing any production session. */
export class EffectGuard {
	readonly escapes: string[] = [];
	readonly effects: Array<{ kind: string; arguments: readonly unknown[] }> = [];
	private readonly io: VirtualFileSystem;
	private readonly ports: EffectPorts;
	private readonly restore: Array<() => void> = [];
	/** What each restore must leave behind, checked once the restores have run (see {@link dispose}). */
	private readonly restored: Array<{ readonly label: string; readonly holds: () => boolean }> = [];
	/** Each pinned global (fetch, WebSocket) as installed: a redefinition that bypassed its setter no longer matches it at dispose. */
	private readonly pinnedGlobals = new Map<PinnedGlobal, PropertyDescriptor | undefined>();
	private readonly sqlite: VirtualSqlite;
	private readonly workerThreads: VirtualWorkerThreads;
	private installed = false;

	constructor(io: VirtualFileSystem, ports: EffectPorts = {}) {
		this.io = io;
		this.ports = ports;
		this.sqlite = new VirtualSqlite(
			io,
			(kind) => this.reject(kind),
			() => io.wakeMutationWaiters(),
		);
		this.workerThreads = new VirtualWorkerThreads(
			(kind) => this.reject(kind),
			(callback) => io.runInWorker(callback),
		);
	}

	install(): void {
		if (this.installed) throw new Error("Effect guard is already installed");
		if (builtinBoundary.hasActiveWorld) throw new Error("A virtual IO world already owns the builtin boundary");
		if (typeof builtinBoundary.original("fs", "readFileSync") !== "function") {
			throw new Error("Import builtin-install before production modules and EffectGuard");
		}
		this.installed = true;
		try {
			const filesystem = this.io.nodeFsExports();
			builtinBoundary.resetEvidence();
			builtinBoundary.set("fs", filesystem);
			builtinBoundary.set("fsPromises", this.io.nodeFsPromisesExports());
			this.restore.push(() => builtinBoundary.clear());
			if (this.ports.pid) {
				for (const target of new Set([process, nativeProcess])) {
					const originalPid = Object.getOwnPropertyDescriptor(target, "pid");
					if (!originalPid?.configurable) throw new Error("Cannot install virtual process identity");
					Object.defineProperty(target, "pid", {
						configurable: true,
						enumerable: originalPid.enumerable,
						get: this.ports.pid,
					});
					this.restore.push(() => Object.defineProperty(target, "pid", originalPid));
				}
			}
			const reject =
				(kind: string) =>
				(..._arguments: unknown[]): never => {
					return this.reject(kind);
				};
			// Keep module exports as stable dispatchers: a lazy importer must never capture a world closure.
			// The shared boundary rejects every active-world export absent from these adapter tables.
			this.pinGlobal("fetch", this.ports.fetch ?? reject("fetch"));
			this.pinGlobal("WebSocket", this.webSocketPort());
			this.restoreUndiciInstallState();
			const processExports: Record<string, unknown> = {};
			for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
				const implementation = (...arguments_: unknown[]) => {
					this.effects.push({ kind: `process.${name}`, arguments: arguments_ });
					if (!this.ports.process) return reject(`process.${name}`)(...arguments_);
					return this.ports.process(name, arguments_);
				};
				processExports[name] = implementation;
			}
			builtinBoundary.set("process", processExports);
			builtinBoundary.set("hostProcess", {
				kill: (pid: number, signal?: NodeJS.Signals | number) => {
					this.effects.push({ kind: "process.kill", arguments: [pid, signal] });
					if (!this.ports.signal) return reject("process.kill")(pid, signal);
					return this.ports.signal(pid, signal);
				},
			});
			for (const target of [http, https]) {
				this.replace(target, "request", reject("http.request"));
				this.replace(target, "get", reject("http.get"));
			}
			const network = this.ports.net;
			for (const name of ["connect", "createConnection", "createServer"]) {
				const port = name === "createServer" ? network?.createServer : network?.connect;
				this.replace(net, name, port ?? reject(`net.${name}`));
			}
			this.replace(net.Socket.prototype, "connect", reject("net.Socket.connect"));
			this.replace(net.Server.prototype, "listen", reject("net.Server.listen"));
			this.replace(tls, "connect", reject("tls.connect"));
			// A constructible class: the boundary reaches it through Reflect.construct, so a refusal is recorded, never a TypeError.
			if (process.getBuiltinModule("node:worker_threads")) {
				builtinBoundary.set("workerThreads", { Worker: this.workerThreads.Worker });
			}
			const sqlite = process.getBuiltinModule("node:sqlite");
			if (sqlite) {
				const original = builtinBoundary.original("sqlite", "DatabaseSync") ?? Reflect.get(sqlite, "DatabaseSync");
				if (typeof original !== "function") throw new Error("SQLite constructor unavailable");
				const DatabaseSync = new Proxy(original, {
					construct: (target, arguments_) => {
						if (this.ports.sqlite !== "memory") return reject("sqlite.DatabaseSync")(...arguments_);
						this.effects.push({ kind: "sqlite.memory", arguments: arguments_ });
						return this.sqlite.open(target as typeof NativeDatabaseSync, arguments_);
					},
				});
				builtinBoundary.set("sqlite", { DatabaseSync });
			}
			syncBuiltinESMExports();
		} catch (error) {
			try {
				this.dispose();
			} catch (cleanup) {
				throw new AggregateError([error, cleanup], "Effect guard installation and rollback failed");
			}
			throw error;
		}
	}

	assertNoEscapes(): void {
		const failures: unknown[] = [];
		try {
			builtinBoundary.assertClean();
		} catch (error) {
			failures.push(error);
		}
		if (this.escapes.length)
			failures.push(new Error(`IO attempts refused by the harness: ${this.escapes.join(", ")}`));
		if (failures.length) throw new AggregateError(failures, "External effect boundary violations");
	}

	/** Every started worker exited through its owner, and every scripted worker intercept was reached. */
	assertWorkersSettled(): void {
		this.workerThreads.assertNoLiveWorkers();
		this.workerThreads.assertNoPendingIntercepts();
	}

	/** The world's worker-thread boundary, for scenario observation of started workers and their inbound requests. */
	get threads(): VirtualWorkerThreads {
		return this.workerThreads;
	}

	/** The paths of the application SQLite handles open now, in open order. */
	openSqliteHandles(): readonly string[] {
		return this.sqlite.openHandles();
	}

	assertNoOpenSqliteHandles(): void {
		const handles = this.sqlite.openHandles();
		if (handles.length) throw new Error(`Application SQLite handles leaked: ${handles.join(", ")}`);
	}

	failNextSqliteOperation(operation: SqliteFaultOperation, sql: string, result?: SqliteFaultResult): void {
		this.sqlite.failNext(operation, sql, result);
	}

	/** A persistent SQLite fault (see {@link VirtualSqlite.denyUntilCleared}); the close checks it was hit and cleared. */
	denySqliteUntilCleared(fault: Parameters<VirtualSqlite["denyUntilCleared"]>[0]): SqliteDenial {
		return this.sqlite.denyUntilCleared(fault);
	}

	/** Committed rows of one file database, for scenario inspection; see {@link VirtualSqlite.peek}. */
	peekSqlite(path: string, sql: string, ...parameters: SQLInputValue[]): Record<string, SQLOutputValue>[] | undefined {
		return this.sqlite.peek(path, sql, ...parameters);
	}

	/** The committed state of every RAM SQLite backing now: a durable point a crash cut can rewind to. */
	snapshotSqlite(): VirtualSqliteSnapshot {
		return this.sqlite.snapshot();
	}

	/** Rewinds every RAM SQLite backing to `snapshot`; refused while an application handle is open on any backing. */
	rewindSqlite(snapshot: VirtualSqliteSnapshot): void {
		this.sqlite.rewind(snapshot);
	}

	assertSqliteFaultsConsumed(): void {
		this.sqlite.assertFaultsConsumed();
	}

	/** The world has stopped all sessions before restoring globals; release only the production owner's pools. */
	async retireHttpDispatchers(): Promise<void> {
		await disposeHttpDispatcher();
	}

	dispose(): void {
		this.installed = false;
		const failures: unknown[] = [];
		this.workerThreads.cutoff();
		try {
			this.sqlite.dispose();
		} catch (error) {
			failures.push(error);
		}
		// A replacement of the pinned fetch is recorded by its setter and never installed; a redefinition would have bypassed that, so the
		// pin must still be the property the guard installed when the restores run.
		for (const [name, pinned] of this.pinnedGlobals) {
			if (!sameOwnProperty(Object.getOwnPropertyDescriptor(globalThis, name), pinned))
				failures.push(new Error(`globalThis.${name} was redefined outside the effect guard`));
		}
		for (const restore of this.restore.reverse()) {
			try {
				restore();
			} catch (error) {
				failures.push(error);
			}
		}
		this.restore.length = 0;
		// Each restore is judged by the state captured at install, not by its return: a restore that returns but leaves the property changed is
		// reported here, and the failed-body close carries it with the body's own failure.
		for (const { label, holds } of this.restored) {
			if (!holds()) failures.push(new Error(`Effect guard restore did not take: ${label}`));
		}
		this.restored.length = 0;
		this.pinnedGlobals.clear();
		try {
			syncBuiltinESMExports();
		} catch (error) {
			failures.push(error);
		}
		if (failures.length) throw new AggregateError(failures, "Effect guard cleanup failed");
	}

	private reject(kind: string): never {
		this.escapes.push(kind);
		throw new Error(`IO operation refused by the harness: ${kind}`);
	}

	private replace(target: object, name: string, value: unknown): void {
		const descriptor = Object.getOwnPropertyDescriptor(target, name);
		if (descriptor && !descriptor.configurable && !descriptor.writable) throw new Error(`Cannot guard ${name}`);
		Object.defineProperty(target, name, {
			configurable: true,
			writable: true,
			enumerable: descriptor?.enumerable ?? true,
			value,
		});
		this.restore.push(() => {
			if (descriptor) Object.defineProperty(target, name, descriptor);
			else Reflect.deleteProperty(target, name);
		});
	}

	/**
	 * Production reinstalls the global fetch and WebSocket as undici's (configureHttpDispatcher's `undici.install()`, reached from
	 * InteractiveMode's runtime settings), by assignment. A plain value would let that replacement bypass the port and reach undici's
	 * sockets, so each pinned global is an accessor that stays the port until dispose; each replacement is recorded as an effect and
	 * never installed.
	 */
	private pinGlobal(name: PinnedGlobal, port: unknown): void {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
		if (descriptor && !descriptor.configurable) throw new Error(`Cannot guard ${name}`);
		Object.defineProperty(globalThis, name, {
			configurable: true,
			enumerable: descriptor?.enumerable ?? true,
			get: () => port,
			set: (replacement: unknown) => {
				this.effects.push({ kind: `globalThis.${name}`, arguments: [replacement] });
			},
		});
		this.pinnedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		this.restore.push(() => {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		});
		this.restored.push({
			label: `globalThis.${name}`,
			holds: () => sameOwnProperty(Object.getOwnPropertyDescriptor(globalThis, name), descriptor),
		});
	}

	/**
	 * A constructible stand-in for the WebSocket class: `new WebSocket(url, protocols)` returns the world's scripted socket, or is
	 * refused and recorded as an escape. A real socket would reach the refused `net`/`tls` entry points anyway; this refuses it at once.
	 */
	private webSocketPort(): unknown {
		const port = this.ports.webSocket;
		const constants = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
		const target = Object.assign(function WebSocket(): void {}, constants);
		return new Proxy(target, {
			construct: (_target, arguments_: unknown[]) => {
				return port?.(String(arguments_[0]), arguments_[1]) ?? this.reject("WebSocket");
			},
		});
	}

	/**
	 * The same production install (`undici.install()`) also replaces these globals and the process-wide undici dispatcher. Production may
	 * do that during a world, so the world restores what it found at dispose and the next world starts from the same process state.
	 */
	private restoreUndiciInstallState(): void {
		const dispatcher = undici.getGlobalDispatcher();
		this.restore.push(() => undici.setGlobalDispatcher(dispatcher));
		this.restored.push({
			label: "undici global dispatcher",
			holds: () => undici.getGlobalDispatcher() === dispatcher,
		});
		for (const name of HTTP_INSTALL_GLOBAL_NAMES) {
			if (name === "fetch" || name === "WebSocket") continue; // A pinned global has its own restoration and evidence.
			const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
			this.restore.push(() => {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else Reflect.deleteProperty(globalThis, name);
			});
			this.restored.push({
				label: `globalThis.${name}`,
				holds: () => sameOwnProperty(Object.getOwnPropertyDescriptor(globalThis, name), descriptor),
			});
		}
	}
}
