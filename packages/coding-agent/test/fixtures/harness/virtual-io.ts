import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { basename, dirname, resolve, sep } from "node:path";
import nativeProcess from "node:process";
import type { DatabaseSync as NativeDatabaseSync } from "node:sqlite";
import { PassThrough, Writable } from "node:stream";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { getSystemErrorMap } from "node:util";
import { builtinBoundary } from "./builtin-boundary.ts";
import { type SqliteFaultOperation, VirtualSqlite } from "./sqlite-io.ts";
import { VirtualWorkerThreads } from "./virtual-worker.ts";

interface VirtualNode {
	kind: "file" | "directory" | "symlink";
	data: Buffer;
	target?: string;
	modified: number;
	identity: number;
}

export interface IoOperation {
	readonly kind: string;
	readonly path: string;
	readonly destination?: string;
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
	| "rm"
	| "rename"
	| "watch.close"
	| "read"
	| "open"
	| "stat"
	| "readdir"
	| "mkdir";

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
	readonly kind: IoFaultKind;
	readonly phase?: "before" | "after";
	readonly matches: (operation: IoOperation, data?: Buffer) => boolean;
	readonly onMatch: (operation: IoOperation, data?: Buffer) => void;
}

/** The asynchronous operations a scenario can hold at their call: the operation runs, against the state then current, on release. */
export type IoHoldKind = "readFile" | "mkdir" | "writeFile" | "rename";

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
	rm: "rm",
	rename: "rename",
	"watch.close": undefined,
	read: "read",
	open: "open",
	stat: "stat",
	readdir: "scandir",
	mkdir: "mkdir",
};

const MAX_PENDING_HOLDS = 8;
const MAX_OBSERVERS = 8;

interface OpenFile {
	path: string;
	readonly node: VirtualNode;
	position: number;
	append: boolean;
	writable: boolean;
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

	/** A held call waits at its gate and then runs; any other call runs at once, exactly as without holds. */
	private whenReleased<T>(kind: IoHoldKind, operation: IoOperation | undefined, run: () => Promise<T>): Promise<T> {
		const record =
			operation === undefined
				? undefined
				: this.holds.find(
						(candidate) => candidate.state === "armed" && candidate.kind === kind && candidate.matches(operation),
					);
		if (record === undefined || operation === undefined) return run();
		record.state = "reached";
		record.reach(operation);
		return record.gate.then(run);
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
			setImmediate(() => waiter.resolve(operation));
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

	/** The bytes of a file now, for scenario inspection: no ledger entry, no fault, no hold. */
	peekFile(path: string): string | undefined {
		const node = this.nodes.get(this.path(path));
		return node?.kind === "file" ? node.data.toString() : undefined;
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

	fileEntries(): ReadonlyMap<string, string> {
		return new Map(
			[...this.nodes].filter(([, node]) => node.kind === "file").map(([path, node]) => [path, node.data.toString()]),
		);
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
		this.log({ kind: "read", path });
		const encoding = typeof options === "string" ? options : (options as { encoding?: string } | undefined)?.encoding;
		return encoding ? node.data.toString(encoding as BufferEncoding) : Buffer.from(node.data);
	}

	async readFile(value: unknown, options?: unknown): Promise<Buffer | string> {
		return this.readFileSync(value, options);
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
		this.setFileData(path, bytes(data));
		this.note("write", path);
		this.fault({ kind: "write", path }, "after", bytes(data));
	}

	async writeFile(value: unknown, data: unknown, options?: unknown): Promise<void> {
		this.writeFileSync(value, data, options);
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
		} else {
			this.nodes.set(path, {
				kind: "file",
				data,
				modified: this.stamp(),
				identity: this.nextIdentity++,
			});
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
		this.nodes.set(path, {
			kind: "directory",
			data: Buffer.alloc(0),
			modified: this.stamp(),
			identity: this.nextIdentity++,
		});
		this.note("mkdir", path);
		return recursive ? path : undefined;
	}

	async mkdir(value: unknown, options?: unknown): Promise<string | undefined> {
		return this.mkdirSync(value, options);
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
		const snapshot = {
			size: node.data.length,
			mtimeMs: node.modified,
			ctimeMs: node.modified,
			birthtimeMs: 1000,
			atimeMs: node.modified,
			mtime: new Date(node.modified),
			ctime: new Date(node.modified),
			birthtime: new Date(1000),
			atime: new Date(node.modified),
			mode: node.kind === "directory" ? 0o40755 : 0o100644,
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
				ctimeNs: modifiedNs,
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
		return children
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
		const directory = {
			path,
			readSync: readNext,
			read: async () => readNext(),
			closeSync: () => {
				closed = true;
				this.directories.delete(directory);
			},
			close: async () => {
				closed = true;
				this.directories.delete(directory);
			},
			[Symbol.asyncIterator]: async function* () {
				try {
					for (let entry = readNext(); entry !== null; entry = readNext()) yield entry;
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
		this.nodes.delete(path);
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
		for (const [path, node] of entries) {
			this.nodes.delete(path);
			node.modified = this.stamp();
			this.nodes.set(`${to}${path.slice(from.length)}`, node);
		}
		for (const descriptor of this.descriptors.values()) if (descriptor.path === from) descriptor.path = to;
		this.log({ kind: "rename", path: from, destination: to });
		this.note("change", to);
		this.fault({ kind: "rename", path: from, destination: to }, "after");
	}

	copyFileSync(source: unknown, destination: unknown, flags = 0): void {
		const from = this.realpathSync(source, "copyfile", "copy");
		const to = this.path(destination, "copyfile");
		if ((flags & fs.constants.COPYFILE_EXCL) !== 0 && this.nodes.has(to))
			throw this.failure("copy", "EEXIST", to, "copyfile");
		this.writeFileSync(to, this.readFileSync(from));
		this.log({ kind: "copy", path: from, destination: to });
	}

	openSync(value: unknown, flags: unknown): number {
		const path = this.path(value);
		if (typeof flags !== "string") throw new Error("Virtual open requires explicit string flags");
		this.fault({ kind: "open", path, flags }, "before");
		if (flags.includes("x") && this.nodes.has(path)) throw this.failure("open", "EEXIST", path, "open");
		if (flags.startsWith("w")) this.writeFileSync(path, "");
		else if (flags.startsWith("a") && !this.nodes.has(path)) this.writeFileSync(path, "");
		else if (!this.nodes.has(path)) throw this.failure("open", "ENOENT", path, "open");
		const fd = this.nextDescriptor++;
		this.descriptors.set(fd, {
			path,
			node: this.nodes.get(path)!,
			position: 0,
			append: flags.startsWith("a"),
			writable: flags.includes("+") || flags.startsWith("w") || flags.startsWith("a"),
		});
		return fd;
	}

	async open(value: unknown, flags: unknown) {
		const descriptor = this.openSync(value, flags);
		let closed = false;
		return {
			get fd() {
				return closed ? -1 : descriptor;
			},
			read: async (
				buffer: Uint8Array,
				offset = 0,
				length = buffer.byteLength - offset,
				position: number | null = null,
			) => ({
				bytesRead: this.readDescriptor(descriptor, buffer, offset, length, position),
				buffer,
			}),
			write: async (buffer: Uint8Array | string, offset = 0, length?: number, position: number | null = null) => {
				const data = bytes(buffer);
				const selected =
					typeof buffer === "string" ? data : data.subarray(offset, offset + (length ?? data.length - offset));
				return { bytesWritten: this.writeDescriptor(descriptor, selected, position), buffer };
			},
			readFile: async (options?: unknown) => this.readDescriptorFile(descriptor, options),
			writeFile: async (data: unknown) => {
				this.writeDescriptor(descriptor, bytes(data));
			},
			appendFile: async (data: unknown) => {
				this.writeDescriptor(descriptor, bytes(data), Number(this.statSync(descriptor).size));
			},
			stat: async (options?: unknown) => this.statSync(descriptor, options),
			truncate: async (length = 0) => this.truncateDescriptor(descriptor, length),
			sync: async () => {
				this.path(descriptor);
			},
			datasync: async () => {
				this.path(descriptor);
			},
			close: async () => {
				if (!closed) {
					closed = true;
					this.closeSync(descriptor);
				}
			},
		};
	}

	closeSync(fd: unknown): void {
		if (typeof fd !== "number" || !this.descriptors.delete(fd))
			throw this.failure("close", "EBADF", String(fd), "close");
	}

	/**
	 * Event-driven wait for durable state: `holds` is evaluated now and then on a later turn after every modeled mutation
	 * (write, rename, removal), never on a timer. The caller bounds the wait with its own deadline.
	 */
	waitForMutation(holds: () => boolean): Promise<void> {
		if (holds()) return Promise.resolve();
		return new Promise((resolve, reject) => {
			this.mutationWaiters.add({ holds, resolve, reject });
		});
	}

	assertNoOpenResources(): void {
		if (this.descriptors.size || this.watchers.size || this.streams.size || this.directories.size) {
			throw new Error(
				`Virtual IO leaked: files=${this.descriptors.size}; watchers=${this.watchers.size}; streams=${this.streams.size}; directories=${this.directories.size}`,
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
			mkdtemp: async (prefix: unknown) => this.mkdtempSync(prefix),
			opendir: async (path: unknown) => this.opendirSync(path),
			open: (path: unknown, flags: unknown) => this.open(path, flags),
			readFile: (path: unknown, options?: unknown) => {
				const target = this.holdPath(path);
				return this.whenReleased(
					"readFile",
					target === undefined ? undefined : { kind: "read", path: target },
					() => this.readFile(path, options),
				);
			},
			writeFile: (path: unknown, data: unknown, options?: unknown) => {
				const target = this.holdPath(path);
				return this.whenReleased(
					"writeFile",
					target === undefined ? undefined : { kind: "write", path: target },
					() => this.writeFile(path, data, options),
				);
			},
			appendFile: async (path: unknown, data: unknown) => this.appendFileSync(path, data),
			mkdir: (path: unknown, options?: unknown) => {
				const target = this.holdPath(path);
				return this.whenReleased("mkdir", target === undefined ? undefined : { kind: "mkdir", path: target }, () =>
					this.mkdir(path, options),
				);
			},
			readdir: async (path: unknown, options?: unknown) => this.readdirSync(path, options),
			stat: async (path: unknown, options?: unknown) => this.statSync(path, options),
			lstat: async (path: unknown, options?: unknown) =>
				this.statSync(path, { ...(options as { bigint?: boolean } | undefined), lstat: true }),
			access: async (path: unknown) => {
				this.note("access", this.realpathSync(path, "access", "access"));
			},
			realpath: async (path: unknown) => this.realpathSync(path),
			unlink: async (path: unknown) => this.unlinkSync(path),
			rm: async (path: unknown, options?: unknown) => this.rmSync(path, options),
			rmdir: async (path: unknown) => this.rmSync(path, undefined, "rmdir"),
			rename: (from: unknown, to: unknown) => {
				const source = this.holdPath(from);
				const target = this.holdPath(to);
				return this.whenReleased(
					"rename",
					source === undefined || target === undefined
						? undefined
						: { kind: "rename", path: source, destination: target },
					async () => this.renameSync(from, to),
				);
			},
			copyFile: async (from: unknown, to: unknown, flags?: number) => this.copyFileSync(from, to, flags),
			chmod: async (path: unknown) => {
				this.realpathSync(path, "chmod", "chmod");
			},
			utimes: async (path: unknown, _atime: unknown, mtime: unknown) => this.setTimes(path, mtime),
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
			statSync: (path: unknown, options?: unknown) => this.statSync(path, options),
			fstatSync: (fd: unknown, options?: unknown) => this.statSync(fd, options),
			lstatSync: (path: unknown, options?: unknown) =>
				this.statSync(path, { ...(options as { bigint?: boolean } | undefined), lstat: true }),
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
			chmodSync: (path: unknown) => {
				this.realpathSync(path, "chmod", "chmod");
			},
			utimesSync: (path: unknown, _atime: unknown, mtime: unknown) => this.setTimes(path, mtime),
			openSync: (path: unknown, flags: unknown) => this.openSync(path, flags),
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
				Promise.resolve()
					.then(() => operation(...arguments_))
					.then(
						(result) => {
							callback(null, result);
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
		this.note("read", descriptor.path);
		return encoding ? result.toString(encoding as BufferEncoding) : Buffer.from(result);
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
		this.note("read", descriptor.path);
		return amount;
	}

	private writeDescriptor(fd: number, data: Buffer, position?: number | null): number {
		const descriptor = this.descriptors.get(fd);
		if (!descriptor) throw this.failure("write", "EBADF", String(fd), "write");
		if (!descriptor.writable) throw this.failure("write", "EBADF", descriptor.path, "write");
		const node = descriptor.node;
		if (node?.kind !== "file") throw this.failure("write", "EISDIR", descriptor.path, "write");
		this.fault({ kind: "write", path: descriptor.path }, "before", data);
		const start = descriptor.append ? node.data.length : (position ?? descriptor.position);
		const replacement = Buffer.alloc(Math.max(node.data.length, start + data.length));
		node.data.copy(replacement);
		data.copy(replacement, start);
		node.data = replacement;
		node.modified = this.stamp();
		if (position === null || position === undefined) descriptor.position = start + data.length;
		this.note("write", descriptor.path);
		this.fault({ kind: "write", path: descriptor.path }, "after", data);
		return data.length;
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
		this.note("truncate", descriptor.path);
	}

	private setTimes(value: unknown, mtime: unknown): void {
		const path = this.realpathSync(value, "utime", "utimes");
		const milliseconds = mtime instanceof Date ? mtime.getTime() : Number(mtime) * 1000;
		if (!Number.isFinite(milliseconds)) throw new TypeError("Virtual utimes requires finite time");
		this.nodes.get(path)!.modified = milliseconds;
		this.note("utimes", path);
	}

	private note(kind: string, path: string): void {
		this.log({ kind, path });
		if (!WATCH_CHANGE_OPERATIONS.has(kind)) return;
		if (this.mutationWaiters.size > 0) {
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
	/** Keep the native SQL engine but route every database's storage to RAM. */
	sqlite?: "memory";
}

/** Installs at the external builtin boundary, before constructing any production session. */
export class EffectGuard {
	readonly escapes: string[] = [];
	readonly effects: Array<{ kind: string; arguments: readonly unknown[] }> = [];
	private readonly io: VirtualFileSystem;
	private readonly ports: EffectPorts;
	private readonly restore: Array<() => void> = [];
	private readonly sqlite: VirtualSqlite;
	private readonly workerThreads: VirtualWorkerThreads;
	private installed = false;

	constructor(io: VirtualFileSystem, ports: EffectPorts = {}) {
		this.io = io;
		this.ports = ports;
		this.sqlite = new VirtualSqlite(io, (kind) => this.reject(kind));
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
			this.replace(globalThis, "fetch", this.ports.fetch ?? reject("fetch"));
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
			for (const name of ["connect", "createConnection", "createServer"])
				this.replace(net, name, reject(`net.${name}`));
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

	assertNoOpenSqliteHandles(): void {
		const handles = this.sqlite.openHandles();
		if (handles.length) throw new Error(`Application SQLite handles leaked: ${handles.join(", ")}`);
	}

	failNextSqliteOperation(operation: SqliteFaultOperation, sql: string): void {
		this.sqlite.failNext(operation, sql);
	}

	assertSqliteFaultsConsumed(): void {
		this.sqlite.assertFaultsConsumed();
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
		for (const restore of this.restore.reverse()) {
			try {
				restore();
			} catch (error) {
				failures.push(error);
			}
		}
		this.restore.length = 0;
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
}
