import { EventEmitter } from "node:events";
import { dirname, isAbsolute, join } from "node:path";
import { PassThrough, type Readable, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { getAgentDir, getBundledResourcesDir } from "../../../src/config.ts";
import { cacheFile, runtimesDir } from "../../../src/core/agent-paths.ts";
import { isRecordObject } from "../../../src/core/util/value-guards.ts";
import { getManagedToolBinaryPath } from "../../../src/utils/tools-manager.ts";
import type { VirtualFileSystem } from "./virtual-io.ts";
import type { VirtualChildSignal, VirtualProcessTable } from "./virtual-process-table.ts";
import type { VirtualShell } from "./virtual-shell.ts";

/**
 * External OS and interpreter boundary of the default Windows shell path: an already-installed managed uv, the Python
 * interpreter it reports, and the persistent engine coordinator that interpreter would run. The production runtime
 * manager, engine session, coordinator, frame parser and shell state all stay native. This module only answers the
 * process operations those owners issue, with real-shaped children whose command outcomes come from the one shared
 * VirtualShell script queue. Nothing here runs a real command, installs software or reaches the network.
 */

/**
 * Bound of one newline-delimited request line. This is this external adapter's own bound (not traced to any limit of the
 * native Python coordinator); a larger line is a protocol fault rejected before it is copied or parsed.
 */
const MAX_REQUEST_BYTES = 1024 * 1024;
const REQUEST_ID_PATTERN = /^[0-9a-f]{16}$/;
const UV_FIND_ARGUMENTS = ["python", "find", ">=3.10", "--no-project"] as const;
const TASKKILL_NOT_FOUND = 128;
const UV_STDIO = ["ignore", "pipe", "pipe"] as const;
const ENGINE_STDIO = ["pipe", "pipe", "pipe"] as const;
const ENGINE_REQUEST_KEYS: ReadonlySet<string> = new Set([
	"requestId",
	"command",
	"cwd",
	"env",
	"powershellPath",
	"gnuToolsDir",
	"timeoutMs",
]);

export type WindowsShellProcessResult = { readonly handled: true; readonly value: unknown } | undefined;

export interface ProvisionedWindowsRuntime {
	readonly uvPath: string;
	readonly pythonPath: string;
	/** The bundled engine script the native session passes to the interpreter. */
	readonly engineScriptPath: string;
}

/** Metadata only: environment values and credentials are never retained. */
export interface WindowsShellRequestRecord {
	readonly pid: number;
	readonly requestId: string;
	readonly command: string;
	readonly cwd: string;
	readonly environmentNames: readonly string[];
	readonly timeoutMs?: number;
	readonly powershell: boolean;
	readonly gnuToolsDir?: string;
	outcome: "pending" | "completed" | "cancelled" | "external-failure" | "failed";
	exitCode?: number;
	reportedCwd?: string;
	/** Bytes the backend produced after a delivered signal cut the pipes; they reach no consumer. */
	discardedBytes: number;
}

export interface WindowsShellSpawnRecord {
	readonly kind: "uv-python-find" | "engine-daemon";
	readonly pid: number;
	readonly cwd: string;
}

interface EngineRequest {
	readonly requestId: string;
	readonly command: string;
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly powershell: boolean;
	readonly gnuToolsDir?: string;
	readonly timeoutMs?: number;
}

function streamClosed(stream: Readable | Writable): Promise<void> {
	if (stream.closed) return Promise.resolve();
	return new Promise<void>((resolve) => stream.once("close", () => resolve()));
}

/**
 * A real-shaped child process. Streams, exit and close follow the production contract: exit once the actor has physically
 * finished, close only after every stdio stream has closed and the table released the child, and a delivered signal is a
 * request, never a death. `terminal` is physical-only: it settles after close whatever failed, and every failure is
 * retained raw through `onFailure` (and fails the adapter's drain), never swallowed.
 */
class ScriptedChild extends EventEmitter {
	readonly stdin: Writable | null;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid: number;
	readonly spawnfile: string;
	readonly spawnargs: string[];
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	/** Settles after `close` has been emitted and the table released the child. */
	readonly terminal: Promise<void>;
	/** True once a signal reached this child. */
	signaled = false;
	/** No new input is accepted: a signal, EOF or a fault ended admission. */
	protected admissionClosed = false;
	/** Output is cut: a signal or fault killed the pipes, so later backend bytes reach no consumer. */
	protected outputCut = false;
	protected readonly producers = new Set<Promise<void>>();
	private readonly retain: (cause: unknown) => void;
	private readonly table: VirtualProcessTable;
	private readonly resolveTerminal: () => void;
	private exitStarted: Promise<void> | undefined;

	constructor(options: {
		readonly table: VirtualProcessTable;
		readonly spawnfile: string;
		readonly spawnargs: readonly string[];
		readonly detached: boolean;
		readonly withStdin: boolean;
		readonly onFailure: (cause: unknown) => void;
	}) {
		super();
		this.table = options.table;
		this.spawnfile = options.spawnfile;
		this.spawnargs = [...options.spawnargs];
		this.retain = options.onFailure;
		const terminal = Promise.withResolvers<void>();
		this.terminal = terminal.promise;
		this.resolveTerminal = terminal.resolve;
		this.pid = options.table.registerChild({
			detached: options.detached,
			deliver: (signal) => this.onSignal(signal),
		});
		this.stdin = options.withStdin
			? new Writable({
					write: (chunk: Buffer, _encoding, callback) => {
						if (this.admissionClosed) {
							callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
							return;
						}
						// Acknowledging the write is input acceptance, never command completion. A failure retains its
						// cause and shuts the child down, so the callback can never strand a live actor.
						try {
							this.acceptInput(chunk);
						} catch (cause) {
							this.fail(cause);
						}
						callback();
					},
					final: (callback) => {
						try {
							this.endInput();
						} catch (cause) {
							this.fail(cause);
						}
						callback();
					},
				})
			: null;
		for (const stream of [this.stdout, this.stderr, ...(this.stdin ? [this.stdin] : [])]) {
			// A stream fault is retained raw and ends the child; an unhandled stream error would crash the host instead.
			stream.on("error", (cause) => this.fail(cause));
		}
	}

	/** Emits `spawn` once the caller has attached its listeners. A throwing observer ends the child, never orphans it. */
	start(): void {
		void this.track(
			new Promise<void>((resolve, reject) => {
				setImmediate(() => {
					try {
						if (!this.admissionClosed && !this.emitIsolated("spawn")) void this.beginExit(1, null, true);
						resolve();
					} catch (cause) {
						reject(cause);
					}
				});
			}),
		);
	}

	kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
		if (this.exitCode !== null || this.signalCode !== null) return false;
		this.killed = true;
		return this.table.signal(this.pid, signal);
	}

	ref(): this {
		return this;
	}

	unref(): this {
		return this;
	}

	protected acceptInput(_chunk: Buffer): void {
		// Children without a protocol ignore input they never read.
	}

	protected endInput(): void {
		// Overridden by children whose stdin EOF ends them.
	}

	/** Subclass hook: cancel every admitted backend through its own owned controller. */
	protected cancelAdmitted(): void {}

	/** Retain a raw cause, then close admission and cancel and join admitted work. */
	protected fail(cause: unknown): void {
		this.retain(cause);
		void this.beginExit(1, null, true);
	}

	/**
	 * Delivers an event to every listener even if one throws (EventEmitter.emit stops at the first throw). Each throw is
	 * retained raw. Returns false when any observer threw.
	 */
	private emitIsolated(event: string, ...args: unknown[]): boolean {
		let delivered = true;
		for (const listener of this.rawListeners(event)) {
			try {
				listener.apply(this, args);
			} catch (cause) {
				delivered = false;
				this.retain(cause);
			}
		}
		return delivered;
	}

	private onSignal(signal: VirtualChildSignal): void {
		this.signaled = true;
		void this.beginExit(null, signal, true);
	}

	/**
	 * Cut admission, then (for a signal or fault) cancel admitted backends, join every producer, and only then close the
	 * stdio streams, release the child and emit the terminal events. A backend that ignores its abort keeps the child
	 * physically alive.
	 */
	protected beginExit(code: number | null, signal: NodeJS.Signals | null, abort: boolean): Promise<void> {
		this.admissionClosed = true;
		// A signal can escalate an EOF drain already waiting for admitted work.
		if (abort) {
			this.outputCut = true;
			this.attempt(() => this.cancelAdmitted());
		}
		if (this.exitStarted) return this.exitStarted;
		this.exitStarted = this.finish(code, signal);
		return this.exitStarted;
	}

	private attempt(step: () => void): void {
		try {
			step();
		} catch (cause) {
			this.retain(cause);
		}
	}

	private endStream(stream: Readable | Writable, end: () => void): void {
		try {
			end();
		} catch (cause) {
			this.retain(cause);
			this.attempt(() => stream.destroy());
		}
	}

	private async finish(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
		// Producers never reject (track observes them); a producer that fails has already retained its cause.
		while (this.producers.size > 0) await Promise.all([...this.producers]);
		this.exitCode = code;
		this.signalCode = signal;
		const closed = [streamClosed(this.stdout), streamClosed(this.stderr)];
		if (this.stdin) closed.push(streamClosed(this.stdin));
		this.emitIsolated("exit", code, signal);
		this.endStream(this.stdout, () => this.stdout.end());
		this.endStream(this.stderr, () => this.stderr.end());
		if (this.stdin) {
			const stdin = this.stdin;
			this.attempt(() => stdin.destroy());
		}
		// Output nobody consumed must not hold the close open.
		this.attempt(() => this.stdout.resume());
		this.attempt(() => this.stderr.resume());
		await Promise.all(closed);
		this.attempt(() => this.table.releaseChild(this.pid));
		this.emitIsolated("close", code, signal);
		this.resolveTerminal();
	}

	/** Registers a physical producer that must settle before the child may close; its failure is retained and fatal. */
	protected track(work: Promise<void>): Promise<void> {
		const producer: Promise<void> = work
			.then(undefined, (cause: unknown) => this.fail(cause))
			.finally(() => this.producers.delete(producer));
		this.producers.add(producer);
		return producer;
	}
}

/** `uv python find`: one-shot, prints the interpreter path and LF, exits 0. */
class UvFindChild extends ScriptedChild {
	respond(pythonPath: string): void {
		void this.track(
			new Promise<void>((resolve, reject) => {
				setImmediate(() => {
					try {
						if (!this.admissionClosed) {
							this.stdout.write(`${pythonPath}\n`);
							void this.beginExit(0, null, false);
						}
						resolve();
					} catch (cause) {
						reject(cause);
					}
				});
			}),
		);
	}
}

/**
 * The persistent engine coordinator. Reads bounded JSON request lines from its stdin, runs each command through the
 * shared script queue, and answers with the declared bytes, the request's output barrier on stdout and its correlated
 * control frame on stderr. The child survives commands: a command exit is a frame, a daemon exit is a process event.
 */
class EngineDaemonChild extends ScriptedChild {
	private readonly shell: Pick<VirtualShell, "execProtocol">;
	private readonly ledger: WindowsShellRequestRecord[];
	private pendingInput: Buffer = Buffer.alloc(0);
	private current: { readonly controller: AbortController; readonly record: WindowsShellRequestRecord } | undefined;
	private pendingExit: number | undefined;
	private cancelling = false;

	constructor(options: {
		readonly table: VirtualProcessTable;
		readonly spawnfile: string;
		readonly spawnargs: readonly string[];
		readonly detached: boolean;
		readonly shell: Pick<VirtualShell, "execProtocol">;
		readonly ledger: WindowsShellRequestRecord[];
		readonly onFailure: (cause: unknown) => void;
	}) {
		super({
			table: options.table,
			spawnfile: options.spawnfile,
			spawnargs: options.spawnargs,
			detached: options.detached,
			withStdin: true,
			onFailure: options.onFailure,
		});
		this.shell = options.shell;
		this.ledger = options.ledger;
	}

	/**
	 * Splits the byte stream into lines under the adapter bound. The bound is checked on the byte counts BEFORE any
	 * concatenation or parse, for LF-terminated lines and partial tails alike, so an oversized chunk is never copied.
	 */
	protected override acceptInput(chunk: Buffer): void {
		let offset = 0;
		while (offset < chunk.length) {
			const lineFeed = chunk.indexOf(0x0a, offset);
			const end = lineFeed < 0 ? chunk.length : lineFeed;
			if (this.pendingInput.length + (end - offset) > MAX_REQUEST_BYTES) {
				this.fault("engine request line exceeds the adapter bound");
				return;
			}
			const piece = chunk.subarray(offset, end);
			if (lineFeed < 0) {
				this.pendingInput = Buffer.concat([this.pendingInput, piece]);
				return;
			}
			const line = this.pendingInput.length === 0 ? piece : Buffer.concat([this.pendingInput, piece]);
			this.pendingInput = Buffer.alloc(0);
			this.accept(line.toString("utf8"));
			if (this.admissionClosed) return;
			offset = lineFeed + 1;
		}
	}

	protected override endInput(): void {
		// EOF ends a server that has finished what it admitted; it cancels nothing.
		void this.beginExit(0, null, false);
	}

	protected override cancelAdmitted(): void {
		this.cancelling = true;
		this.current?.controller.abort();
	}

	/** A protocol violation is the fixture's or the native owner's bug: retain it raw and end the daemon. */
	private fault(message: string): void {
		this.fail(new Error(`Windows shell engine protocol: ${message}`));
	}

	private parse(line: string): EngineRequest | undefined {
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			this.fault("request is not JSON");
			return undefined;
		}
		if (!isRecordObject(raw)) {
			this.fault("request is not an object");
			return undefined;
		}
		const unknownKey = Object.keys(raw).find((key) => !ENGINE_REQUEST_KEYS.has(key));
		if (unknownKey !== undefined) {
			this.fault(`request carries an unsupported field '${unknownKey}'`);
			return undefined;
		}
		const { requestId, command, cwd, env, powershellPath, gnuToolsDir, timeoutMs } = raw;
		if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
			this.fault("request id is not a native 16-hex id");
			return undefined;
		}
		if (typeof command !== "string" || typeof cwd !== "string" || !isAbsolute(cwd)) {
			this.fault("request command or absolute cwd is invalid");
			return undefined;
		}
		if (!isRecordObject(env)) {
			this.fault("request environment is not a map");
			return undefined;
		}
		const environment: NodeJS.ProcessEnv = {};
		for (const [key, value] of Object.entries(env)) {
			if (typeof value !== "string") {
				this.fault("request environment is not a string map");
				return undefined;
			}
			environment[key] = value;
		}
		if (powershellPath !== undefined && typeof powershellPath !== "string") {
			this.fault("request powershellPath is not a string");
			return undefined;
		}
		if (gnuToolsDir !== undefined && typeof gnuToolsDir !== "string") {
			this.fault("request gnuToolsDir is not a string");
			return undefined;
		}
		if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
			this.fault("request timeout is not a positive number");
			return undefined;
		}
		return {
			requestId,
			command,
			cwd,
			env: environment,
			powershell: powershellPath !== undefined,
			...(gnuToolsDir !== undefined ? { gnuToolsDir } : {}),
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
		};
	}

	/** Parse, overlap and bound rejections all happen here, before any backend is admitted. */
	private accept(line: string): void {
		const request = this.parse(line);
		if (request === undefined) return;
		if (this.current !== undefined) {
			this.fault("a request arrived while another is still admitted");
			return;
		}
		const record: WindowsShellRequestRecord = {
			pid: this.pid,
			requestId: request.requestId,
			command: request.command,
			cwd: request.cwd,
			environmentNames: Object.keys(request.env).sort(),
			...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
			powershell: request.powershell,
			...(request.gnuToolsDir !== undefined ? { gnuToolsDir: request.gnuToolsDir } : {}),
			outcome: "pending",
			discardedBytes: 0,
		};
		this.ledger.push(record);
		const controller = new AbortController();
		this.current = { controller, record };
		// The exit request runs after the producer left the join set, so shutdown never joins its own caller.
		this.track(this.execute(request, record, controller))
			.then(() => {
				if (this.pendingExit === undefined) return;
				const code = this.pendingExit;
				this.pendingExit = undefined;
				void this.beginExit(code, null, false);
			})
			.catch((cause: unknown) => this.fail(cause));
	}

	private emitOutput(data: Buffer, record: WindowsShellRequestRecord): void {
		if (this.outputCut) {
			record.discardedBytes += data.length;
			return;
		}
		this.stdout.write(Buffer.from(data));
	}

	/** Runs one command; each execution is classified exactly by the shell owner, everything else stays raw and fatal. */
	private async execute(
		request: EngineRequest,
		record: WindowsShellRequestRecord,
		controller: AbortController,
	): Promise<void> {
		let outcome: Awaited<ReturnType<VirtualShell["execProtocol"]>>;
		try {
			outcome = await this.shell.execProtocol(request.command, request.cwd, {
				onData: (data) => this.emitOutput(data, record),
				signal: controller.signal,
				env: request.env,
			});
		} catch (cause) {
			this.current = undefined;
			record.outcome = "failed";
			this.fail(cause);
			return;
		}
		this.current = undefined;
		if (outcome.kind === "cancelled") {
			record.outcome = "cancelled";
			// A cancellation this child did not request (shell teardown) leaves no process to answer further commands.
			if (!this.cancelling) this.pendingExit = 1;
			return;
		}
		if (outcome.kind === "external-failure") {
			record.outcome = "external-failure";
			if (!this.outputCut) this.stderr.write(Buffer.from(`${outcome.cause.message}\n`, "utf8"));
			this.pendingExit = 1;
			return;
		}
		if (this.outputCut) {
			record.outcome = "cancelled";
			return;
		}
		const { exitCode, cwd: reportedCwd } = outcome.result;
		if (exitCode === null || !Number.isInteger(exitCode)) {
			record.outcome = "failed";
			this.fail(new Error(`Windows shell engine backend reported no integer exit code for ${request.requestId}`));
			return;
		}
		const cwd = reportedCwd || request.cwd;
		record.outcome = "completed";
		record.exitCode = exitCode;
		record.reportedCwd = cwd;
		const frame = { requestId: request.requestId, exitCode, cwd, envDelta: {}, unsupported: null };
		this.stdout.write(Buffer.from(`\x1e${request.requestId}\x1e`, "latin1"));
		this.stderr.write(Buffer.from(`\x1e${JSON.stringify(frame)}\x1e`, "utf8"));
	}
}

/** Keys of the known child environment, compared by name so no value is ever logged. */
function environmentValue(options: unknown, key: string): string | undefined {
	if (!isRecordObject(options) || !isRecordObject(options.env)) return undefined;
	const value = options.env[key];
	return typeof value === "string" ? value : undefined;
}

export class ScriptedWindowsShellProcesses {
	/** Refusals of operations on provisioned executables that did not match their exact protocol. */
	readonly unscripted: string[] = [];
	readonly spawns: WindowsShellSpawnRecord[] = [];
	/** Declared real-shaped answers for the lookups the native owners issue (Git discovery, taskkill). */
	readonly lookups: Array<{ readonly command: string; readonly arguments: readonly string[] }> = [];
	private readonly io: Pick<VirtualFileSystem, "seed">;
	private readonly shell: Pick<VirtualShell, "execProtocol">;
	private readonly processTable: VirtualProcessTable;
	private readonly ledger: WindowsShellRequestRecord[] = [];
	private readonly children = new Set<ScriptedChild>();
	private readonly failures: Array<{ readonly cause: unknown }> = [];
	private runtime: ProvisionedWindowsRuntime | undefined;
	private projectCwd = "";
	private disposed = false;

	constructor(
		io: Pick<VirtualFileSystem, "seed">,
		shell: Pick<VirtualShell, "execProtocol">,
		processTable: VirtualProcessTable,
	) {
		this.io = io;
		this.shell = shell;
		this.processTable = processTable;
	}

	/** The native project cwd the scripts re-enter explicitly after a persistent `cd`. */
	get nativeProjectCwd(): string {
		return this.projectCwd;
	}

	/** Snapshot of the metadata-only request ledger. */
	get requests(): readonly WindowsShellRequestRecord[] {
		return this.ledger.map((record) => ({ ...record }));
	}

	/**
	 * Installs ONLY the already-installed managed uv and the interpreter it reports, at the actual canonical paths the
	 * native resolvers compute. The real PythonRuntimeManager still inspects, fingerprints and resolves them; nothing
	 * is downloaded or stubbed.
	 */
	provisionInstalledRuntime(projectCwd: string): ProvisionedWindowsRuntime {
		if (this.runtime !== undefined) throw new Error("The Windows runtime is already provisioned");
		if (!isAbsolute(projectCwd)) throw new Error("The native project cwd must be absolute");
		const uvPath = getManagedToolBinaryPath("uv");
		const pythonPath = join(
			runtimesDir("python", getAgentDir()),
			"cpython-3.13-virtual",
			...(process.platform === "win32" ? ["python.exe"] : ["bin", "python3"]),
		);
		this.io.seed(uvPath, "virtual managed uv\n");
		this.io.seed(pythonPath, "virtual python interpreter\n");
		this.projectCwd = projectCwd;
		this.runtime = {
			uvPath,
			pythonPath,
			engineScriptPath: join(getBundledResourcesDir(), "runtimes", "pi-shell-engine", "main.py"),
		};
		return this.runtime;
	}

	/**
	 * Answers a process operation the harness guard forwarded. `undefined` means the operation is not this adapter's:
	 * the caller keeps its other adapters and must reject whatever nobody handles. A provisioned executable with a
	 * mismatched protocol is refused here, never matched permissively.
	 */
	tryRun(operation: string, args: readonly unknown[]): WindowsShellProcessResult {
		const [file, argv, options] = args;
		if (typeof file !== "string" || !Array.isArray(argv)) return undefined;
		const argumentsList: readonly unknown[] = argv;
		if (operation === "spawn" && this.runtime !== undefined) {
			if (file === this.runtime.uvPath) return { handled: true, value: this.spawnUvFind(argumentsList, options) };
			if (file === this.runtime.pythonPath) {
				return { handled: true, value: this.spawnEngine(file, argumentsList, options) };
			}
		}
		if (operation === "spawnSync") {
			const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
			const sameFile = (candidate: string) =>
				process.platform === "win32" ? candidate.toLowerCase() === file.toLowerCase() : candidate === file;
			if (sameFile(taskkill) && argumentsList.length === 4) return this.taskkill(argumentsList);
			if (file === "where" && isDeepStrictEqual(argumentsList, ["git.exe"])) return this.whereGit();
		}
		return undefined;
	}

	private refuse(message: string): never {
		this.unscripted.push(message);
		throw new Error(`Windows shell adapter refused: ${message}`);
	}

	private recordFailure(cause: unknown): void {
		this.failures.push({ cause });
	}

	private spawnUvFind(argv: readonly unknown[], options: unknown): UvFindChild {
		if (this.disposed) this.refuse("uv spawn after disposal");
		const runtime = this.runtime;
		if (runtime === undefined) throw new Error("unreachable: uv spawn without a runtime");
		const agentDir = getAgentDir();
		const expected: Array<[string, string]> = [
			["UV_CACHE_DIR", cacheFile(agentDir, "uv")],
			["UV_NO_PROGRESS", "1"],
			["UV_PYTHON_INSTALL_DIR", runtimesDir("python", agentDir)],
		];
		const mismatchedEnvironment = expected.filter(([key, value]) => environmentValue(options, key) !== value);
		if (
			!isDeepStrictEqual(argv, [...UV_FIND_ARGUMENTS]) ||
			!isRecordObject(options) ||
			options.cwd !== agentDir ||
			options.shell !== false ||
			options.detached !== (process.platform !== "win32") ||
			!isDeepStrictEqual(options.stdio, [...UV_STDIO]) ||
			mismatchedEnvironment.length > 0
		) {
			this.refuse(
				`uv spawn is not the exact python-find protocol (arguments=${JSON.stringify(argv)}; mismatched environment names=${mismatchedEnvironment.map(([key]) => key).join(",")})`,
			);
		}
		const child = new UvFindChild({
			table: this.processTable,
			spawnfile: runtime.uvPath,
			spawnargs: [runtime.uvPath, ...UV_FIND_ARGUMENTS],
			detached: options.detached === true,
			withStdin: false,
			onFailure: (cause) => this.recordFailure(cause),
		});
		this.adopt(child, { kind: "uv-python-find", pid: child.pid, cwd: agentDir });
		child.respond(runtime.pythonPath);
		return child;
	}

	private spawnEngine(pythonPath: string, argv: readonly unknown[], options: unknown): EngineDaemonChild {
		if (this.disposed) this.refuse("engine spawn after disposal");
		const runtime = this.runtime;
		if (runtime === undefined) throw new Error("unreachable: engine spawn without a runtime");
		const expectedArguments = ["-B", runtime.engineScriptPath, "--server"];
		const pythonFlags: Array<[string, string]> = [
			["PYTHONDONTWRITEBYTECODE", "1"],
			["PYTHONIOENCODING", "utf-8"],
			["PYTHONUNBUFFERED", "1"],
			["PYTHONUTF8", "1"],
		];
		const mismatchedEnvironment = pythonFlags.filter(([key, value]) => environmentValue(options, key) !== value);
		if (
			!isDeepStrictEqual(argv, expectedArguments) ||
			!isRecordObject(options) ||
			options.cwd !== dirname(runtime.engineScriptPath) ||
			options.detached !== (process.platform !== "win32") ||
			!isDeepStrictEqual(options.stdio, [...ENGINE_STDIO]) ||
			options.windowsHide !== true ||
			mismatchedEnvironment.length > 0
		) {
			this.refuse(
				`engine spawn is not the exact coordinator protocol (arguments=${JSON.stringify(argv)}; mismatched environment names=${mismatchedEnvironment.map(([key]) => key).join(",")})`,
			);
		}
		const child = new EngineDaemonChild({
			table: this.processTable,
			spawnfile: pythonPath,
			spawnargs: [pythonPath, ...expectedArguments],
			detached: options.detached === true,
			shell: this.shell,
			ledger: this.ledger,
			onFailure: (cause) => this.recordFailure(cause),
		});
		this.adopt(child, { kind: "engine-daemon", pid: child.pid, cwd: dirname(runtime.engineScriptPath) });
		return child;
	}

	private adopt(child: ScriptedChild, spawn: WindowsShellSpawnRecord): void {
		this.spawns.push(spawn);
		this.children.add(child);
		void child.terminal.then(() => this.children.delete(child));
		child.start();
	}

	/**
	 * `taskkill /F /T /PID <pid>`: a known external command. Delivery to an exact owned child returns status 0 while the
	 * child stays alive until its physical close; a child that already closed answers taskkill's own not-found code.
	 */
	private taskkill(argv: readonly unknown[]): WindowsShellProcessResult {
		const pid = typeof argv[3] === "string" && /^[1-9][0-9]*$/.test(argv[3]) ? Number(argv[3]) : undefined;
		if (!isDeepStrictEqual(argv.slice(0, 3), ["/F", "/T", "/PID"]) || pid === undefined) return undefined;
		this.lookups.push({ command: "taskkill", arguments: argv.map(String) });
		const result = (status: number) => ({
			handled: true as const,
			value: {
				pid: 0,
				output: [null, null, null],
				stdout: null,
				stderr: null,
				status,
				signal: null,
			},
		});
		try {
			this.processTable.signal(pid, "SIGKILL");
			return result(0);
		} catch (error) {
			if (isRecordObject(error) && error.code === "ESRCH") return result(TASKKILL_NOT_FOUND);
			// An unexpected signal/observer cause is an oracle failure, not an expected taskkill result.
			this.recordFailure(error);
			throw error;
		}
	}

	/** Native GNU-tool discovery asks `where git.exe`; the virtual machine has no Git for Windows installed. */
	private whereGit(): WindowsShellProcessResult {
		this.lookups.push({ command: "where", arguments: ["git.exe"] });
		const stderr = "INFO: Could not find files for the given pattern(s).\r\n";
		return {
			handled: true,
			value: { pid: 0, output: [null, "", stderr], stdout: "", stderr, status: 1, signal: null },
		};
	}

	/** Synchronous: every owned child has joined, nothing was refused, and no failure was retained. */
	assertDrained(): void {
		const problems: string[] = [];
		if (this.unscripted.length) problems.push(`refused=${this.unscripted.join("; ")}`);
		if (this.children.size) problems.push(`live children=${[...this.children].map((child) => child.pid).join(",")}`);
		const pending = this.ledger.filter((record) => record.outcome === "pending").map((record) => record.requestId);
		if (pending.length) problems.push(`pending requests=${pending.join(",")}`);
		if (this.failures.length) problems.push(`retained failures=${this.failures.length}`);
		if (problems.length) throw new Error(`Windows shell adapter not settled: ${problems.join("; ")}`);
	}

	/**
	 * Event-driven teardown. A child no owner ever signaled is a leak: it is signaled here so the world can close, and the
	 * leak is retained. Every child is then joined to its terminal close; retained causes are raised raw.
	 */
	async disposeAndWait(): Promise<void> {
		this.disposed = true;
		for (const child of this.children) {
			if (child.signaled) continue;
			this.recordFailure(
				new Error(`Owned child ${child.pid} was never signaled by its native owner before disposal`),
			);
			try {
				this.processTable.signal(child.pid, "SIGKILL");
			} catch (error) {
				this.recordFailure(error);
			}
		}
		await Promise.allSettled([...this.children].map((child) => child.terminal));
		if (this.failures.length) {
			throw new AggregateError(
				this.failures.map((failure) => failure.cause),
				"Windows shell adapter retained failures",
			);
		}
	}
}
