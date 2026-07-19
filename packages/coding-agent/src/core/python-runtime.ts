import { existsSync, mkdirSync } from "node:fs";
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
}

export interface PythonRuntimeDependencies {
	agentDir: string;
	ensureUv: (silent: boolean) => Promise<string | undefined>;
	isOffline: () => boolean;
	makeDirectory: (path: string) => void;
	pathExists: (path: string) => boolean;
	run: (
		command: string,
		args: string[],
		cwd: string,
		options: PythonRuntimeCommandOptions,
	) => Promise<PythonRuntimeCommandResult>;
	now: () => number;
}

export type PythonRuntimeOutcome =
	| {
			status: "ready";
			uvPath: string;
			pythonPath: string;
			pythonInstalled: boolean;
	  }
	| {
			status: "offline" | "uv-unavailable" | "python-unavailable";
			reason: string;
	  };

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

function firstNonemptyLine(value: string): string | undefined {
	return value
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.find(Boolean);
}

export function createPythonRuntimeManager(deps: PythonRuntimeDependencies): PythonRuntimeManager {
	let inFlight: Promise<PythonRuntimeOutcome> | undefined;
	let lastOutcome: PythonRuntimeOutcome | undefined;
	let lastOutcomeAt = 0;

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
			const pythonPath = firstNonemptyLine(result.stdout);
			if (!pythonPath) {
				return { status: "python-unavailable", reason: "uv reported success without a Python interpreter path." };
			}
			if (!deps.pathExists(pythonPath)) {
				return {
					status: "python-unavailable",
					reason: `uv reported a Python path that does not exist: ${pythonPath}`,
				};
			}
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
			const force = options.force ?? false;
			if (!force && lastOutcome?.status === "ready") return Promise.resolve(lastOutcome);
			if (
				!force &&
				lastOutcome &&
				lastOutcome.status !== "ready" &&
				deps.now() - lastOutcomeAt < PYTHON_RUNTIME_FAILURE_COOLDOWN_MS
			) {
				return Promise.resolve(lastOutcome);
			}
			if (inFlight) return inFlight;
			inFlight = ensureOnce(options.silent ?? true)
				.then((outcome) => {
					lastOutcome = outcome;
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
	pathExists: existsSync,
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
