import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { type AgentTool, createSilenceWatchdog } from "@caupulican/pi-agent-core";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
} from "@caupulican/pi-agent-core/node";
import { Container, Text, truncateToWidth } from "@caupulican/pi-tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import {
	getPlatformShellToolName,
	getShellConfig,
	getShellEnv,
	type PlatformShellToolName,
	prefixPowerShellCommand,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { withExclusiveMutationBarrier } from "./file-mutation-queue.ts";
import { classifyGitCommand, executeFilteredGit } from "./git-filter.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { routeShellContract } from "./shell-contract-router.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

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
			description: `Wall-clock timeout in seconds. Defaults to ${DEFAULT_COMMAND_TIMEOUT_SECONDS}; positive overrides are capped at ${MAX_COMMAND_TIMEOUT_SECONDS}. Zero or negative values use the default.`,
		}),
	),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	fullOutputError?: string;
	preview?: {
		content: string;
		skippedLines: number;
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
	 * @returns Promise resolving to exit code (null if killed)
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
	) => Promise<{ exitCode: number | null }>;
}

function createLocalShellOperations(
	shellName: PlatformShellToolName,
	options?: { shellPath?: string },
): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const { shell, args } = getShellConfig(options?.shellPath, shellName);
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}
			if (signal?.aborted) throw new Error("aborted");

			const child = spawn(shell, [...args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
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
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalShellOperations("bash", options);
}

/** Create PowerShell operations using pi's built-in local execution backend. */
export function createLocalPowerShellOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalShellOperations("powershell", options);
}

/** Create the platform shell backend without requiring callers or the model to choose a shell. */
export function createLocalPlatformShellOperations(
	options: { shellPath?: string; commandPrefix?: string; operations?: BashOperations } = {},
	platform: NodeJS.Platform = process.platform,
): BashOperations {
	const operations =
		options.operations ??
		createLocalShellOperations(getPlatformShellToolName(platform), { shellPath: options.shellPath });
	return {
		async exec(command, cwd, execOptions) {
			let resolvedCommand = command;
			if (platform === "win32") {
				const route = routeShellContract(command, platform);
				if (route.kind === "unsupported") throw new Error(route.error);
				if (route.kind === "powershell") resolvedCommand = route.command;
			}
			if (options.commandPrefix) resolvedCommand = `${options.commandPrefix}\n${resolvedCommand}`;
			if (platform === "win32") resolvedCommand = prefixPowerShellCommand(resolvedCommand);
			return operations.exec(resolvedCommand, cwd, execOptions);
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Platform used to choose the default backend and contract router. Defaults to process.platform. */
	platform?: NodeJS.Platform;
	/** Custom operations for command execution. Default: local platform shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 5;
const BASH_PREVIEW_BYTES = 8 * 1024;
const BASH_UPDATE_THROTTLE_MS = 100;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

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

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
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
	startedAt: number | undefined,
	endedAt: number | undefined,
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
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

function createShellToolDefinition(
	cwd: string,
	backendShell: PlatformShellToolName,
	contractPlatform: NodeJS.Platform,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const toolName = "bash";
	const ops =
		options?.operations ??
		(backendShell === "powershell"
			? createLocalPowerShellOperations({ shellPath: options?.shellPath })
			: createLocalBashOperations({ shellPath: options?.shellPath }));
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	const hasExecutionOverrides = Boolean(options?.operations || options?.shellPath || commandPrefix || spawnHook);
	const canFilterCommand = !hasExecutionOverrides;
	const routesWindowsContract = contractPlatform === "win32";
	const contractDescription = routesWindowsContract
		? "Execute Pi's stable Bash-like command contract in the current working directory. On Windows, a finite deterministic router converts supported simple commands to PowerShell; unsupported Bash constructs fail closed instead of being guessed."
		: "Execute a Bash command in the current working directory.";
	return {
		name: toolName,
		label: toolName,
		description: `${contractDescription} Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Commands have a ${DEFAULT_COMMAND_TIMEOUT_SECONDS}-second wall-clock default, including commands that keep producing output; use a positive timeout only when a scoped operation justifies a larger bound (maximum ${MAX_COMMAND_TIMEOUT_SECONDS} seconds).`,
		promptSnippet: routesWindowsContract
			? "Execute simple Bash-like commands; Pi routes supported forms deterministically to PowerShell on Windows"
			: "Execute Bash commands (ls, grep, find, etc.)",
		promptGuidelines: routesWindowsContract
			? [
					"Use the bash tool's portable simple-command contract on Windows; do not write PowerShell or ask the user to choose a shell.",
					"Use one simple command per call. The deterministic router rejects pipelines, redirection, expansion, shell chaining, nested shells, and unsupported Bash forms; use dedicated read/edit/search tools or separate calls instead.",
					"Supported Bash-like file commands are converted with literal-path PowerShell operations; verify targets before recursive rm, cp, or mv calls.",
					"Keep searches scoped and purpose-driven: discover paths first, pass an explicit root and filters, prefer rg over broad find, and increase the timeout only for a justified bounded search.",
				]
			: [
					"Keep searches scoped and purpose-driven: discover paths first, pass an explicit root and filters, prefer rg over broad find, and increase the timeout only for a justified bounded search.",
				],
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			const output = new OutputAccumulator({ tempFilePrefix: `pi-${toolName}` });
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
				const preview = {
					content: snapshot.content,
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
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				return output.snapshot({ persistIfTruncated: true });
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				const preview = output.preview(BASH_PREVIEW_LINES, BASH_PREVIEW_BYTES);
				const fullOutputNotice = snapshot.fullOutputPath
					? `Full output: ${snapshot.fullOutputPath}`
					: snapshot.fullOutputError
						? `Full output unavailable: ${snapshot.fullOutputError}`
						: "Full output unavailable";
				if (truncation.truncated || preview.skippedLines > 0) {
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
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). ${fullOutputNotice}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. ${fullOutputNotice}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). ${fullOutputNotice}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
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
								throw new Error(appendStatus(rawOutputText, `Command exited with code ${res.exitCode}`));
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
				if (routesWindowsContract) {
					const route = routeShellContract(command, contractPlatform);
					if (route.kind === "unsupported") throw new Error(route.error);
					backendCommand = route.command;
				}
				const commandWithPrefix = commandPrefix ? `${commandPrefix}\n${backendCommand}` : backendCommand;
				const resolvedCommand =
					backendShell === "powershell" ? prefixPowerShellCommand(commandWithPrefix) : commandWithPrefix;
				const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);

				let exitCode: number | null;
				try {
					// Shell commands cannot statically declare which files they mutate, so the
					// actual execution takes the coarse exclusive barrier: it waits for
					// in-flight edit/write mutations to drain and blocks new ones meanwhile.
					const result = await withExclusiveMutationBarrier(() =>
						ops.exec(spawnContext.command, spawnContext.cwd, {
							onData: handleData,
							signal,
							timeout: effectiveTimeoutSeconds,
							env: spawnContext.env,
						}),
					);
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
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

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				clearUpdateTimer();
				await output.closeTempFile();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args, toolName));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const platform = options?.platform ?? process.platform;
	return createShellToolDefinition(cwd, getPlatformShellToolName(platform), platform, options);
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
