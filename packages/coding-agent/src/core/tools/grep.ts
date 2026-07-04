import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@caupulican/pi-agent-core";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateLine,
} from "@caupulican/pi-agent-core/node";
import { Text } from "@caupulican/pi-tui";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ArtifactStore } from "../context/context-artifacts.ts";
import {
	type BroadQueryTracker,
	broadQueryInvalidationNote,
	formatArtifactNotice,
	normalizeBroadQueryKey,
	packToolOutput,
} from "../context/tool-output-packer.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import {
	defaultFffSearchBackend,
	type FffGrepMatch,
	type FffGrepResult,
	type FffSearchBackend,
	hasGitignoreInTree,
	relativePathInside,
	safeGetFinder,
} from "./fff-search-backend.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { defaultSearchRouter, type SearchRouter } from "./search-router.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
	/** Set only when output was packed to an artifact; see tool-output-packer.ts. */
	artifactId?: string;
	/** Set when this exact query has repeatedly produced broad/truncated results. */
	invalidationCandidate?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	readFile: (p) => fsReadFile(p, "utf-8"),
};

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus routed FFF/rg search */
	operations?: GrepOperations;
	/** FFF backend for resident indexed search. Set false to force ripgrep fallback. */
	fff?: FffSearchBackend | false;
	/** Pure router that selects FFF or rg from request filters and environment facts. */
	searchRouter?: SearchRouter;
	/**
	 * Opt-in artifact store for first-capture-then-bound output packing (Phase 3). When
	 * omitted (the default), behavior is byte-for-byte unchanged from before this option
	 * existed: output is truncated the same way, just never artifact-backed.
	 */
	artifactStore?: ArtifactStore;
	/** Opt-in tracker for repeated-broad-query "do not repeat" signals. Also default-off. */
	broadQueryTracker?: BroadQueryTracker;
}

function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
	theme: Theme,
	cwd: string,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".", cwd) : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

function globConstraintForFff(glob: string | undefined): string {
	if (!glob) return "";
	if (glob.includes("/") || glob.startsWith("**/")) return glob;
	return `**/${glob}`;
}

function fffGrepQuery(options: {
	pattern: string;
	glob?: string;
	isDirectory: boolean;
	searchPathRelativeToCwd: string;
}): string | undefined {
	const parts: string[] = [];
	if (options.searchPathRelativeToCwd) {
		parts.push(options.isDirectory ? `${options.searchPathRelativeToCwd}/` : options.searchPathRelativeToCwd);
	}
	parts.push(globConstraintForFff(options.glob));
	parts.push(options.pattern);
	return parts.filter(Boolean).join(" ");
}

function fffDisplayPath(
	match: FffGrepMatch,
	options: { isDirectory: boolean; searchPathRelativeToCwd: string },
): string | undefined {
	if (!options.searchPathRelativeToCwd) return match.relativePath;
	if (!options.isDirectory) {
		return match.relativePath === options.searchPathRelativeToCwd ? path.basename(match.relativePath) : undefined;
	}
	const prefix = `${options.searchPathRelativeToCwd}/`;
	if (!match.relativePath.startsWith(prefix)) return undefined;
	return match.relativePath.slice(prefix.length);
}

function appendFffMatchLines(options: {
	match: FffGrepMatch;
	outputLines: string[];
	linesTruncated: { value: boolean };
	contextValue: number;
}): void {
	const before = options.match.contextBefore ?? [];
	for (let i = 0; i < before.length; i++) {
		const lineNumber = options.match.lineNumber - before.length + i;
		const { text, wasTruncated } = truncateLine(before[i] ?? "");
		if (wasTruncated) options.linesTruncated.value = true;
		options.outputLines.push(`  ${lineNumber}- ${text}`);
	}

	const { text, wasTruncated } = truncateLine(options.match.lineContent.replace(/\r/g, ""));
	if (wasTruncated) options.linesTruncated.value = true;
	options.outputLines.push(`  ${options.match.lineNumber}: ${text}`);

	if (options.contextValue === 0) return;
	const after = options.match.contextAfter ?? [];
	for (let i = 0; i < after.length; i++) {
		const lineNumber = options.match.lineNumber + 1 + i;
		const { text: contextText, wasTruncated: contextWasTruncated } = truncateLine(after[i] ?? "");
		if (contextWasTruncated) options.linesTruncated.value = true;
		options.outputLines.push(`  ${lineNumber}- ${contextText}`);
	}
}

/**
 * Shared "measure -> pack -> notices" tail for both the FFF and ripgrep result paths:
 * first-capture the raw output to an artifact if it's oversized and a store was provided
 * (Phase 3 tool-output-artifacts.md boundary rule), then append the same match-limit/
 * byte-limit/line-truncation/broad-query notices either path already produced.
 */
function packGrepOutput(options: {
	rawOutput: string;
	toolCallId: string;
	artifactStore?: ArtifactStore;
	broadQueryTracker?: BroadQueryTracker;
	pattern: string;
	rawPath?: string;
	glob?: string;
	matchLimitReached: number | false;
	linesTruncated: boolean;
}): { text: string; details: GrepToolDetails } {
	const packed = packToolOutput(
		{
			toolName: "grep",
			path: options.rawPath,
			rawContent: options.rawOutput,
			// No line limit here because the match limit already caps rows; only the byte
			// cap should apply, matching the pre-Slice-B truncateHead call exactly.
			truncation: { maxLines: Number.MAX_SAFE_INTEGER },
		},
		options.artifactStore,
		options.toolCallId,
	);
	let output = packed.content;
	const details: GrepToolDetails = {};

	const notices: string[] = [];
	if (packed.artifactId) {
		notices.push(formatArtifactNotice(packed.artifactId));
		details.artifactId = packed.artifactId;
	}
	if (options.matchLimitReached) {
		notices.push(
			`${options.matchLimitReached} matches limit reached. Use limit=${options.matchLimitReached * 2} for more, or refine pattern`,
		);
		details.matchLimitReached = options.matchLimitReached;
	}
	if (packed.truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		// Drop the duplicated bounded-preview text: it's already in the message's own
		// content, and re-including it here can push `details` past
		// MAX_RETAINED_TOOL_RESULT_DETAILS_BYTES (message-retention.ts), which replaces
		// the *entire* details object with a stub -- silently losing artifactId and every
		// other field alongside it. This is load-bearing beyond just the retention budget:
		// agent-session.ts's _releaseGcPackedArtifactReferences() reads artifactId back off
		// this same canonical message at eviction time (potentially many turns later), so
		// keeping `details` small here is what keeps that release path working at all. If
		// this field ever grows a large addition again, add a regression proving artifactId
		// survives compactToolResultDetailsForRetention (see
		// test/suite/agent-session-artifact-lifecycle.test.ts), not just a details-size check.
		details.truncation = { ...packed.truncation, content: "" };
	}
	if (options.linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		details.linesTruncated = true;
	}
	if (options.matchLimitReached || packed.truncation.truncated) {
		const note = broadQueryInvalidationNote(
			options.broadQueryTracker,
			normalizeBroadQueryKey({
				toolName: "grep",
				pattern: options.pattern,
				path: options.rawPath,
				glob: options.glob,
			}),
			`grep "${options.pattern}" in ${options.rawPath ?? "."}`,
		);
		if (note) {
			notices.push(note);
			details.invalidationCandidate = true;
		}
	}
	if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
	return { text: output, details };
}

function formatFffGrepResult(options: {
	result: FffGrepResult;
	isDirectory: boolean;
	searchPathRelativeToCwd: string;
	effectiveLimit: number;
	contextValue: number;
	toolCallId: string;
	artifactStore?: ArtifactStore;
	broadQueryTracker?: BroadQueryTracker;
	pattern: string;
	rawPath?: string;
	glob?: string;
}): { text: string; details: GrepToolDetails } {
	if (options.result.items.length === 0) return { text: "No matches found", details: {} };

	const outputLines: string[] = [];
	const linesTruncated = { value: false };
	let currentPath = "";
	for (const match of options.result.items) {
		const displayPath = fffDisplayPath(match, options);
		if (!displayPath) continue;
		if (displayPath !== currentPath) {
			currentPath = displayPath;
			outputLines.push(`${displayPath}:`);
		}
		appendFffMatchLines({
			match,
			outputLines,
			linesTruncated,
			contextValue: options.contextValue,
		});
	}

	if (outputLines.length === 0) return { text: "No matches found", details: {} };
	const rawOutput = outputLines.join("\n");
	return packGrepOutput({
		rawOutput,
		toolCallId: options.toolCallId,
		artifactStore: options.artifactStore,
		broadQueryTracker: options.broadQueryTracker,
		pattern: options.pattern,
		rawPath: options.rawPath,
		glob: options.glob,
		matchLimitReached: options.result.nextCursor ? options.effectiveLimit : false,
		linesTruncated: linesTruncated.value,
	});
}

export async function tryFffGrep(options: {
	backend: FffSearchBackend;
	router: SearchRouter;
	cwd: string;
	searchPath: string;
	pattern: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	contextValue: number;
	effectiveLimit: number;
	isDirectory: boolean;
	toolCallId: string;
	artifactStore?: ArtifactStore;
	broadQueryTracker?: BroadQueryTracker;
	rawPath?: string;
}): Promise<{ text: string; details: GrepToolDetails } | undefined> {
	// Kick off the FFF finder -- and, on a machine where fff-node isn't provisioned
	// yet, its lazy managed install -- unconditionally and as early as possible.
	// See the matching comment in find.ts's tryFffFind: routing below can still
	// send THIS call to the rg fallback for reasons unrelated to tool availability
	// (chiefly the default match limit exceeding the FFF top-N threshold), and
	// that outcome must not gate the install itself. getFinder() is cached per
	// basePath, so later calls -- including the `await` below -- reuse this same
	// in-flight/resolved promise instead of doing the work twice. safeGetFinder()
	// guarantees this can never reject (a non-conforming custom backend that
	// throws synchronously still degrades to "unavailable"), so it can neither
	// produce an unhandled rejection nor fail this tool call outright.
	const finderPromise = safeGetFinder(options.backend, options.cwd);

	const searchPathRelativeToCwd = relativePathInside(options.cwd, options.searchPath);
	const baseRoute = options.router.route({
		tool: "grep",
		glob: Boolean(options.glob),
		ignoreCase: Boolean(options.ignoreCase),
		limit: options.effectiveLimit,
		finderAvailable: true,
		pathResolvable: searchPathRelativeToCwd !== undefined,
		gitignoreInTree: false,
	});
	if (baseRoute.backend !== "fff") return undefined;
	if (searchPathRelativeToCwd === undefined) return undefined;

	const gitignoreInTree = options.isDirectory ? await hasGitignoreInTree(options.searchPath) : false;
	const semanticRoute = options.router.route({
		tool: "grep",
		glob: Boolean(options.glob),
		ignoreCase: Boolean(options.ignoreCase),
		limit: options.effectiveLimit,
		finderAvailable: true,
		pathResolvable: true,
		gitignoreInTree,
	});
	if (semanticRoute.backend !== "fff") return undefined;

	const finder = await finderPromise;
	const finderRoute = options.router.route({
		tool: "grep",
		glob: Boolean(options.glob),
		ignoreCase: Boolean(options.ignoreCase),
		limit: options.effectiveLimit,
		finderAvailable: Boolean(finder),
		pathResolvable: true,
		gitignoreInTree: false,
	});
	if (!finder || finderRoute.backend !== "fff") return undefined;

	const query = fffGrepQuery({
		pattern: options.pattern,
		glob: options.glob,
		isDirectory: options.isDirectory,
		searchPathRelativeToCwd,
	});
	if (!query) return undefined;

	const result = finder.grep(query, {
		mode: options.literal ? "plain" : "regex",
		smartCase: false,
		maxMatchesPerFile: options.effectiveLimit,
		beforeContext: options.contextValue,
		afterContext: options.contextValue,
		pageSize: options.effectiveLimit,
	});
	if (!result.ok || result.value.regexFallbackError) return undefined;
	return formatFffGrepResult({
		result: result.value,
		isDirectory: options.isDirectory,
		searchPathRelativeToCwd,
		effectiveLimit: options.effectiveLimit,
		contextValue: options.contextValue,
		toolCallId: options.toolCallId,
		artifactStore: options.artifactStore,
		broadQueryTracker: options.broadQueryTracker,
		pattern: options.pattern,
		rawPath: options.rawPath,
		glob: options.glob,
	});
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	const fffBackend = options?.fff === false ? undefined : (options?.fff ?? defaultFffSearchBackend);
	const searchRouter = options?.searchRouter ?? defaultSearchRouter;
	const artifactStore = options?.artifactStore;
	const broadQueryTracker = options?.broadQueryTracker;
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		parameters: grepSchema,
		toolGroup: "explore",
		async execute(
			toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}

						const contextValue = context && context > 0 ? context : 0;
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, filePath);
								if (relative && !relative.startsWith("..")) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						if (!customOps && fffBackend) {
							const fffResult = await tryFffGrep({
								backend: fffBackend,
								router: searchRouter,
								cwd,
								searchPath,
								pattern,
								glob,
								ignoreCase,
								literal,
								contextValue,
								effectiveLimit,
								isDirectory,
								toolCallId,
								artifactStore,
								broadQueryTracker,
								rawPath: searchDir,
							});
							if (fffResult) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: fffResult.text }],
										details: Object.keys(fffResult.details).length > 0 ? fffResult.details : undefined,
									}),
								);
								return;
							}
						}

						const rgPath = await ensureTool("rg", true);
						if (!rgPath) {
							settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
							return;
						}

						const fileCache = new Map<string, string[]>();
						const getFileLines = async (filePath: string): Promise<string[]> => {
							let lines = fileCache.get(filePath);
							if (!lines) {
								try {
									const content = await ops.readFile(filePath);
									lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
								} catch {
									lines = [];
								}
								fileCache.set(filePath, lines);
							}
							return lines;
						};

						const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
						if (ignoreCase) args.push("--ignore-case");
						if (literal) args.push("--fixed-strings");
						if (glob) args.push("--glob", glob);
						args.push("--", pattern, searchPath);

						const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let linesTruncated = false;
						let aborted = false;
						let killedDueToLimit = false;
						const outputLines: string[] = [];

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
						};
						const stopChild = (dueToLimit = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};
						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
							const relativePath = formatPath(filePath);
							const lines = await getFileLines(filePath);
							if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
							const block: string[] = [];
							const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
							const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
							for (let current = start; current <= end; current++) {
								const lineText = lines[current - 1] ?? "";
								const sanitized = lineText.replace(/\r/g, "");
								const isMatchLine = current === lineNumber;
								// Truncate long lines so grep output stays compact.
								const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
								if (wasTruncated) linesTruncated = true;
								if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
								else block.push(`${relativePath}-${current}- ${truncatedText}`);
							}
							return block;
						};

						// Collect matches during streaming, then format them after rg exits.
						const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];
						rl.on("line", (line) => {
							if (!line.trim() || matchCount >= effectiveLimit) return;
							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							if (event.type === "match") {
								matchCount++;
								const filePath = event.data?.path?.text;
								const lineNumber = event.data?.line_number;
								const lineText = event.data?.lines?.text;
								if (filePath && typeof lineNumber === "number")
									matches.push({ filePath, lineNumber, lineText });
								if (matchCount >= effectiveLimit) {
									matchLimitReached = true;
									stopChild(true);
								}
							}
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						child.on("close", async (code) => {
							cleanup();
							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (!killedDueToLimit && code !== 0 && code !== 1) {
								const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}
							if (matchCount === 0) {
								settle(() =>
									resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }),
								);
								return;
							}

							// Format matches after streaming finishes so custom readFile() backends can be async.
							const fileGroups = new Map<string, string[]>();
							for (const match of matches) {
								const relativePath = formatPath(match.filePath);
								if (!fileGroups.has(relativePath)) {
									fileGroups.set(relativePath, []);
								}
								const group = fileGroups.get(relativePath)!;

								if (contextValue === 0 && match.lineText !== undefined) {
									const sanitized = match.lineText
										.replace(/\r\n/g, "\n")
										.replace(/\r/g, "")
										.replace(/\n$/, "");
									const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
									if (wasTruncated) linesTruncated = true;
									group.push(`  ${match.lineNumber}: ${truncatedText}`);
								} else {
									const block = await formatBlock(match.filePath, match.lineNumber);
									for (const line of block) {
										if (line.startsWith(`${relativePath}:`)) {
											group.push(`  ${line.slice(relativePath.length + 1)}`);
										} else if (line.startsWith(`${relativePath}-`)) {
											group.push(`  ${line.slice(relativePath.length + 1)}`);
										} else {
											group.push(`  ${line}`);
										}
									}
								}
							}

							for (const [relativePath, lines] of fileGroups) {
								outputLines.push(`${relativePath}:`);
								let lastLine = "";
								for (const line of lines) {
									if (line === lastLine) continue;
									outputLines.push(line);
									lastLine = line;
								}
							}

							const rawOutput = outputLines.join("\n");
							// Measure -> pack (artifact-backed if oversized and a store was provided) -> notices.
							// There is no line limit here because the match limit already capped rows.
							const { text: output, details } = packGrepOutput({
								rawOutput,
								toolCallId,
								artifactStore,
								broadQueryTracker,
								pattern,
								rawPath: searchDir,
								glob,
								matchLimitReached: matchLimitReached ? effectiveLimit : false,
								linesTruncated,
							});
							settle(() =>
								resolve({
									content: [{ type: "text", text: output }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme, context.cwd));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
