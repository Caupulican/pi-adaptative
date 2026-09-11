import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { Agent } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { ExecutionPathFlavor } from "@caupulican/pi-agent-core/paths";
import { createSilenceWatchdog } from "@caupulican/pi-agent-core/reliability";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
} from "@caupulican/pi-agent-core/truncate";
import { type AgentTool, AgentToolExecutionError } from "@caupulican/pi-agent-core/types";
import {
	MAX_VERIFICATION_ID_LENGTH,
	VERIFICATION_ID_PATTERN,
	type VerificationRecord,
} from "@caupulican/pi-agent-core/verification-obligations";
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
	missingWorkingDirectoryMessage,
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
import { releaseExclusiveHold, withExclusiveMutationBarrier } from "./file-mutation-queue.ts";
import { applyGitTailStage, classifyGitCommand, executeFilteredGit } from "./git-filter.ts";
import { prepareManagedShellEnvironment } from "./managed-shell-preparation.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import {
	createReductionProjector,
	formatOutputReductionNotice,
	type OutputReductionDetails,
	type OutputReductionToolOptions,
	type ReduceToolOutputOptions,
	resolveOutputReductionLevel,
} from "./output-reduction.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import {
	assessShellSearchScope,
	BROAD_SEARCH_OUTPUT_ROUTE,
	expectedContentSearchNoMatch,
} from "./search-command-guard.ts";
import { tokenizeShellCommand } from "./shell-command-parser.ts";
import { routeShellContract, type ShellContractRoute } from "./shell-contract-router.ts";
import "./output-reducers.ts";
import { getAgentDir } from "../../config.ts";
import { BUNDLED_OUTPUT_RULES } from "./output-rules.bundled.ts";
import { createRuleOutputReducer, loadOutputRules } from "./output-rules.ts";
import { acquireShellSessionLanes } from "./shell-lane-pool.ts";
import {
	createShellOutputProjector,
	type ShellOutputProjection,
	type ShellOutputProjectionDetails,
	type ShellOutputProjectorLike,
} from "./shell-output-projection.ts";
import { acquirePersistentShellSession } from "./shell-session.ts";
import { classifyShellVerificationCommand } from "./shell-test-command.ts";
import { TestVerificationOutput } from "./test-verification-output.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	createWindowsShellEngineOperations,
	type WindowsShellEngineOptions,
	WindowsShellEngineUnavailableError,
} from "./windows-shell-engine.ts";
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
	repairOf: Type.Optional(
		Type.String({
			maxLength: MAX_VERIFICATION_ID_LENGTH,
			pattern: VERIFICATION_ID_PATTERN.source,
			description:
				"Active verification id whose empty-test setup error this corrected invocation repairs. The host requires matching test arguments within this workspace and an executed pass; actual test failures cannot be replaced this way.",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			maximum: MAX_COMMAND_TIMEOUT_SECONDS,
			description: `Wall-clock timeout in SECONDS, not milliseconds. Defaults to ${DEFAULT_COMMAND_TIMEOUT_SECONDS}; positive overrides are capped at ${MAX_COMMAND_TIMEOUT_SECONDS}. Zero or negative values use the default.`,
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run as a session task at once and return its task id instead of waiting. It runs in its own shell started from the session's current directory (its cd and exports do not persist), waits only for file writes emitted before it in this message, and never blocks other commands. Use only when you will do other work before you need the result; a background start followed immediately by tool_task wait costs an extra request and is slower than a foreground call with a timeout. Its result arrives in the completion wake-up; tool_task wait is only for an omitted output (needs the tool_task tool; without it the command runs in the foreground). Omit to wait for the command (default, bounded by timeout).",
		}),
	),
	broadSearch: Type.Optional(
		Type.Literal(BROAD_SEARCH_OUTPUT_ROUTE, {
			description:
				"Explicit override for a broad rg/grep/find/fd scan that cannot be narrowed. The command runs, but its complete output is routed to a file and excluded from model context.",
		}),
	),
	fullOutput: Type.Optional(
		Type.Boolean({
			description:
				"Return the complete raw output for this call: no output filters (test projection, family reducers, generic cleaning). Use only when the filtered notice says lines were omitted and you need them verbatim; the persisted full output named in the notice is usually enough.",
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
	/** Present when a family reducer produced the text; `rawPath` names the persisted raw output. */
	outputReduction?: OutputReductionDetails;
	piVerification?: VerificationRecord;
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
	 * the shell-reported working directory after the command ran. Stateful adapters must include
	 * initialCwd (explicitly undefined when unavailable); other adapters execute in the supplied cwd.
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
			/** Host-owned directory pin; stateful backends must re-enter cwd under their execution lock. */
			forceCwd?: boolean;
			/**
			 * Run outside the agent's persistent shell session: the command starts in `cwd` with `env`,
			 * its cd and exports do not persist, and it never queues behind or blocks other commands.
			 */
			detached?: boolean;
		},
	) => Promise<{ exitCode: number | null; cwd?: string; initialCwd?: string }>;
}

function createLocalShellOperations(
	shellName: PlatformShellToolName,
	options?: { shellPath?: string; sessionKey?: string },
): BashOperations {
	// A session key selects the persistent per-agent backend. An explicit custom shell path keeps
	// per-command spawning: persistent sessions assume the resolved platform shell's flag set.
	const sessionKey = options?.sessionKey;
	// The per-command spawn. It is the whole backend without a session key, and it is also where a
	// detached call runs on a session-keyed backend: one spawn implementation, never a second copy.
	const execOnce: BashOperations["exec"] = async (command, cwd, { onData, signal, timeout, env }) => {
		const { shell, args } = getShellConfig(options?.shellPath, shellName);
		try {
			await fsAccess(cwd, constants.F_OK);
		} catch {
			throw new Error(missingWorkingDirectoryMessage(cwd, shellName));
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
			return { exitCode: terminal.code, initialCwd: cwd };
		} finally {
			silenceWatchdog?.disarm();
			if (child.pid) untrackDetachedChildPid(child.pid);
			if (signal) signal.removeEventListener("abort", onAbort);
		}
	};
	if (sessionKey !== undefined && !options?.shellPath) {
		// The POSIX bash session reports and owns its own working directory, so the lane pool is the
		// cwd authority for it and shares that directory across lanes. A PowerShell session's
		// directory belongs to WindowsShellState, which the Windows tier resolves before the call:
		// substituting the pool's directory there would fight that authority.
		const poolOwnsCwd = shellName === "bash";
		return {
			exec: async (command, cwd, execOptions) => {
				const { onData, signal, timeout, env, forceCwd, detached } = execOptions;
				// Checked before a lane is touched at all: a detached command must never take a lane,
				// not even to be skipped.
				if (detached === true) return execOnce(command, cwd, execOptions);
				try {
					await fsAccess(cwd, constants.F_OK);
				} catch {
					throw new Error(missingWorkingDirectoryMessage(cwd, shellName));
				}
				if (signal?.aborted) throw new Error("aborted");
				const lanes = acquireShellSessionLanes(sessionKey);
				// Every lane starts each command where the pool is standing. A lane whose last request
				// was somewhere else re-enters that directory, exactly as the single session did when a
				// host-pinned directory differed from its last request.
				const laneCwd = poolOwnsCwd && forceCwd !== true ? (lanes.currentCwd ?? cwd) : cwd;
				const silenceMs = commandSilenceMsOverride ?? DEFAULT_COMMAND_SILENCE_MS;
				const hasWallClock = timeout !== undefined && timeout > 0;
				const laneKey = await lanes.pool.acquire(signal);
				try {
					const result = await acquirePersistentShellSession(laneKey, shellName).exec(command, laneCwd, {
						onData,
						signal,
						env,
						forceCwd,
						timeoutSeconds: hasWallClock ? timeout : undefined,
						silenceMs: !hasWallClock && silenceMs > 0 ? silenceMs : undefined,
						// Exports are the session's, not the lane's: the lane applies what other lanes
						// exported since its last command and contributes what this command changes.
						exportLedger: lanes.exports,
					});
					// Last completion wins: the directory the shell reports is where the whole pool
					// stands from now on.
					if (poolOwnsCwd && result.cwd) lanes.currentCwd = result.cwd;
					return result;
				} finally {
					lanes.pool.release(laneKey);
				}
			},
		};
	}
	return { exec: execOnce };
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
/**
 * The engine could not run this call. When the runtime is unavailable, a command the simple-command
 * PowerShell floor can express runs there; a command that needs the engine fails with the runtime
 * outage AND the floor's own named refusal, so the reader knows both what broke and what would work.
 * Any other engine error is the command's real outcome and is rethrown untouched.
 */
function floorRouteAfterEngineOutage(
	command: string,
	platform: NodeJS.Platform,
	error: unknown,
): Extract<ShellContractRoute, { kind: "powershell" }> {
	if (!(error instanceof WindowsShellEngineUnavailableError)) throw error;
	const floor = routeShellContract(command, platform, { pythonEngine: false });
	if (floor.kind !== "powershell") {
		const refusal = floor.kind === "unsupported" ? floor.error : `The floor does not route ${floor.kind} commands.`;
		throw new Error(`${error.message} This command needs the engine: ${refusal}`);
	}
	return floor;
}

export function createLocalPlatformShellOperations(
	options: {
		shellPath?: string;
		commandPrefix?: string;
		/**
		 * A caller-owned backend (an extension's `user_bash` operations, a remote executor). On
		 * Windows it receives the simple-command floor contract and the local engine never runs:
		 * the engine executes on this machine, which is exactly what a custom backend replaces.
		 */
		operations?: BashOperations;
		/** Test/embedding hook: the PowerShell-tier backend used beside the engine (engine stays on). */
		floorOperations?: BashOperations;
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
		options.floorOperations ??
		createLocalShellOperations(getPlatformShellToolName(platform), {
			shellPath: options.shellPath,
			sessionKey: options.sessionKey,
		});
	const pythonEngineEnabled = options.pythonEngine !== false && options.operations === undefined;
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
				let route = routeShellContract(command, platform, { pythonEngine: pythonEngineEnabled });
				if (route.kind === "unsupported") throw new Error(route.error);
				// The engine is the sole state mutator (D4); the floor (engine off, or the engine's
				// runtime unavailable) reads the SAME session state so a `cd`/`export` the engine
				// made is observed by the very next floor call.
				const state = getOrCreateWindowsShellState(engineSessionKey);
				resolvedCwd = resolveEffectiveCwd(state, cwd, execOptions.forceCwd);
				resolvedExecOptions = { ...execOptions, env: mergeEffectiveEnv(state, execOptions.env ?? getShellEnv()) };
				if (route.kind === "python-engine") {
					try {
						// The engine owns the state transition and resolves the original host cwd
						// exactly once. Passing the already state-adjusted cwd here would make the
						// engine mistake its own `cd` result for a host cwd change on the next call.
						// The operator's commandPrefix is bash grammar here, prepended to the source.
						const engineCommand = options.commandPrefix
							? `${options.commandPrefix}\n${route.command}`
							: route.command;
						return await engineOperations.exec(engineCommand, cwd, execOptions);
					} catch (error) {
						route = floorRouteAfterEngineOutage(command, platform, error);
					}
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

/** Single-quote one argument for the Bash-like contract (the only quoting every tier accepts). */
function shellQuoteArgument(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The last non-empty line a probe printed, trimmed of the line ending the shell added. Undefined
 * when the probe printed nothing at all: a missing answer must stay missing, never be guessed.
 */
function lastPrintedLine(output: string): string | undefined {
	const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
	return lines.length > 0 ? lines[lines.length - 1].trim() : undefined;
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
	/** Backend path syntax; defaults to the selected platform contract, never inferred from a path. */
	pathFlavor?: ExecutionPathFlavor;
	/** Platform used to choose the default backend and contract router. Defaults to process.platform. */
	platform?: NodeJS.Platform;
	/**
	 * Custom operations for command execution (a caller-owned backend). Default: local platform
	 * shell. On Windows a custom backend receives the simple-command floor contract and the local
	 * engine never runs, since the engine executes on this machine.
	 */
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
	/**
	 * Session identity for the shared group lock and the emission-order announcements
	 * (see file-mutation-queue.ts). This is deliberately NOT `sessionKey`: a task-directory
	 * invocation rebinds `sessionKey` to its own shell lane, while the lock and the announcements it
	 * is ordered against belong to the AGENT SESSION. Omitted keeps the process-wide default scope.
	 */
	mutationScope?: string;
	/** Host-owned task pin. Each invocation starts in cwd; command-local cd remains available. */
	forceCwd?: boolean;
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
	/** Output reduction switches (settings `toolOutput`); reduction is on at the standard level by default. */
	outputReduction?: OutputReductionToolOptions;
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
	const mutationScope = options?.mutationScope;
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
	// Family filters (the git filter) spawn the tool directly instead of going through the shell, so
	// they need the real shell backend (no custom operations) and a command the shell would have run
	// verbatim (no prefix). A spawn hook that only adjusts env or cwd keeps them on: its result is
	// checked per call, and a hook that rewrites the command text turns them off for that call. The
	// output-only stages (test projection, verification classification) never depend on this.
	const familyFiltersAllowed = options?.operations === undefined && !commandPrefix;
	// Output reduction: on unless the operator turned it off (settings or PI_TOOL_FILTER_DISABLED=1).
	// Rules are loaded once per tool instance: bundled, then the user file, then the project file.
	const reductionEnabled = options?.outputReduction?.enabled !== false && process.env.PI_TOOL_FILTER_DISABLED !== "1";
	const reductionLevel = () => resolveOutputReductionLevel(options?.outputReduction?.level);
	const reductionOptions: ReduceToolOutputOptions | undefined = reductionEnabled
		? {
				extraReducers: [
					createRuleOutputReducer(
						loadOutputRules({
							cwd,
							agentDir: options?.outputReduction?.agentDir ?? getAgentDir(),
							extraFiles: options?.outputReduction?.rulesFiles,
							bundled: BUNDLED_OUTPUT_RULES,
						}),
					),
				],
			}
		: undefined;
	// Where the POSIX lane pool is standing ($PWD after the last command that reported one): a
	// filtered run must happen where the shell is, not where the tool was created. The pool owns it
	// so every lane and every tool instance on this session key sees the same directory.
	const sessionLanes = acquireShellSessionLanes(sessionKey);
	const routesWindowsContract = contractPlatform === "win32";
	const pathFlavor = options?.pathFlavor ?? (routesWindowsContract ? "win32" : "posix");
	const pythonEngineEnabled = options?.windowsShellPythonEngine !== false && options?.operations === undefined;
	const engineOperations = routesWindowsContract
		? createWindowsShellEngineOperations(sessionKey, options?.windowsShellEngineOptions)
		: undefined;
	// Warm the tier that will actually run commands. With the engine on it is the engine (every
	// Windows bash call routes there, and its Python coordinator would otherwise start on the
	// user's first command); with the engine off it is the PowerShell floor, as before.
	if (
		options?.prewarmWindowsShell === true &&
		process.platform === "win32" &&
		routesWindowsContract &&
		options.operations === undefined
	) {
		if (pythonEngineEnabled && engineOperations) {
			setImmediate(() => {
				const context = resolveSpawnContext("", cwd, spawnHook, options?.getShellSessionContext);
				void engineOperations.prewarm(context.env);
			});
		} else if (backendShell === "powershell" && options.shellPath === undefined) {
			setImmediate(() => {
				const context = resolveSpawnContext("", cwd, spawnHook, options?.getShellSessionContext);
				context.env = mergeEffectiveEnv(getOrCreateWindowsShellState(sessionKey), context.env);
				// Warm the lane every sequential command lands on, through the pool: a session warmed
				// outside it would be a shell nobody runs on and nobody disposes.
				void sessionLanes.pool
					.acquire()
					.then(async (laneKey) => {
						try {
							await acquirePersistentShellSession(laneKey, backendShell).prewarm(context.cwd, context.env);
						} finally {
							sessionLanes.pool.release(laneKey);
						}
					})
					.catch(() => {
						// The first real command retries and surfaces the complete candidate failure.
					});
			});
		}
	}
	const contractDescription = options?.forceCwd
		? "Execute a command in a persistent shell with a host-pinned working directory. Each invocation starts in the pinned directory; cd inside a command remains available and exported variables persist across calls. Commands issued together run concurrently on a pool of shells (three kept warm, more added on demand, idle extras retired); the working directory is shared across the pool, exported variables persist only within the lane that set them, so prefix later commands explicitly."
		: routesWindowsContract
			? "Execute Pi's stable Bash-like command contract in a persistent per-agent shell session (starts at the project working directory; current directory and environment variables persist across calls; a failed command reports its effective cwd on a final `cwd:` line). On Windows, every command runs through a bundled shell engine that implements the supported Bash grammar (loops, conditionals, functions, pipelines, redirection, expansion, chaining, cd/export/unset) and runs the real GNU coreutils/findutils/grep/sed/awk from Git for Windows when present, so Linux command habits work unchanged; named unsupported constructs (job control, process substitution, and similar) fail closed instead of being guessed. Commands issued together run concurrently on a pool of shells (three kept warm, more added on demand, idle extras retired); the working directory is shared across the pool, exported variables persist only within the lane that set them, so prefix later commands explicitly."
			: "Execute a Bash command in a persistent per-agent shell session that starts at the project working directory: `cd` and environment variables persist across calls, a failed command reports its effective cwd on a final `cwd:` line, and a timed-out or aborted command resets the session. Commands issued together run concurrently on a pool of shells (three kept warm, more added on demand, idle extras retired); the working directory is shared across the pool, exported variables persist only within the lane that set them, so prefix later commands explicitly.";
	return {
		name: toolName,
		label: toolName,
		description: `${contractDescription} Returns stdout and stderr. Output is truncated to a head+tail preview within ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a managed file. Recognized test runners return a bounded failure/summary projection when it is materially smaller, with exact output saved to a managed file. Search, compiler and large JSON output is reduced the same way (raw output persisted, one notice naming it); for JSON prefer a jq projection up front (e.g. | jq -c '.items[] | {id,status}') and query a persisted document with jq instead of reading it whole. Broad rg/grep/find/fd scans are rejected before execution; when an exhaustive scan is unavoidable, set broadSearch="${BROAD_SEARCH_OUTPUT_ROUTE}" to route all output to a managed file instead of model context. Commands have a ${DEFAULT_COMMAND_TIMEOUT_SECONDS}-second wall-clock default, including commands that keep producing output; use a positive timeout only when a scoped operation justifies a larger bound (maximum ${MAX_COMMAND_TIMEOUT_SECONDS} seconds).`,
		promptSnippet: routesWindowsContract
			? "Run Bash-like commands; Pi routes Windows."
			: "Execute Bash commands (ls, grep, find, etc.)",
		promptGuidelines: routesWindowsContract
			? [
					"On Windows, write ordinary Linux bash (GNU ls/find/grep/sed/awk flags, loops, functions, pipes); never write PowerShell or ask the owner to choose a shell.",
					"Unhandled syntax fails closed by name; cd/export/unset state persists across bash calls.",
					"File commands use literal paths; verify targets before recursive rm/cp/mv.",
					`Bash timeout values are seconds; omit to use the ${DEFAULT_COMMAND_TIMEOUT_SECONDS}s default.`,
					`Search narrowly: root/filters, prefer grep/find. A broad scan runs with its output routed to a managed file (as with broadSearch="${BROAD_SEARCH_OUTPUT_ROUTE}"); inspect it narrowly.`,
				]
			: [
					`Bash timeout values are seconds, not milliseconds; omit timeout to use the ${DEFAULT_COMMAND_TIMEOUT_SECONDS}s default.`,
					`Search narrowly: root/filters, prefer grep/find. A broad scan runs with its output routed to a managed file (as with broadSearch="${BROAD_SEARCH_OUTPUT_ROUTE}"); inspect it narrowly.`,
				],
		parameters: bashSchema,
		backgroundRequested: (input) => input.background === true,
		failureRecovery: {
			getFailureTargets: (params, failure) =>
				failureRecoveryAuthority &&
				/^exit_-?[1-9]\d*$/.test(failure.failureCode) &&
				!isAdHocInterpreterProbe(typeof params.command === "string" ? params.command : "")
					? [workspaceRecoveryTarget(failureRecoveryAuthority, WORKSPACE_MUTATED_RECOVERY_TARGET_KIND, cwd)]
					: [],
		},
		async execute(
			toolCallId,
			{ command, timeout, broadSearch, fullOutput, repairOf, background }: BashToolInput,
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
			// Output-only stages: the test projector for recognized runners, otherwise the reduction
			// pipeline (generic cleaning, then a family or rule reducer) streaming over the same seam.
			// Neither depends on how the command is executed. The model's `fullOutput` and the operator's
			// `toolOutput.reduction: "off"` (or PI_TOOL_FILTER_DISABLED=1) skip both for the call.
			let outputProjector: ShellOutputProjectorLike | undefined =
				routeBroadSearchOutput || fullOutput === true || !reductionEnabled
					? undefined
					: (createShellOutputProjector(command) ??
						createReductionProjector(toolName, command, reductionLevel(), reductionOptions));
			const output = new OutputAccumulator({
				tempFilePrefix: `pi-${toolName}`,
				tempDirectory: options?.outputDirectory,
				persistAllOutput: routeBroadSearchOutput,
				maxPersistedBytes: routeBroadSearchOutput ? BROAD_SEARCH_MAX_PERSISTED_BYTES : undefined,
				windowsCompatibleEncoding: routesWindowsContract,
			});
			const verificationRunners = classifyShellVerificationCommand(command, { cwd, flavor: pathFlavor })?.runners;
			const verificationOutput = verificationRunners ? new TestVerificationOutput(verificationRunners) : undefined;
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
				verificationOutput?.append(data);
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
					if (projection.kind === "reduction" && projection.reduction) {
						const reduction = {
							...projection.reduction,
							...(projection.persistRaw ? { rawPath: snapshot.fullOutputPath } : {}),
						};
						details = { ...details, outputReduction: reduction };
						const notice = formatOutputReductionNotice(reduction);
						if (notice) text += `\n\n${notice}`;
					} else {
						const passingNotice =
							projection.collapsedPassingLines > 0
								? ` ${projection.collapsedPassingLines} passing/progress lines collapsed.`
								: "";
						text += `\n\n[Test output filtered: retained ${projection.inputLines - projection.omittedLines} of ${projection.inputLines} lines.${passingNotice} ${fullOutputNotice}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
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

			// One execution path for the shell: routing on the Windows contract, the operator's command
			// prefix, the spawn hook, the session env, the mutation barrier. The main command and the
			// `cd` a filtered git run replays into the session both go through it.
			const runInSession = async (
				source: string,
				onData: (data: Buffer) => void,
				execution?: { detached?: boolean; floorCommand?: string },
			): Promise<{
				exitCode: number | null;
				cwd?: string;
				spawnCwd: string;
				initialCwd?: string;
				verificationCommand?: string;
			}> => {
				const detached = execution?.detached === true;
				let backendCommand = source;
				let engineRoute = false;
				let effectiveCwd = cwd;
				if (!routesWindowsContract && detached && !options?.forceCwd) {
					// A detached command starts where the session is standing, not at the project root: it
					// is the shell the agent is in, minus the shared session. The Windows contract reads
					// the same current directory out of the session state below.
					effectiveCwd = sessionLanes.currentCwd ?? cwd;
				}
				if (routesWindowsContract) {
					const route = routeShellContract(source, contractPlatform, { pythonEngine: pythonEngineEnabled });
					// `floorCommand` is the tool's own spelling of this program in the floor's grammar.
					// The router translates MODEL-authored Bash for the floor and refuses what it cannot
					// express there; a program the tool wrote itself needs no translation and its
					// refusal is not the router's to give. The engine speaks Bash, so it keeps `source`.
					engineRoute = route.kind === "python-engine";
					if (route.kind === "unsupported") {
						if (execution?.floorCommand === undefined) throw new Error(route.error);
						backendCommand = execution.floorCommand;
					} else if (engineRoute) {
						backendCommand = route.command;
					} else {
						backendCommand = execution?.floorCommand ?? route.command;
					}
					// The engine is the sole state mutator (D4); the floor (engine off, or the engine's
					// runtime unavailable) reads the SAME session state so a `cd`/`export` the engine
					// made is observed by the very next floor call.
					effectiveCwd = resolveEffectiveCwd(getOrCreateWindowsShellState(sessionKey), cwd, options?.forceCwd);
				}
				const prepareSpawn = async (backend: string) => {
					// The operator's commandPrefix runs where the command runs: in the engine it is bash
					// grammar prepended to the source; on the floor (engine off, or its runtime gone) it
					// is the PowerShell snippet it always was. Dropping it on one tier would silently
					// lose a configured setting.
					const resolvedCommand = commandPrefix ? `${commandPrefix}\n${backend}` : backend;
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
					return { resolvedCommand, spawnContext };
				};
				let prepared = await prepareSpawn(backendCommand);
				const execute = (engine: boolean, target: typeof prepared) =>
					(engine && engineOperations ? engineOperations : ops).exec(
						target.spawnContext.command,
						target.spawnContext.cwd,
						{
							onData,
							signal,
							timeout: effectiveTimeoutSeconds,
							env: target.spawnContext.env,
							forceCwd: options?.forceCwd,
							detached,
						},
					);
				const runCommand = async () => {
					if (!engineRoute) return execute(false, prepared);
					try {
						return await execute(true, prepared);
					} catch (error) {
						// The engine is gone. A tool-authored program already carries its floor spelling;
						// anything else is model text the router has to translate, and an error that is
						// not the engine's outage is the command's own outcome and is rethrown there.
						let floorCommand: string;
						if (execution?.floorCommand === undefined) {
							floorCommand = floorRouteAfterEngineOutage(source, contractPlatform, error).command;
						} else {
							if (!(error instanceof WindowsShellEngineUnavailableError)) throw error;
							floorCommand = execution.floorCommand;
						}
						engineRoute = false;
						prepared = await prepareSpawn(floorCommand);
						return execute(false, prepared);
					}
				};
				// Shell commands cannot statically declare which files they mutate, so the
				// actual execution takes the coarse exclusive barrier: it waits for
				// in-flight edit/write mutations to drain and blocks new ones meanwhile.
				//
				// A background call takes the same barrier and releases it the instant its own body starts:
				// it still runs after the writes its own message emitted before it, but nothing stays
				// parked behind it for the rest of its life. Holding it parked every sibling bash/python
				// behind a command nobody is waiting for (measured live: turns hung for up to 30 minutes).
				// `holdId` also lets a later handoff drop the barrier for a foreground command that
				// becomes a session task after it already started (see releaseExclusiveHold).
				const result = await withExclusiveMutationBarrier(
					async () => {
						if (background === true) releaseExclusiveHold(toolCallId, mutationScope);
						return runCommand();
					},
					{ signal, holdId: toolCallId, ...(mutationScope !== undefined ? { scope: mutationScope } : {}) },
				);
				const { resolvedCommand, spawnContext } = prepared;
				// The lane pool records the directory of every command it ran itself. A caller-supplied
				// backend is invisible to it, so the tool records that backend's report here instead -
				// and a detached command's cd never moved the session, so its report is not recorded
				// at all.
				if (options?.operations !== undefined && !routesWindowsContract && !detached && result.cwd) {
					sessionLanes.currentCwd = result.cwd;
				}
				return {
					exitCode: result.exitCode,
					cwd: result.cwd,
					spawnCwd: spawnContext.cwd,
					// Per-command adapters run in the supplied cwd. Stateful adapters report their
					// admission cwd explicitly; an unavailable report must not become a guessed cwd.
					initialCwd: "initialCwd" in result ? result.initialCwd : spawnContext.cwd,
					verificationCommand: spawnContext.command === resolvedCommand && !commandPrefix ? source : undefined,
				};
			};
			try {
				// Classify on the resolved spawn context: a hook may adjust env or cwd (filters stay on,
				// the filtered run receives that env) or rewrite the command (filters off for this call).
				const filterContext = familyFiltersAllowed
					? resolveSpawnContext(command, cwd, spawnHook, options?.getShellSessionContext)
					: undefined;
				if (filterContext && filterContext.command === command) {
					const classification = classifyGitCommand(command, filterContext.env);
					if (classification.eligible && classification.subcommand) {
						let gitCwd = options?.forceCwd
							? filterContext.cwd
							: routesWindowsContract
								? resolveEffectiveCwd(getOrCreateWindowsShellState(sessionKey), cwd)
								: (sessionLanes.currentCwd ?? filterContext.cwd);
						if (classification.cwdPrefix !== undefined) {
							// `cd <path> && git …`: the filtered git run is spawned directly (it never touches
							// the shell), so the directory the cd lands in has to come from the shell itself.
							const cdCommand = `cd ${shellQuoteArgument(classification.cwdPrefix)}`;
							const cdChunks: Buffer[] = [];
							const collectCd = (data: Buffer) => cdChunks.push(data);
							// The cd failed: that is the command's outcome, reported like any non-zero exit.
							const failedCd = async (exitCode: number | null, reportedCwd: string) => {
								for (const chunk of cdChunks) output.append(chunk);
								const snapshot = await finishOutput();
								const { text: cdText } = formatOutput(snapshot, "");
								return createExitError(cdText, exitCode ?? 1, reportedCwd);
							};
							if (background === true) {
								// A detached command runs in its own child shell and must leave the session
								// exactly where it stood, so the landing directory is observed rather than
								// entered: the probe runs through the same detached path the command itself
								// takes (starting from the pool's directory), and the absolute path it prints
								// is where the filtered git runs. No lane and no session directory move.
								//
								// Every tier gets the probe in its own grammar. The Bash contract (POSIX
								// shells, and the Windows engine, which speaks Bash) reads `cd … && pwd`; the
								// PowerShell floor has no `&&` to route, so it gets the PowerShell program
								// that answers the same question.
								const probe = await runInSession(`${cdCommand} && pwd`, collectCd, {
									detached: true,
									floorCommand: `Set-Location -LiteralPath '${classification.cwdPrefix.replaceAll("'", "''")}'; (Get-Location).Path`,
								});
								const printed = lastPrintedLine(Buffer.concat(cdChunks).toString("utf-8"));
								if (probe.exitCode !== 0) throw await failedCd(probe.exitCode, probe.spawnCwd);
								if (printed === undefined) {
									throw new Error(`The shell reported no working directory for '${cdCommand}'.`);
								}
								gitCwd = printed;
							} else {
								// A foreground `cd` is the shell's own state change: the session moves with it,
								// exactly as it would have without the filter, and the filtered run happens
								// where it landed.
								const moved = await runInSession(cdCommand, collectCd);
								const movedCwd = routesWindowsContract
									? resolveEffectiveCwd(getOrCreateWindowsShellState(sessionKey), cwd)
									: (moved.cwd ?? moved.spawnCwd);
								if (moved.exitCode !== 0) throw await failedCd(moved.exitCode, movedCwd);
								gitCwd = movedCwd;
							}
						}
						const res = await executeFilteredGit(
							gitCwd,
							classification.subcommand,
							classification.globalOptions || [],
							classification.subcommandArgs || [],
							{ signal, timeout: effectiveTimeoutSeconds, environment: filterContext.env },
						);
						if (res.exitCode !== -100) {
							output.append(res.rawBytes ?? Buffer.from(res.rawOut, "utf-8"));
							const snapshot = await finishOutput();
							if (res.exitCode !== 0) {
								const { text: rawOutputText } = formatOutput(snapshot);
								throw createExitError(rawOutputText, res.exitCode, gitCwd);
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
							return {
								content: [{ type: "text", text: applyGitTailStage(res.output, classification.tailStage) }],
								details,
							};
						}
					}
				}
				let exitCode: number | null;
				let sessionCwd: string | undefined;
				let spawnCwd = cwd;
				let initialCwd: string | undefined;
				let verificationCommand: string | undefined;
				try {
					const result = await runInSession(command, handleData, { detached: background === true });
					exitCode = result.exitCode;
					sessionCwd = result.cwd;
					spawnCwd = result.spawnCwd;
					initialCwd = result.initialCwd;
					verificationCommand = result.verificationCommand;
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
				// Test projections and lossy reductions persist the raw output for recovery; pure cleaning
				// (nothing omitted) has nothing to recover and writes no file.
				const persistRaw = candidateProjection !== undefined && candidateProjection.persistRaw !== false;
				const snapshot = await finishOutput(persistRaw);
				const projection =
					candidateProjection && (!persistRaw || snapshot.fullOutputPath) ? candidateProjection : undefined;
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
					: (sessionCwd ?? spawnCwd);
				const verification =
					initialCwd === undefined || verificationCommand === undefined
						? undefined
						: classifyShellVerificationCommand(verificationCommand, {
								cwd: initialCwd,
								workspaceRoot: cwd,
								flavor: pathFlavor,
							});
				// CDPATH and other shell state can redirect a syntactically simple cd. A reported
				// location must agree before the canonical identity can certify that project.
				const actualVerificationCwd = routesWindowsContract ? reportedCwd : sessionCwd;
				const verificationContextMatches =
					verification?.cwd === undefined ||
					actualVerificationCwd === undefined ||
					verification.cwd === actualVerificationCwd;
				const runnerOutcome =
					verification && verificationContextMatches && verificationOutput
						? verificationOutput.finish(exitCode)
						: undefined;
				const verificationDetails: BashToolDetails | undefined =
					verification && verificationContextMatches
						? {
								...details,
								piVerification: {
									version: 1,
									id: verification.id,
									...(runnerOutcome !== undefined && verificationOutput
										? {
												outcome: exitCode === null ? "unconfirmed" : verificationOutput.executionOutcome,
												evidence: verificationOutput.evidence,
											}
										: {}),
									...(verification.repairGroup !== undefined ? { repairGroup: verification.repairGroup } : {}),
									...(repairOf !== undefined ? { repairOf } : {}),
									// Display identity for the operator and the model; the id stays the identity.
									command: verification.display,
									...(verification.cwd !== undefined ? { cwd: verification.cwd } : {}),
									status:
										exitCode === 0 && (runnerOutcome === undefined || runnerOutcome === "passed")
											? "passed"
											: "failed",
								},
							}
						: details;
				if (exitCode === null) {
					return {
						content: [
							{
								type: "text",
								text: appendStatus(outputText, `Command terminated without an exit code\ncwd: ${reportedCwd}`),
							},
						],
						details: verificationDetails,
						isError: true,
						errorKind: "tool_failure",
					};
				}
				if (exitCode === 0 && runnerOutcome !== undefined && runnerOutcome !== "passed") {
					return {
						content: [
							{
								type: "text",
								text: appendStatus(
									outputText,
									`Verification is ${runnerOutcome}: exit zero did not confirm completed passing tests. Inspect the runner output and rerun the intended tests.`,
								),
							},
						],
						details: verificationDetails,
						isError: true,
						errorKind: "operation_outcome",
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
							details: verificationDetails,
							isError: true,
							errorKind: "operation_outcome",
						};
					}
					throw createExitError(outputText, exitCode, reportedCwd);
				}
				return {
					content: [{ type: "text", text: outputText }],
					details: verificationDetails,
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
