import { constants } from "node:fs";
import { access as fsAccess, readdir as fsReaddir, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { relative as relativePath, resolve as resolvePath } from "node:path";
import { type AgentTool, createSilenceWatchdog } from "@caupulican/pi-agent-core";
import { Container, Text, truncateToWidth } from "@caupulican/pi-tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { withExclusiveMutationBarrier } from "./file-mutation-queue.ts";
import { classifyGitCommand, executeFilteredGit } from "./git-filter.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

/** Default silence bound for foreground commands without an explicit timeout (spec §2: ~10 min). */
const DEFAULT_COMMAND_SILENCE_MS = 600_000;
let commandSilenceMsOverride: number | undefined;

/** Test hook: override the silence threshold. Pass undefined to restore the default. */
export function setCommandSilenceMsForTests(ms: number | undefined): void {
	commandSilenceMsOverride = ms;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Timeout in seconds (optional). When set, this wall-clock limit replaces the default silence watchdog.",
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

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const { shell, args } = getShellConfig(options?.shellPath);
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}
			if (signal?.aborted) {
				throw new Error("aborted");
			}

			const child = spawn(shell, [...args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			// A command that keeps producing output must never be killed by this mechanism:
			// silence bounds mute-ness, not duration. It only arms when the caller left `timeout`
			// unset — an explicit timeout means the model took responsibility for the wall clock.
			let silenceKilled = false;
			const silenceMs = commandSilenceMsOverride ?? DEFAULT_COMMAND_SILENCE_MS;
			const silenceWatchdog =
				timeout === undefined && silenceMs > 0
					? createSilenceWatchdog({
							silenceMs,
							onSilence: () => {
								silenceKilled = true;
								if (child.pid) killProcessTree(child.pid);
							},
						})
					: undefined;
			const onChunk = (data: Buffer) => {
				silenceWatchdog?.touch();
				onData(data);
			};

			try {
				// Set timeout if provided.
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeout * 1000);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onChunk);
				child.stderr?.on("data", onChunk);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				if (silenceKilled) {
					throw new Error(`silence:${silenceMs / 1000}`);
				}
				return { exitCode };
			} finally {
				silenceWatchdog?.disarm();
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
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
	/** Custom operations for command execution. Default: local shell */
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

function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
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

async function tryOptimizeCommand(
	command: string,
	cwd: string,
): Promise<{ optimized: boolean; output?: string; exitCode?: number }> {
	if (process.env.PI_TOOL_OPTIMIZER_DISABLED === "1") {
		return { optimized: false };
	}

	const trimmed = command.trim();
	if (!trimmed) {
		return { optimized: false };
	}

	// Reject if there are shell operators or pipes/redirects
	const shellOperators = ["|", ">", "<", "&", ";", "\n", "\r", "$", "`", "(", ")", "*", "?", "[", "]"];
	if (shellOperators.some((op) => trimmed.includes(op))) {
		return { optimized: false };
	}

	// Simple tokenizer split by whitespace
	const args = trimmed.split(/\s+/);
	if (args.length === 0) {
		return { optimized: false };
	}

	const cmd = args[0];
	const unquote = (s: string) => {
		if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
			return s.slice(1, -1);
		}
		return s;
	};

	const resolveToCwd = (p: string, base: string) => {
		const clean = unquote(p);
		if (clean.startsWith("/")) return clean;
		return resolvePath(base, clean);
	};

	try {
		if (cmd === "cat") {
			if (args.length === 2 && !args[1].startsWith("-")) {
				const filePath = resolveToCwd(args[1], cwd);
				const content = await fsReadFile(filePath, "utf-8");
				return { optimized: true, output: content, exitCode: 0 };
			}
		} else if (cmd === "head") {
			if (args.length === 2 && !args[1].startsWith("-")) {
				const filePath = resolveToCwd(args[1], cwd);
				const content = await fsReadFile(filePath, "utf-8");
				const lines = content.split("\n").slice(0, 10).join("\n");
				return { optimized: true, output: lines, exitCode: 0 };
			} else if (args.length === 4 && args[1] === "-n" && !args[3].startsWith("-")) {
				const count = parseInt(args[2], 10);
				if (!Number.isNaN(count) && count >= 0) {
					const filePath = resolveToCwd(args[3], cwd);
					const content = await fsReadFile(filePath, "utf-8");
					const lines = content.split("\n").slice(0, count).join("\n");
					return { optimized: true, output: lines, exitCode: 0 };
				}
			}
		} else if (cmd === "tail") {
			if (args.length === 2 && !args[1].startsWith("-")) {
				const filePath = resolveToCwd(args[1], cwd);
				const content = await fsReadFile(filePath, "utf-8");
				const allLines = content.split("\n");
				const lines = allLines.slice(Math.max(0, allLines.length - 10)).join("\n");
				return { optimized: true, output: lines, exitCode: 0 };
			} else if (args.length === 4 && args[1] === "-n" && !args[3].startsWith("-")) {
				const count = parseInt(args[2], 10);
				if (!Number.isNaN(count) && count >= 0) {
					const filePath = resolveToCwd(args[3], cwd);
					const content = await fsReadFile(filePath, "utf-8");
					const allLines = content.split("\n");
					const lines = allLines.slice(Math.max(0, allLines.length - count)).join("\n");
					return { optimized: true, output: lines, exitCode: 0 };
				}
			}
		} else if (cmd === "ls") {
			if (args.length === 1 || (args.length === 2 && !args[1].startsWith("-"))) {
				const targetDir = args.length === 2 ? resolveToCwd(args[1], cwd) : cwd;
				const entries = await fsReaddir(targetDir);
				entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
				const results: string[] = [];
				for (const entry of entries) {
					let suffix = "";
					try {
						const entryStat = await fsStat(resolvePath(targetDir, entry));
						if (entryStat.isDirectory()) suffix = "/";
					} catch {}
					results.push(entry + suffix);
				}
				return { optimized: true, output: results.join("\n"), exitCode: 0 };
			}
		} else if (cmd === "grep" || cmd === "rg") {
			if (args.length === 3 && !args[1].startsWith("-") && !args[2].startsWith("-")) {
				const patternStr = unquote(args[1]);
				const filePath = resolveToCwd(args[2], cwd);
				const content = await fsReadFile(filePath, "utf-8");
				const lines = content.split("\n");
				const matches: string[] = [];
				for (let i = 0; i < lines.length; i++) {
					if (lines[i].includes(patternStr)) {
						matches.push(lines[i]);
					}
				}
				return { optimized: true, output: matches.join("\n"), exitCode: matches.length > 0 ? 0 : 1 };
			}
		} else if (cmd === "find") {
			if (args.length === 1 || (args.length === 2 && !args[1].startsWith("-"))) {
				const searchPath = args.length === 2 ? resolveToCwd(args[1], cwd) : cwd;
				const walk = async (dir: string): Promise<string[]> => {
					let results: string[] = [];
					const entries = await fsReaddir(dir);
					for (const entry of entries) {
						const full = resolvePath(dir, entry);
						const entryStat = await fsStat(full);
						if (entryStat.isDirectory()) {
							results.push(full);
							results = results.concat(await walk(full));
						} else {
							results.push(full);
						}
					}
					return results;
				};
				const all = (await walk(searchPath)).map((p) => relativePath(searchPath, p).replace(/\\/g, "/"));
				return { optimized: true, output: all.join("\n"), exitCode: 0 };
			}
		}
	} catch {
		return { optimized: false };
	}

	return { optimized: false };
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	const canOptimizeCommand = !options?.operations && !options?.shellPath && !commandPrefix && !spawnHook;
	const canFilterCommand = canOptimizeCommand;
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. Without an explicit timeout, the command is killed after ${DEFAULT_COMMAND_SILENCE_MS / 1000}s of continuous silence (no stdout/stderr output) rather than being bounded by total runtime; commands that keep producing output are never killed by this. Provide an explicit timeout to replace the silence watchdog with a wall-clock limit, or background long, quiet work with '&'.`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
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

			try {
				if (canFilterCommand) {
					const classification = classifyGitCommand(command, spawnContext.env);
					if (classification.eligible && classification.subcommand) {
						const res = await executeFilteredGit(
							cwd,
							classification.subcommand,
							classification.globalOptions || [],
							classification.subcommandArgs || [],
							{ signal, timeout },
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

				if (canOptimizeCommand) {
					const optResult = await tryOptimizeCommand(command, cwd);
					if (optResult.optimized) {
						output.append(Buffer.from(optResult.output ?? "", "utf-8"));
						const snapshot = await finishOutput();
						const { text: outputText, details } = formatOutput(snapshot);
						if (optResult.exitCode !== 0 && optResult.exitCode !== undefined) {
							throw new Error(appendStatus(outputText, `Command exited with code ${optResult.exitCode}`));
						}
						return { content: [{ type: "text", text: outputText }], details };
					}
				}

				let exitCode: number | null;
				try {
					// Bash cannot statically declare which files a command mutates, so the
					// actual shell execution takes the coarse exclusive barrier: it waits for
					// in-flight edit/write mutations to drain and blocks new ones meanwhile.
					const result = await withExclusiveMutationBarrier(() =>
						ops.exec(spawnContext.command, spawnContext.cwd, {
							onData: handleData,
							signal,
							timeout,
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
						throw new Error(
							appendStatus(
								text,
								`Command killed after ${secs}s of silence (no output). If the command is legitimately quiet for long stretches, re-run it with an explicit timeout, or run it in the background with '&'.`,
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
			text.setText(formatBashCall(args));
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

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
