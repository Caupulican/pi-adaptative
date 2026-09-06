import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { assertExecutionAbsolutePath } from "@caupulican/pi-agent-core/paths";
import { getAgentDir } from "../config.ts";
import { ensureTool } from "../utils/tools-manager.ts";
import { cacheFile, runtimesDir } from "./agent-paths.ts";
import { execCommand } from "./exec.ts";

export const PYTHON_RUNTIME_REQUEST = ">=3.10";
export const PYTHON_RUNTIME_INSTALL_REQUEST = "3.13";
export const PYTHON_RUNTIME_FIND_TIMEOUT_MS = 10_000;
export const PYTHON_RUNTIME_INSTALL_TIMEOUT_MS = 300_000;
const PYTHON_RUNTIME_FAILURE_COOLDOWN_MS = 30_000;
const PYTHON_RUNTIME_DIAGNOSTIC_CHARS = 4_000;
const PYTHON_RUNTIME_COMMAND_BUFFER = 64 * 1024;

export interface PythonRuntimeCommandOptions {
	timeoutMs: number;
	env: NodeJS.ProcessEnv;
}

export interface PythonRuntimeCommandResult {
	code: number;
	stdout: string;
	stderr: string;
	killed: boolean;
	/** Missing means unconfirmed output, never a usable interpreter-path observation. */
	stdoutTruncated: boolean;
}

export interface PythonRuntimeDependencies {
	agentDir: string;
	ensureUv: (silent: boolean) => Promise<string | undefined>;
	isOffline: () => boolean;
	makeDirectory: (path: string) => void;
	/** Validate a literal absolute executable file and return its current opaque identity; undefined means unavailable. */
	inspectInterpreter: (path: string) => string | undefined;
	run: (
		command: string,
		args: string[],
		cwd: string,
		options: PythonRuntimeCommandOptions,
	) => Promise<PythonRuntimeCommandResult>;
	now: () => number;
}

export type PythonRuntimeOutcome = Readonly<
	| {
			status: "ready";
			uvPath: string;
			pythonPath: string;
			pythonInstalled: boolean;
	  }
	| {
			status: "offline" | "uv-unavailable" | "python-unavailable";
			reason: string;
	  }
>;

export interface PythonRuntimeManager {
	ensure(options?: { silent?: boolean; force?: boolean }): Promise<PythonRuntimeOutcome>;
	getLastOutcome(): PythonRuntimeOutcome | undefined;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true";
}

function boundedDiagnostic(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= PYTHON_RUNTIME_DIAGNOSTIC_CHARS) return trimmed;
	return `…${trimmed.slice(-PYTHON_RUNTIME_DIAGNOSTIC_CHARS)}`;
}

/** uv writes one complete path followed by LF, including on Windows. Whitespace belongs to the path. */
function interpreterPathOutput(value: string): string | undefined {
	if (!value.endsWith("\n") || value.length > PYTHON_RUNTIME_COMMAND_BUFFER || value.includes("\0")) return undefined;
	const path = value.slice(0, -1);
	return path.length > 0 ? path : undefined;
}

/** Executable admission and fingerprinting for the native runtime adapter. */
export function inspectPythonInterpreter(path: string): string | undefined {
	try {
		assertExecutionAbsolutePath(path, process.platform === "win32" ? "win32" : "posix");
		const entry = statSync(path, { bigint: true });
		if (!entry.isFile()) return undefined;
		accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return [entry.dev, entry.ino, entry.mode, entry.size, entry.mtimeNs, entry.ctimeNs].join(":");
	} catch {
		return undefined;
	}
}

export function createPythonRuntimeManager(deps: PythonRuntimeDependencies): PythonRuntimeManager {
	let inFlight: Promise<PythonRuntimeOutcome> | undefined;
	let lastOutcome: PythonRuntimeOutcome | undefined;
	let lastOutcomeAt = 0;
	let lastInterpreterIdentity: string | undefined;

	const ensureOnce = async (silent: boolean): Promise<PythonRuntimeOutcome> => {
		const uvPath = await deps.ensureUv(silent);
		if (!uvPath) {
			return { status: "uv-unavailable", reason: "uv is unavailable; run `pi doctor` or reconnect and retry." };
		}

		const runtimeRoot = runtimesDir("python", deps.agentDir);
		const cacheRoot = cacheFile(deps.agentDir, "uv");
		deps.makeDirectory(runtimeRoot);
		deps.makeDirectory(cacheRoot);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			UV_CACHE_DIR: cacheRoot,
			UV_NO_PROGRESS: "1",
			UV_PYTHON_INSTALL_DIR: runtimeRoot,
		};
		const findArgs = ["python", "find", PYTHON_RUNTIME_REQUEST, "--no-project"];
		const findPython = () =>
			deps.run(uvPath, findArgs, deps.agentDir, {
				timeoutMs: PYTHON_RUNTIME_FIND_TIMEOUT_MS,
				env,
			});
		const resolveFoundPython = (result: PythonRuntimeCommandResult): PythonRuntimeOutcome | undefined => {
			if (result.code !== 0 || result.killed) return undefined;
			const pythonPath = result.stdoutTruncated === false ? interpreterPathOutput(result.stdout) : undefined;
			if (!pythonPath) {
				return {
					status: "python-unavailable",
					reason: "uv reported success without a complete Python interpreter path.",
				};
			}
			const identity = deps.inspectInterpreter(pythonPath);
			if (identity === undefined) {
				return {
					status: "python-unavailable",
					reason: `uv reported a Python path that is not an available executable file: ${pythonPath}`,
				};
			}
			lastInterpreterIdentity = identity;
			return { status: "ready", uvPath, pythonPath, pythonInstalled: false };
		};

		const initialFind = await findPython();
		const initialOutcome = resolveFoundPython(initialFind);
		if (initialOutcome) return initialOutcome;
		if (deps.isOffline()) {
			return {
				status: "offline",
				reason: "No Python interpreter is available and offline mode prevents uv from installing one.",
			};
		}

		const install = await deps.run(uvPath, ["python", "install", PYTHON_RUNTIME_INSTALL_REQUEST], deps.agentDir, {
			timeoutMs: PYTHON_RUNTIME_INSTALL_TIMEOUT_MS,
			env,
		});
		if (install.code !== 0 || install.killed) {
			const diagnostic = boundedDiagnostic(install.stderr || install.stdout || "no diagnostics");
			return {
				status: "python-unavailable",
				reason: `uv python install failed${install.killed ? " or timed out" : ""}: ${diagnostic}`,
			};
		}

		const installedFind = await findPython();
		const installedOutcome = resolveFoundPython(installedFind);
		if (installedOutcome?.status === "ready") return { ...installedOutcome, pythonInstalled: true };
		if (installedOutcome) return installedOutcome;
		const diagnostic = boundedDiagnostic(installedFind.stderr || installedFind.stdout || "no diagnostics");
		return {
			status: "python-unavailable",
			reason: `uv installed Python but could not resolve it: ${diagnostic}`,
		};
	};

	return {
		ensure(options = {}) {
			if (inFlight) return inFlight;
			const force = options.force ?? false;
			if (!force && lastOutcome?.status === "ready") {
				const current = deps.inspectInterpreter(lastOutcome.pythonPath);
				if (current !== undefined && current === lastInterpreterIdentity) return Promise.resolve(lastOutcome);
			}
			if (
				!force &&
				lastOutcome &&
				lastOutcome.status !== "ready" &&
				deps.now() - lastOutcomeAt < PYTHON_RUNTIME_FAILURE_COOLDOWN_MS
			) {
				return Promise.resolve(lastOutcome);
			}
			inFlight = ensureOnce(options.silent ?? true)
				.then((outcome) => {
					lastOutcome = Object.freeze(outcome);
					lastOutcomeAt = deps.now();
					return outcome;
				})
				.finally(() => {
					inFlight = undefined;
				});
			return inFlight;
		},
		getLastOutcome() {
			return lastOutcome;
		},
	};
}

const realPythonRuntimeDependencies: PythonRuntimeDependencies = {
	agentDir: getAgentDir(),
	ensureUv: (silent) => ensureTool("uv", silent),
	isOffline: () => isTruthyEnvFlag(process.env.PI_OFFLINE),
	makeDirectory: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
	inspectInterpreter: inspectPythonInterpreter,
	run: async (command, args, cwd, options) => {
		const result = await execCommand(command, args, cwd, {
			env: options.env,
			maxBuffer: PYTHON_RUNTIME_COMMAND_BUFFER,
			timeout: options.timeoutMs,
		});
		return {
			code: result.code,
			stdout: result.stdout,
			stderr: result.stderr,
			killed: result.killed,
			stdoutTruncated: result.stdoutTruncated,
		};
	},
	now: Date.now,
};

const pythonRuntimeManager = createPythonRuntimeManager(realPythonRuntimeDependencies);

export function ensurePythonRuntime(options?: { silent?: boolean; force?: boolean }): Promise<PythonRuntimeOutcome> {
	return pythonRuntimeManager.ensure(options);
}

export function getLastPythonRuntimeOutcome(): PythonRuntimeOutcome | undefined {
	return pythonRuntimeManager.getLastOutcome();
}
