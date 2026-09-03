import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { Agent } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { createSilenceWatchdog } from "@caupulican/pi-agent-core/reliability";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
} from "@caupulican/pi-agent-core/truncate";
import { type AgentTool, AgentToolExecutionError } from "@caupulican/pi-agent-core/types";
import { Container, Text, truncateToWidth } from "@caupulican/pi-tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import { createPowerShellHostEnvironment, POWERSHELL_7_GUARD } from "../../utils/powershell-session-protocol.ts";
import {
	getPlatformShellToolName,
	getShellConfig,
	getShellEnv,
	type PlatformShellToolName,
	type ShellSessionContext,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ManagedToolResolver } from "../../utils/tools-manager.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import type { SettingsManager } from "../settings-manager.ts";
import {
	type FileFailureRecoveryAuthority,
	selectFileFailureRecoveryAuthority,
	WORKSPACE_MUTATED_RECOVERY_TARGET_KIND,
	workspaceRecoveryTarget,
} from "./file-failure-recovery.ts";
import { withExclusiveMutationBarrier } from "./file-mutation-queue.ts";
import { classifyGitCommand, executeFilteredGit } from "./git-filter.ts";
import { prepareManagedShellEnvironment } from "./managed-shell-preparation.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import {
	assessShellSearchScope,
	BROAD_SEARCH_OUTPUT_ROUTE,
	expectedContentSearchNoMatch,
} from "./search-command-guard.ts";
import { tokenizeShellCommand } from "./shell-command-parser.ts";
import { routeShellContract } from "./shell-contract-router.ts";
import {
	createShellOutputProjector,
	type ShellOutputProjection,
	type ShellOutputProjectionDetails,
} from "./shell-output-projection.ts";
import { acquirePersistentShellSession } from "./shell-session.ts";
import { classifyShellVerificationCommand } from "./shell-test-command.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { createWindowsShellEngineOperations, type WindowsShellEngineOptions } from "./windows-shell-engine.ts";
import { getOrCreateWindowsShellState, mergeEffectiveEnv, resolveEffectiveCwd } from "./windows-shell-state.ts";

/** Low-level silence bound retained for direct shell-operation consumers. Agent tool calls always pass a wall-clock bound. */
const DEFAULT_COMMAND_SILENCE_MS = 600_000;
/** Agent-facing wall-clock bound: continuously producing output must not make a command immortal. */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
export const MAX_COMMAND_TIMEOUT_SECONDS = 3600;
const MIN_COMMAND_TIMEOUT_SECONDS = 0.1;
let commandSilenceMsOverride: number | undefined;
let commandTimeoutMsOverride: number | undefined;

/** Test hook: override the low-level silence threshold. Pass undefined to restore the default. */
export function setCommandSilenceMsForTests(ms: number | undefined): void {
	commandSilenceMsOverride = ms;
}

/** Test hook: override the agent tool's default wall-clock bound. Pass undefined to restore it. */
export function setCommandTimeoutMsForTests(ms: number | undefined): void {
	commandTimeoutMsOverride = ms;
}

export function resolveCommandTimeoutSeconds(timeout: number | undefined): number {
	if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
		return DEFAULT_COMMAND_TIMEOUT_SECONDS;
	}
	return Math.max(MIN_COMMAND_TIMEOUT_SECONDS, Math.min(timeout, MAX_COMMAND_TIMEOUT_SECONDS));
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			maximum: MAX_COMMAND_TIMEOUT_SECONDS,
			description: `Wall-clock timeout in SECONDS, not milliseconds. Defaults to ${DEFAULT_COMMAND_TIMEOUT_SECONDS}; positive overrides are capped at ${MAX_COMMAND_TIMEOUT_SECONDS}. Zero or negative values use the default.`,
		}),
	),
	broadSearch: Type.Optional(
		Type.Literal(BROAD_SEARCH_OUTPUT_ROUTE, {
			description:
				"Explicit override for a broad rg/grep/find/fd scan that cannot be narrowed. The command runs, but its complete output is routed to a file and excluded from model context.",
		}),
	),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	fullOutputError?: string;
	persistedOutputTruncated?: boolean;
	persistedOutputBytes?: number;
	preview?: {
		content: string;
		skippedLines: number;
	};
	outputProjection?: ShellOutputProjectionDetails;
	piVerification?: {
		version: 1;
		id: string;
		status: "failed" | "passed";
	};
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed) plus, when the backend tracks it,
	 * the shell-reported working directory after the command ran
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null; cwd?: string }>;
}

function createLocalShellOperations(
	shellName: PlatformShellToolName,
	options?: { shellPath?: string; sessionKey?: string },
): BashOperations {
	// A session key selects the persistent per-agent backend. An explicit custom shell path keeps
	// per-command spawning: persistent sessions assume the resolved platform shell's flag set.
	const sessionKey = options?.sessionKey;
	if (sessionKey !== undefined && !options?.shellPath) {
		return {
			exec: async (command, cwd, { onData, signal, timeout, env }) => {
				try {
					await fsAccess(cwd, constants.F_OK);
				} catch {
					throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
				}
				if (signal?.aborted) throw new Error("aborted");
				const session = acquirePersistentShellSession(sessionKey, shellName);
				const silenceMs = commandSilenceMsOverride ?? DEFAULT_COMMAND_SILENCE_MS;
				const hasWallClock = timeout !== undefined && timeout > 0;
				return session.exec(command, cwd, {
					onData,
					signal,
					env,
					timeoutSeconds: hasWallClock ? timeout : undefined,
					silenceMs: !hasWallClock && silenceMs > 0 ? silenceMs : undefined,
				});
			},
		};
	}
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const { shell, args } = getShellConfig(options?.shellPath, shellName);
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}
			if (signal?.aborted) throw new Error("aborted");

			const shellEnvironment = env ?? getShellEnv();
			const hostedCommand = shellName === "powershell" ? `${POWERSHELL_7_GUARD}${command}` : command;
			const child = spawn(shell, [...args, hostedCommand], {
				cwd,
				detached: process.platform !== "win32",
				env: shellName === "powershell" ? createPowerShellHostEnvironment(shellEnvironment) : shellEnvironment,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (child.pid) trackDetachedChildPid(child.pid);
			const terminationController = new AbortController();
			const onAbort = () => terminationController.abort();
			let silenceKilled = false;
			const silenceMs = commandSilenceMsOverride ?? DEFAULT_COMMAND_SILENCE_MS;
			const silenceWatchdog =
				(timeout === undefined || timeout <= 0) && silenceMs > 0
					? createSilenceWatchdog({
							silenceMs,
							onSilence: () => {
								silenceKilled = true;
								terminationController.abort();
							},
						})
					: undefined;
			const onChunk = (data: Buffer) => {
				silenceWatchdog?.touch();
				onData(data);
			};

			try {
				child.stdout?.on("data", onChunk);
				child.stderr?.on("data", onChunk);
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				const terminal = await waitForChildProcessWithTermination(child, {
					signal: terminationController.signal,
					timeoutMs: timeout !== undefined && timeout > 0 ? timeout * 1000 : undefined,
					killGraceMs: 2_000,
				});
				if (signal?.aborted) throw new Error("aborted");
				if (terminal.reason === "timeout") throw new Error(`timeout:${timeout}`);
				if (silenceKilled) throw new Error(`silence:${silenceMs / 1000}`);
				return { exitCode: terminal.code };
			} finally {
				silenceWatchdog?.disarm();
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string; sessionKey?: string }): BashOperations {
	return createLocalShellOperations("bash", options);
}

/** Create PowerShell operations using pi's built-in local execution backend. */
export function createLocalPowerShellOperations(options?: { shellPath?: string; sessionKey?: string }): BashOperations {
	return createLocalShellOperations("powershell", options);
}

/** Create the platform shell backend without requiring callers or the model to choose a shell. */
export function createLocalPlatformShellOperations(
	options: {
		shellPath?: string;
		commandPrefix?: string;
		operations?: BashOperations;
		sessionKey?: string;
		/** Route complex/state-mutating Bash constructs and portable builtins to the Python engine on Windows. Default: true. */
		pythonEngine?: boolean;
		/** Test/embedding hook: overrides the engine tier's runtime/spawn/state resolution. */
		engineOptions?: WindowsShellEngineOptions;
	} = {},
	platform: NodeJS.Platform = process.platform,
): BashOperations {
	const operations =
		options.operations ??
		createLocalShellOperations(getPlatformShellToolName(platform), {
			shellPath: options.shellPath,
			sessionKey: options.sessionKey,
		});
	const pythonEngineEnabled = options.pythonEngine !== false;
	// One factory instance is one fallback tenant. Production agent sessions always pass their
	// stable key; standalone callers that omit it must never collapse into a process-global engine.
	const engineSessionKey = options.sessionKey ?? `platform-shell-operations:${randomUUID()}`;
	const engineOperations = createWindowsShellEngineOperations(engineSessionKey, options.engineOptions);
	return {
		async exec(command, cwd, execOptions) {
			let resolvedCommand = command;
			let resolvedCwd = cwd;
			let resolvedExecOptions = execOptions;
			if (platform === "win32") {
				const route = routeShellContract(command, platform, { pythonEngine: pythonEngineEnabled });
				if (route.kind === "unsupported") throw new Error(route.error);
				// The engine is the sole state mutator (D4); every Windows call — engine or PS
				// tier — reads the SAME session state so a `cd`/`export` in one call is observed
				// by the very next call regardless of which tier runs it.
				const state = getOrCreateWindowsShellState(engineSessionKey);
				resolvedCwd = resolveEffectiveCwd(state, cwd);
				resolvedExecOptions = { ...execOptions, env: mergeEffectiveEnv(state, execOptions.env ?? getShellEnv()) };
				if (route.kind === "python-engine") {
					// The engine owns the state transition and resolves the original host cwd
					// exactly once. Passing the already state-adjusted cwd here would make the
					// engine mistake its own `cd` result for a host cwd change on the next call.
					return engineOperations.exec(route.command, cwd, execOptions);
				}
				if (route.kind === "powershell") resolvedCommand = route.command;
			}
			if (options.commandPrefix) resolvedCommand = `${options.commandPrefix}\n${resolvedCommand}`;
			return operations.exec(resolvedCommand, resolvedCwd, resolvedExecOptions);
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

export interface ShellSessionContextDeps {
	getAgent(): Agent;
	getSessionManager(): Pick<SessionManager, "getSessionId" | "getSessionFile">;
	getSettingsManager(): Pick<SettingsManager, "getExposeSessionEnvironment">;
}

/**
 * Build the live shell session identity (P2k) from the running session: sessionId/file, the
 * CURRENT provider/model/thinkingLevel (read fresh, not snapshotted, so a mid-session /model or
 * /thinking change is reflected on the very next command), and whether the setting allows exposing
 * any of it at all.
 */
export function buildShellSessionContext(deps: ShellSessionContextDeps): ShellSessionContext {
	const state = deps.getAgent().state;
	return {
		sessionId: deps.getSessionManager().getSessionId(),
		sessionFile: deps.getSessionManager().getSessionFile(),
		provider: state.model.provider,
		model: state.model.id,
		thinkingLevel: state.thinkingLevel,
		exposeSessionEnvironment: deps.getSettingsManager().getExposeSessionEnvironment(),
	};
}

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook?: BashSpawnHook,
	getShellSessionContext?: () => ShellSessionContext,
): BashSpawnContext {
	// Delete-first-then-repopulate (getShellEnv) must run BEFORE the spawn hook: a nested pi must
	// never inherit its parent's identity, and a hook (e.g. credential injection) must only ever see
	// an already-correct base environment, never patch around a missing one.
	const baseContext: BashSpawnContext = {
		command,
		cwd,
		env: { ...getShellEnv(undefined, undefined, getShellSessionContext?.()) },
	};
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Platform used to choose the default backend and contract router. Defaults to process.platform. */
	platform?: NodeJS.Platform;
	/** Custom operations for command execution. Default: local platform shell */
	operations?: BashOperations;
	/** Shared backend identity for exact cross-tool recovery with custom operations. */
	failureRecoveryAuthority?: FileFailureRecoveryAuthority;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/**
	 * Live shell session identity (P2k), read fresh on every command. Build with
	 * `buildShellSessionContext`. Omit to keep PI_SESSION_ID/FILE/PROVIDER/MODEL/REASONING_LEVEL
	 * absent entirely (the delete-first step in getShellEnv still applies either way).
	 */
	getShellSessionContext?: () => ShellSessionContext;
	/**
	 * Stable key for this agent's persistent shell session. The host passes its per-agent key so
	 * the session survives runtime reloads and user `!` commands share it; separately created
	 * tool instances (subagents) auto-generate their own key and stay isolated.
	 */
	sessionKey?: string;
	/** Route complex/state-mutating Bash constructs and portable builtins to the Python engine on Windows. Default: true. */
	windowsShellPythonEngine?: boolean;
	/** Test/embedding hook: overrides the engine tier's runtime/spawn/state resolution. */
	windowsShellEngineOptions?: WindowsShellEngineOptions;
	/** Start the native Windows PowerShell session during runtime initialization. Default: false. */
	prewarmWindowsShell?: boolean;
	/** Test/embedding hook: override the managed directory used for complete command output. */
	outputDirectory?: string;
	/** Injectable managed-tool resolver for local shell preparation. */
	managedToolResolver?: ManagedToolResolver;
}

const BASH_PREVIEW_LINES = 5;
const BASH_PREVIEW_BYTES = 8 * 1024;
const BASH_UPDATE_THROTTLE_MS = 100;
const BROAD_SEARCH_MAX_PERSISTED_BYTES = 8 * 1024 * 1024;

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatBashCall(
	args: { command?: string; timeout?: number } | undefined,
	shellName: PlatformShellToolName,
): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	const prompt = shellName === "powershell" ? "PS>" : "$";
	return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
): void {
	const state = component.state;
	component.clear();

	const renderPreview = !options.expanded ? result.details?.preview : undefined;
	let output = (renderPreview ? renderPreview.content : getTextOutput(result as any, showImages)).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	const fullOutputError = result.details?.fullOutputError;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		if (options.expanded) {
			const styledOutput = output
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(output, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines.map((line) => theme.fg("toolOutput", line));
						state.cachedSkipped = (result.details?.preview?.skippedLines ?? 0) + preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")})`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath || fullOutputError) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		} else if (fullOutputError) {
			warnings.push(`Full output unavailable: ${fullOutputError}`);
		}
		if (truncation?.truncated) {
			if (truncation.content.includes("...[middle omitted:")) {
				warnings.push(`Truncated: head+tail preview of ${truncation.totalLines} lines`);
			} else if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}
}

/** Ad-hoc Python/Node eval or heredoc probes are not workspace mutations. */
function isAdHocInterpreterProbe(command: string): boolean {
	const tokens = tokenizeShellCommand(command);
	if (!tokens) return false;
	let args: string[] = [];
	let hasHeredoc = false;
	let skipHeredocDelimiter = false;
	const segmentIsProbe = (): boolean => {
		let runtimeIndex = 0;
		while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[runtimeIndex] ?? "")) runtimeIndex++;
		const commandName = args[runtimeIndex]?.split(/[\\/]/).at(-1)?.toLowerCase();
		if (commandName === "env") {
			runtimeIndex++;
			while (runtimeIndex < args.length) {
				const arg = args[runtimeIndex];
				if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) || /^(?:-i|--ignore-environment|--null)$/.test(arg)) {
					runtimeIndex++;
					continue;
				}
				if (/^(?:-u|--unset|-C|--chdir)$/.test(arg)) {
					runtimeIndex += 2;
					continue;
				}
				if (/^--(?:unset|chdir)=/.test(arg)) {
					runtimeIndex++;
					continue;
				}
				if (arg === "--") runtimeIndex++;
				break;
			}
		}
		const executable = args[runtimeIndex]
			?.split(/[\\/]/)
			.at(-1)
			?.toLowerCase()
			.replace(/\.exe$/, "");
		const runtime =
			executable === "node"
				? "node"
				: /^(?:python\d*(?:\.\d+)?|pypy\d*)$/.test(executable ?? "")
					? "python"
					: undefined;
		if (!runtime) return false;
		for (let index = runtimeIndex + 1; index < args.length; index++) {
			const arg = args[index];
			if (runtime === "node" && /^(?:-c|-e|-p|--eval|--print)(?:=.*)?$/.test(arg)) return true;
			if (runtime === "python" && arg === "-c") return true;
			if (arg === "-") return hasHeredoc;
			if (arg === "--") return hasHeredoc && (args[index + 1] === undefined || args[index + 1] === "-");
			if (!arg.startsWith("-")) return false;
		}
		return hasHeredoc;
	};
	for (const token of tokens) {
		if (token.kind === "arg") {
			if (skipHeredocDelimiter) skipHeredocDelimiter = false;
			else args.push(token.value);
			continue;
		}
		if (token.kind === "redirect") {
			if (token.value.includes("<<")) {
				hasHeredoc = true;
				skipHeredocDelimiter = true;
			}
			continue;
		}
		if (segmentIsProbe()) return true;
		args = [];
		hasHeredoc = false;
		skipHeredocDelimiter = false;
	}
	return segmentIsProbe();
}

function createShellToolDefinition(
	cwd: string,
	backendShell: PlatformShellToolName,
	contractPlatform: NodeJS.Platform,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined> {
	const toolName = "bash";
	const sessionKey = options?.sessionKey ?? `bash-tool:${randomUUID()}`;
	const ops =
		options?.operations ??
		(backendShell === "powershell"
			? createLocalPowerShellOperations({ shellPath: options?.shellPath, sessionKey })
			: createLocalBashOperations({ shellPath: options?.shellPath, sessionKey }));
	const failureRecoveryAuthority = selectFileFailureRecoveryAuthority(
		options?.operations !== undefined,
		options?.failureRecoveryAuthority,
	);
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	const hasExecutionOverrides = Boolean(options?.operations || options?.shellPath || commandPrefix || spawnHook);
	const canFilterCommand = !hasExecutionOverrides;
	const routesWindowsContract = contractPlatform === "win32";
	const pythonEngineEnabled = options?.windowsShellPythonEngine !== false;
	const engineOperations = routesWindowsContract
		? createWindowsShellEngineOperations(sessionKey, options?.windowsShellEngineOptions)
		: undefined;
	if (
		options?.prewarmWindowsShell === true &&
		process.platform === "win32" &&
		routesWindowsContract &&
		backendShell === "powershell" &&
		options.operations === undefined &&
		options.shellPath === undefined
	) {
		const session = acquirePersistentShellSession(sessionKey, backendShell);
		setImmediate(() => {
			const context = resolveSpawnContext("", cwd, spawnHook, options?.getShellSessionContext);
			context.env = mergeEffectiveEnv(getOrCreateWindowsShellState(sessionKey), context.env);
			void session.prewarm(context.cwd, context.env).catch(() => {
				// The first real command retries and surfaces the complete candidate failure.
			});
		});
	}
	const contractDescription = routesWindowsContract
		? "Execute Pi's stable Bash-like command contract in a persistent per-agent shell session (starts at the project working directory; current directory and environment variables persist across calls, including across the PowerShell and Python engine tiers; a failed command reports its effective cwd on a final `cwd:` line). On Windows, a deterministic router converts simple commands directly to PowerShell and routes word-list and arithmetic for loops, break/continue, portable builtins such as printf, pipelines, redirection, expansion, chaining, and state-mutating commands (cd/export/unset) through a bundled Python engine that implements the supported Bash grammar; named unsupported constructs (job control, process substitution, heredocs, nested shells, and similar) fail closed instead of being guessed."
		: "Execute a Bash command in a persistent per-agent shell session that starts at the project working directory: `cd` and environment variables persist across calls, a failed command reports its effective cwd on a final `cwd:` line, and a timed-out or aborted command resets the session.";
	return {
		name: toolName,
		label: toolName,
		description: `${contractDescription} Returns stdout and stderr. Output is truncated to a head+tail preview within ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a managed file. Recognized test runners return a bounded failure/summary projection when it is materially smaller, with exact output saved to a managed file. Broad rg/grep/find/fd scans are rejected before execution; when an exhaustive scan is unavoidable, set broadSearch="${BROAD_SEARCH_OUTPUT_ROUTE}" to route all output to a managed file instead of model context. Commands have a ${DEFAULT_COMMAND_TIMEOUT_SECONDS}-second wall-clock default, including commands that keep producing output; use a positive timeout only when a scoped operation justifies a larger bound (maximum ${MAX_COMMAND_TIMEOUT_SECONDS} seconds).`,
		promptSnippet: routesWindowsContract
			? "Run Bash-like commands; Pi routes Windows."
			: "Execute Bash commands (ls, grep, find, etc.)",
		promptGuidelines: routesWindowsContract
			? [
					"On Windows, use Bash-like commands; never write PowerShell/ask owner to choose shell.",
					"Supports for, break/continue, printf, pipes/redirection, expansions, chaining; unhandled syntax fails closed.",
					"cd/export/unset state persists across bash calls and PowerShell/Python tiers.",
					"File commands use literal paths; verify targets before recursive rm/cp/mv.",
					`Bash timeout values are seconds; omit to use the ${DEFAULT_COMMAND_TIMEOUT_SECONDS}s default.`,
					`Search narrowly: root/filters, prefer grep/find. A broad scan runs with its output routed to a managed file (as with broadSearch="${BROAD_SEARCH_OUTPUT_ROUTE}"); inspect it narrowly.`,
				]
			: [
					`Bash timeout values are seconds, not milliseconds; omit timeout to use the ${DEFAULT_COMMAND_TIMEOUT_SECONDS}s default.`,
					`Search narrowly: root/filters, prefer grep/find. A broad scan runs with its output routed to a managed file (as with broadSearch="${BROAD_SEARCH_OUTPUT_ROUTE}"); inspect it narrowly.`,
				],
		parameters: bashSchema,
		failureRecovery: {
			getFailureTargets: (params, failure) =>
				failureRecoveryAuthority &&
				/^exit_-?[1-9]\d*$/.test(failure.failureCode) &&
				!isAdHocInterpreterProbe(typeof params.command === "string" ? params.command : "")
					? [workspaceRecoveryTarget(failureRecoveryAuthority, WORKSPACE_MUTATED_RECOVERY_TARGET_KIND, cwd)]
					: [],
		},
		async execute(
			_toolCallId,
			{
				command,
				timeout,
				broadSearch,
			}: { command: string; timeout?: number; broadSearch?: typeof BROAD_SEARCH_OUTPUT_ROUTE },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			const searchScope = assessShellSearchScope(command, cwd);
			// A broad scan is not refused: it runs with its output routed to a managed file, exactly as
			// the explicit broadSearch route does, and the result says why. Refusing it cost a turn and
			// armed the failure ledger in every live session that tried one (3 of 15 refusals measured),
			// for an outcome the route already makes safe: nothing of the scan reaches the context
			// except the path and a bounded view.
			const routeBroadSearchOutput = searchScope.kind === "broad";
			const autoRoutedReason =
				searchScope.kind === "broad" && broadSearch !== BROAD_SEARCH_OUTPUT_ROUTE ? searchScope.reason : undefined;
			let outputProjector =
				routeBroadSearchOutput || commandPrefix || spawnHook ? undefined : createShellOutputProjector(command);
			const output = new OutputAccumulator({
				tempFilePrefix: `pi-${toolName}`,
				tempDirectory: options?.outputDirectory,
				persistAllOutput: routeBroadSearchOutput,
				maxPersistedBytes: routeBroadSearchOutput ? BROAD_SEARCH_MAX_PERSISTED_BYTES : undefined,
				windowsCompatibleEncoding: routesWindowsContract,
			});
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.previewSnapshot(BASH_PREVIEW_LINES, BASH_PREVIEW_BYTES, {
					persistIfFullTruncated: true,
				});
				if (routeBroadSearchOutput) {
					const notice = snapshot.fullOutputPath
						? `Broad search running. Output is being routed to ${snapshot.fullOutputPath}`
						: "Broad search running. Output is being routed to a managed file";
					onUpdate({
						content: [{ type: "text", text: notice }],
						details: {
							fullOutputPath: snapshot.fullOutputPath,
							fullOutputError: snapshot.fullOutputError,
							persistedOutputTruncated: snapshot.persistedOutputTruncated,
							persistedOutputBytes: snapshot.persistedOutputBytes,
						},
					});
					return;
				}
				const preview = {
					content: snapshot.content.replace(/\r/g, ""),
					skippedLines: Math.max(0, snapshot.truncation.totalLines - snapshot.truncation.outputLines),
				};
				onUpdate({
					content: [{ type: "text", text: preview.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
						fullOutputError: snapshot.fullOutputError,
						preview,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				output.append(data);
				if (outputProjector) {
					try {
						outputProjector.append(data);
					} catch {
						// Projection is opportunistic. Raw output remains authoritative.
						outputProjector = undefined;
					}
				}
				scheduleOutputUpdate();
			};

			const finishOutput = async (persistAlways = false) => {
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				return output.snapshot({ persistIfTruncated: true, persistAlways });
			};

			const finishProjection = (exitCode: number | null): ShellOutputProjection | undefined => {
				if (!outputProjector) return undefined;
				try {
					return outputProjector.finish(exitCode);
				} catch {
					outputProjector = undefined;
					return undefined;
				}
			};

			const formatOutput = (
				snapshot: Awaited<ReturnType<typeof finishOutput>>,
				emptyText = "(no output)",
				projection?: ShellOutputProjection,
			) => {
				const truncation = snapshot.truncation;
				if (routeBroadSearchOutput) {
					if (snapshot.fullOutputPath) {
						const persistenceNotice = snapshot.persistedOutputTruncated
							? `The managed ${formatSize(BROAD_SEARCH_MAX_PERSISTED_BYTES)} file limit was reached; later output was discarded.`
							: "";
						const autoRoutedNotice = autoRoutedReason
							? `Routed automatically because ${autoRoutedReason}; a narrower search would have returned inline. `
							: "";
						return {
							text: `Broad search output routed to ${snapshot.fullOutputPath}. ${autoRoutedNotice}${persistenceNotice} Inspect it with bounded read offsets or a narrower search.`,
							details: {
								...(truncation.truncated ? { truncation } : {}),
								fullOutputPath: snapshot.fullOutputPath,
								persistedOutputTruncated: snapshot.persistedOutputTruncated,
								persistedOutputBytes: snapshot.persistedOutputBytes,
							},
						};
					}
					const boundedTail = snapshot.content.replace(/\r/g, "") || emptyText;
					return {
						text: `Broad search output could not be routed to a managed file${snapshot.fullOutputError ? `: ${snapshot.fullOutputError}` : ""}. Bounded tail:\n${boundedTail}`,
						details: {
							...(truncation.truncated ? { truncation } : {}),
							fullOutputError: snapshot.fullOutputError ?? "managed output file unavailable",
						},
					};
				}
				let text = (projection?.content ?? snapshot.content).replace(/\r/g, "") || emptyText;
				let details: BashToolDetails | undefined;
				const preview = projection
					? (() => {
							const lines = projection.content.split("\n");
							return {
								content: lines.slice(-BASH_PREVIEW_LINES).join("\n"),
								skippedLines: Math.max(0, lines.length - BASH_PREVIEW_LINES),
							};
						})()
					: output.preview(BASH_PREVIEW_LINES, BASH_PREVIEW_BYTES);
				const fullOutputNotice = snapshot.fullOutputPath
					? `Full output: ${snapshot.fullOutputPath}`
					: snapshot.fullOutputError
						? `Full output unavailable: ${snapshot.fullOutputError}`
						: "Full output unavailable";
				if (truncation.truncated || preview.skippedLines > 0 || projection) {
					details = { preview };
				}
				if (snapshot.fullOutputPath || snapshot.fullOutputError) {
					details = {
						...(details ?? {}),
						fullOutputPath: snapshot.fullOutputPath,
						fullOutputError: snapshot.fullOutputError,
					};
				}
				if (truncation.truncated) {
					details = {
						...(details ?? {}),
						truncation,
						fullOutputPath: snapshot.fullOutputPath,
						fullOutputError: snapshot.fullOutputError,
					};
					if (!projection) {
						const endLine = truncation.totalLines;
						if (truncation.lastLinePartial) {
							const lastLineSize = formatSize(output.getLastLineBytes());
							text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). ${fullOutputNotice}]`;
						} else if (truncation.content.includes("...[middle omitted:")) {
							const limitNote =
								truncation.truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : "";
							text += `\n\n[Showing head+tail preview of ${truncation.totalLines} lines${limitNote}. ${fullOutputNotice}]`;
						} else if (truncation.truncatedBy === "lines") {
							const startLine = truncation.totalLines - truncation.outputLines + 1;
							text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. ${fullOutputNotice}]`;
						} else {
							const startLine = truncation.totalLines - truncation.outputLines + 1;
							text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). ${fullOutputNotice}]`;
						}
					}
				}
				if (projection) {
					details = {
						...(details ?? {}),
						outputProjection: {
							kind: projection.kind,
							inputLines: projection.inputLines,
							inputBytes: projection.inputBytes,
							outputLines: projection.outputLines,
							outputBytes: projection.outputBytes,
							omittedLines: projection.omittedLines,
							collapsedPassingLines: projection.collapsedPassingLines,
						},
					};
					const passingNotice =
						projection.collapsedPassingLines > 0
							? ` ${projection.collapsedPassingLines} passing/progress lines collapsed.`
							: "";
					text += `\n\n[Test output filtered: retained ${projection.inputLines - projection.omittedLines} of ${projection.inputLines} lines.${passingNotice} ${fullOutputNotice}]`;
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
			const withVerification = (
				details: BashToolDetails | undefined,
				status: "failed" | "passed",
				effectiveCwd: string,
			) => {
				const verification =
					!commandPrefix && !spawnHook ? classifyShellVerificationCommand(command, effectiveCwd) : undefined;
				return verification
					? { ...(details ?? {}), piVerification: { version: 1 as const, id: verification.id, status } }
					: details;
			};
			// The shell ran the command to completion and is reporting the process's own status. That is
			// the observation the caller asked for — a red test run, a search that matched nothing, a
			// false predicate — so it is an operation outcome, never a failure of this tool.
			const createExitError = (text: string, exitCode: number, effectiveCwd: string) =>
				new AgentToolExecutionError(
					appendStatus(text, `Command exited with code ${exitCode}\ncwd: ${effectiveCwd}`),
					`exit_${exitCode}`,
					output.getOutputSignature(),
					"operation_outcome",
				);
			const effectiveTimeoutSeconds =
				typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
					? resolveCommandTimeoutSeconds(timeout)
					: (commandTimeoutMsOverride ?? DEFAULT_COMMAND_TIMEOUT_SECONDS * 1000) / 1000;

			try {
				if (canFilterCommand) {
					const classification = classifyGitCommand(command, getShellEnv());
					if (classification.eligible && classification.subcommand) {
						const res = await executeFilteredGit(
							cwd,
							classification.subcommand,
							classification.globalOptions || [],
							classification.subcommandArgs || [],
							{ signal, timeout: effectiveTimeoutSeconds },
						);
						if (res.exitCode !== -100) {
							output.append(res.rawBytes ?? Buffer.from(res.rawOut, "utf-8"));
							const snapshot = await finishOutput();
							if (res.exitCode !== 0) {
								const { text: rawOutputText } = formatOutput(snapshot);
								// executeFilteredGit runs at the host cwd by construction.
								throw createExitError(rawOutputText, res.exitCode, cwd);
							}
							const details = snapshot.truncation.truncated
								? {
										truncation: snapshot.truncation,
										fullOutputPath: snapshot.fullOutputPath,
										fullOutputError: snapshot.fullOutputError,
									}
								: snapshot.fullOutputPath || snapshot.fullOutputError
									? { fullOutputPath: snapshot.fullOutputPath, fullOutputError: snapshot.fullOutputError }
									: undefined;
							return { content: [{ type: "text", text: res.output }], details };
						}
					}
				}

				let backendCommand = command;
				let engineRoute = false;
				let effectiveCwd = cwd;
				if (routesWindowsContract) {
					const route = routeShellContract(command, contractPlatform, { pythonEngine: pythonEngineEnabled });
					if (route.kind === "unsupported") throw new Error(route.error);
					if (route.kind === "python-engine") engineRoute = true;
					backendCommand = route.command;
					// The engine is the sole state mutator (D4); every Windows call — engine or PS
					// tier — reads the SAME session state so a `cd`/`export` in one call is observed
					// by the very next call regardless of which tier runs it.
					effectiveCwd = resolveEffectiveCwd(getOrCreateWindowsShellState(sessionKey), cwd);
				}
				// The engine executes the RAW Bash source unchanged: an arbitrary PowerShell
				// commandPrefix would not parse as Bash grammar.
				const resolvedCommand = engineRoute
					? backendCommand
					: commandPrefix
						? `${commandPrefix}\n${backendCommand}`
						: backendCommand;
				const spawnContext = resolveSpawnContext(
					resolvedCommand,
					effectiveCwd,
					spawnHook,
					options?.getShellSessionContext,
				);
				if (routesWindowsContract) {
					spawnContext.env = mergeEffectiveEnv(getOrCreateWindowsShellState(sessionKey), spawnContext.env);
				}
				if (options?.operations === undefined) {
					spawnContext.env = await prepareManagedShellEnvironment(
						spawnContext.command,
						spawnContext.env,
						options?.managedToolResolver,
					);
				}

				let exitCode: number | null;
				let sessionCwd: string | undefined;
				try {
					// Shell commands cannot statically declare which files they mutate, so the
					// actual execution takes the coarse exclusive barrier: it waits for
					// in-flight edit/write mutations to drain and blocks new ones meanwhile.
					const result = await withExclusiveMutationBarrier(() =>
						(engineRoute && engineOperations ? engineOperations : ops).exec(
							spawnContext.command,
							spawnContext.cwd,
							{
								onData: handleData,
								signal,
								timeout: effectiveTimeoutSeconds,
								env: spawnContext.env,
							},
						),
					);
					exitCode = result.exitCode;
					sessionCwd = result.cwd;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						// The command ran and did not finish in the time the caller allowed: that is the
						// operation's own status, like a non-zero exit, not a failure of this tool.
						const timeoutSecs = err.message.split(":")[1];
						throw new AgentToolExecutionError(
							appendStatus(text, `Command timed out after ${timeoutSecs} seconds`),
							"timeout",
							output.getOutputSignature(),
							"operation_outcome",
						);
					}
					if (err instanceof Error && err.message.startsWith("silence:")) {
						const secs = err.message.split(":")[1];
						const recovery =
							backendShell === "bash"
								? "re-run it with an explicit timeout, or run it in the background with '&'."
								: "re-run it with an explicit timeout.";
						throw new Error(
							appendStatus(
								text,
								`Command killed after ${secs}s of silence (no output). If the command is legitimately quiet for long stretches, ${recovery}`,
							),
						);
					}
					throw err;
				}

				const candidateProjection = finishProjection(exitCode);
				const snapshot = await finishOutput(candidateProjection !== undefined);
				const projection = candidateProjection && snapshot.fullOutputPath ? candidateProjection : undefined;
				const expectedNoMatch = expectedContentSearchNoMatch(command, exitCode);
				const { text: outputText, details } = formatOutput(
					snapshot,
					expectedNoMatch ? "(no matches)" : "(no output)",
					projection,
				);
				// The true directory the command ran in: the session-reported $PWD on POSIX,
				// the state-tracked effective cwd on the Windows contract (the runner protocol
				// does not report one), or the host-requested cwd for per-command backends.
				const reportedCwd = routesWindowsContract
					? resolveEffectiveCwd(getOrCreateWindowsShellState(sessionKey), cwd)
					: (sessionCwd ?? spawnContext.cwd);
				const verification =
					!commandPrefix && !spawnHook ? classifyShellVerificationCommand(command, reportedCwd) : undefined;
				if (exitCode === null) {
					return {
						content: [
							{
								type: "text",
								text: appendStatus(outputText, `Command terminated without an exit code\ncwd: ${reportedCwd}`),
							},
						],
						details: withVerification(details, "failed", reportedCwd),
						isError: true,
						errorKind: "tool_failure",
					};
				}
				if (exitCode !== 0 && exitCode !== null) {
					if (expectedNoMatch) {
						return {
							content: [
								{
									type: "text",
									text: appendStatus(outputText, `Final ${expectedNoMatch} search completed with no matches.`),
								},
							],
							details,
						};
					}
					if (verification) {
						return {
							content: [
								{
									type: "text",
									text: appendStatus(outputText, `Command exited with code ${exitCode}\ncwd: ${reportedCwd}`),
								},
							],
							details: withVerification(details, "failed", reportedCwd),
							isError: true,
							errorKind: "operation_outcome",
						};
					}
					throw createExitError(outputText, exitCode, reportedCwd);
				}
				return {
					content: [{ type: "text", text: outputText }],
					details: withVerification(details, "passed", reportedCwd),
				};
			} finally {
				clearUpdateTimer();
				await output.closeTempFile();
			}
		},
		renderCall(args, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args, toolName));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(component, result as any, options, context.showImages);
			component.invalidate();
			return component;
		},
	};
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined> {
	const platform = options?.platform ?? process.platform;
	return createShellToolDefinition(cwd, getPlatformShellToolName(platform), platform, options);
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
