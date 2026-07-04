import { createInterface } from "node:readline";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "@caupulican/pi-agent-core/node";
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
	type FffSearchBackend,
	type FffSearchResult,
	hasGitignoreInTree,
	relativePathInside,
	safeGetFinder,
} from "./fff-search-backend.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { defaultSearchRouter, type SearchRouter } from "./search-router.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

function toPosixPath(value: string): string {
	return value.split(path.sep).join("/");
}

const findSchema = Type.Object({
	pattern: Type.String({
		description:
			"Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'. Use '.' to match all files.",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive matching (default: false)" })),
});

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	/** Set only when output was packed to an artifact; see tool-output-packer.ts. */
	artifactId?: string;
	/** Set when this exact query has repeatedly produced broad/truncated results. */
	invalidationCandidate?: boolean;
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Find files matching glob pattern. Returns relative or absolute paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
	exists: pathExists,
	// This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
	glob: () => [],
};

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem plus routed FFF/fd search */
	operations?: FindOperations;
	/** FFF backend for resident indexed search. Set false to force fd fallback. */
	fff?: FffSearchBackend | false;
	/** Pure router that selects FFF or fd from request filters and environment facts. */
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

function formatFindCall(
	args: { pattern: string; path?: string; limit?: number } | undefined,
	theme: Theme,
	cwd: string,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".", cwd) : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("find")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

function formatFindResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: FindToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

function hasGlobSyntax(pattern: string): boolean {
	return pattern === "." || /[*?[{]/.test(pattern);
}

function fffQueryParts(parts: string[]): string {
	return parts.filter(Boolean).join(" ");
}

function toSearchRelative(repoRelativePath: string, searchPathRelativeToCwd: string): string | undefined {
	if (!searchPathRelativeToCwd) return repoRelativePath;
	const prefix = `${searchPathRelativeToCwd}/`;
	if (!repoRelativePath.startsWith(prefix)) return undefined;
	return repoRelativePath.slice(prefix.length);
}

function fffGlobPattern(pattern: string, searchPathRelativeToCwd: string): string {
	const effectivePattern = pattern === "." ? "**/*" : pattern;
	if (!searchPathRelativeToCwd) {
		if (effectivePattern.includes("/") || effectivePattern.startsWith("**/")) return effectivePattern;
		return `**/${effectivePattern}`;
	}
	if (effectivePattern === "**" || effectivePattern === "**/*") return `${searchPathRelativeToCwd}/**/*`;
	if (effectivePattern.includes("/")) return `${searchPathRelativeToCwd}/${effectivePattern}`;
	return `${searchPathRelativeToCwd}/**/${effectivePattern}`;
}

interface FindPackingOptions {
	toolCallId: string;
	artifactStore?: ArtifactStore;
	broadQueryTracker?: BroadQueryTracker;
	pattern: string;
	rawPath?: string;
}

function fffSearchOutput(
	result: FffSearchResult,
	searchPathRelativeToCwd: string,
	effectiveLimit: number,
	packing: FindPackingOptions,
) {
	const relativized = result.items
		.map((item) => toSearchRelative(item.relativePath, searchPathRelativeToCwd))
		.filter((item): item is string => Boolean(item));
	return formatFindResults(relativized, effectiveLimit, packing);
}

export async function tryFffFind(options: {
	backend: FffSearchBackend;
	router: SearchRouter;
	cwd: string;
	searchPath: string;
	pattern: string;
	ignoreCase?: boolean;
	effectiveLimit: number;
	toolCallId: string;
	artifactStore?: ArtifactStore;
	broadQueryTracker?: BroadQueryTracker;
	rawPath?: string;
}): Promise<{ text: string; details: FindToolDetails } | undefined> {
	if (!(await pathExists(options.searchPath))) return undefined;

	// Kick off the FFF finder -- and, on a machine where fff-node isn't provisioned
	// yet, its lazy managed install -- unconditionally and as early as possible.
	// Routing below can still send THIS call to the fd fallback for reasons that
	// have nothing to do with tool availability (most commonly: the default result
	// limit is well above the FFF top-N threshold, see search-router.ts). That
	// outcome must not gate the install itself, or a machine that only ever issues
	// default-limit searches would never provision fff-node at all. getFinder() is
	// cached per basePath, so this costs nothing beyond the first call for a given
	// cwd -- the `await` further down, when this call does want FFF, reuses this
	// same in-flight/resolved promise instead of triggering the work twice.
	// safeGetFinder() guarantees this can never reject (a non-conforming custom
	// backend that throws synchronously still degrades to "unavailable"), so it
	// can neither produce an unhandled rejection nor fail this tool call outright.
	const finderPromise = safeGetFinder(options.backend, options.cwd);

	const searchPathRelativeToCwd = relativePathInside(options.cwd, options.searchPath);
	const glob = hasGlobSyntax(options.pattern);
	const baseRoute = options.router.route({
		tool: "find",
		glob,
		ignoreCase: Boolean(options.ignoreCase),
		limit: options.effectiveLimit,
		finderAvailable: true,
		pathResolvable: searchPathRelativeToCwd !== undefined,
		gitignoreInTree: false,
	});
	if (baseRoute.backend !== "fff") return undefined;
	if (searchPathRelativeToCwd === undefined) return undefined;

	const gitignoreInTree = await hasGitignoreInTree(options.searchPath);
	const semanticRoute = options.router.route({
		tool: "find",
		glob,
		ignoreCase: Boolean(options.ignoreCase),
		limit: options.effectiveLimit,
		finderAvailable: true,
		pathResolvable: true,
		gitignoreInTree,
	});
	if (semanticRoute.backend !== "fff") return undefined;

	const finder = await finderPromise;
	const finderRoute = options.router.route({
		tool: "find",
		glob,
		ignoreCase: Boolean(options.ignoreCase),
		limit: options.effectiveLimit,
		finderAvailable: Boolean(finder),
		pathResolvable: true,
		gitignoreInTree: false,
	});
	if (!finder || finderRoute.backend !== "fff") return undefined;

	const packing: FindPackingOptions = {
		toolCallId: options.toolCallId,
		artifactStore: options.artifactStore,
		broadQueryTracker: options.broadQueryTracker,
		pattern: options.pattern,
		rawPath: options.rawPath,
	};

	if (glob) {
		const result = finder.glob(fffGlobPattern(options.pattern, searchPathRelativeToCwd), {
			pageSize: options.effectiveLimit,
		});
		return result.ok
			? fffSearchOutput(result.value, searchPathRelativeToCwd, options.effectiveLimit, packing)
			: undefined;
	}

	const pathConstraint = searchPathRelativeToCwd ? `${searchPathRelativeToCwd}/` : "";
	const result = finder.fileSearch(fffQueryParts([pathConstraint, options.pattern]), {
		pageSize: options.effectiveLimit,
	});
	return result.ok
		? fffSearchOutput(result.value, searchPathRelativeToCwd, options.effectiveLimit, packing)
		: undefined;
}

function formatFindResults(
	relativized: string[],
	effectiveLimit: number,
	packing: FindPackingOptions,
): { text: string; details: FindToolDetails } {
	if (relativized.length === 0) {
		return { text: "No files found matching pattern", details: {} };
	}

	const dirGroups = new Map<string, string[]>();
	const extCounts = new Map<string, number>();

	for (const p of relativized) {
		const dir = path.dirname(p);
		const base = path.basename(p);
		const dirKey = dir === "." ? "./" : `${dir}/`;
		if (!dirGroups.has(dirKey)) {
			dirGroups.set(dirKey, []);
		}
		dirGroups.get(dirKey)!.push(base);

		const ext = path.extname(p).toLowerCase() || "(no extension)";
		extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
	}

	const sortedDirs = Array.from(dirGroups.keys()).sort((a, b) => a.localeCompare(b));
	const formattedLines: string[] = [];
	for (const dir of sortedDirs) {
		formattedLines.push(dir);
		const files = dirGroups.get(dir)!;
		files.sort((a, b) => a.localeCompare(b));
		for (const file of files) {
			formattedLines.push(`  ${file}`);
		}
	}

	const extSummaryParts = Array.from(extCounts.entries())
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([ext, count]) => `${ext}: ${count}`);
	const extSummary = `Extensions: ${extSummaryParts.join(", ")}`;

	const resultLimitReached = relativized.length >= effectiveLimit;
	const rawOutput = formattedLines.join("\n");
	// Measure -> pack (artifact-backed if oversized and a store was provided) -> notices.
	const packed = packToolOutput(
		{
			toolName: "find",
			path: packing.rawPath,
			rawContent: rawOutput,
			// No line limit here because the result limit already caps rows; only the byte
			// cap should apply, matching the pre-Slice-B truncateHead call exactly.
			truncation: { maxLines: Number.MAX_SAFE_INTEGER },
		},
		packing.artifactStore,
		packing.toolCallId,
	);
	let resultOutput = packed.content;
	const details: FindToolDetails = {};
	const notices: string[] = [];
	if (packed.artifactId) {
		notices.push(formatArtifactNotice(packed.artifactId));
		details.artifactId = packed.artifactId;
	}
	if (resultLimitReached) {
		notices.push(
			`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or narrow path/pattern`,
		);
		details.resultLimitReached = effectiveLimit;
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
	if (resultLimitReached || packed.truncation.truncated) {
		const note = broadQueryInvalidationNote(
			packing.broadQueryTracker,
			normalizeBroadQueryKey({ toolName: "find", pattern: packing.pattern, path: packing.rawPath }),
			`find "${packing.pattern}" in ${packing.rawPath ?? "."}`,
		);
		if (note) {
			notices.push(note);
			details.invalidationCandidate = true;
		}
	}
	if (relativized.length > 0) {
		resultOutput += `\n\n[Summary - ${extSummary}]`;
	}
	if (notices.length > 0) {
		resultOutput += `\n\n[${notices.join(". ")}]`;
	}
	return { text: resultOutput, details };
}

export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	const customOps = options?.operations;
	const fffBackend = options?.fff === false ? undefined : (options?.fff ?? defaultFffSearchBackend);
	const searchRouter = options?.searchRouter ?? defaultSearchRouter;
	const artifactStore = options?.artifactStore;
	const broadQueryTracker = options?.broadQueryTracker;
	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: "Find files by glob pattern (respects .gitignore)",
		parameters: findSchema,
		toolGroup: "explore",
		async execute(
			toolCallId,
			{
				pattern,
				path: searchDir,
				limit,
				ignoreCase,
			}: { pattern: string; path?: string; limit?: number; ignoreCase?: boolean },
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
				let stopChild: (() => void) | undefined;
				const settle = (fn: () => void) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					stopChild = undefined;
					fn();
				};
				const onAbort = () => {
					stopChild?.();
					settle(() => reject(new Error("Operation aborted")));
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;
						const ops = customOps ?? defaultFindOperations;

						let effectivePattern = pattern;
						if (pattern === ".") {
							effectivePattern = "**/*";
						}

						if (!customOps && fffBackend) {
							const fffResult = await tryFffFind({
								backend: fffBackend,
								router: searchRouter,
								cwd,
								searchPath,
								pattern: effectivePattern,
								ignoreCase,
								effectiveLimit,
								toolCallId,
								artifactStore,
								broadQueryTracker,
								rawPath: searchDir,
							});
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
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

						// If custom operations provide glob(), use that instead of fd.
						if (customOps?.glob) {
							if (!(await ops.exists(searchPath))) {
								settle(() => reject(new Error(`Path not found: ${searchPath}`)));
								return;
							}
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							const results = await ops.glob(effectivePattern, searchPath, {
								ignore: ["**/node_modules/**", "**/.git/**"],
								limit: effectiveLimit,
							});
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}

							// Relativize paths against the search root for stable output.
							const relativized = results.map((p) => {
								if (p.startsWith(searchPath)) return toPosixPath(p.slice(searchPath.length + 1));
								return toPosixPath(path.relative(searchPath, p));
							});

							const formatted = formatFindResults(relativized, effectiveLimit, {
								toolCallId,
								artifactStore,
								broadQueryTracker,
								pattern: effectivePattern,
								rawPath: searchDir,
							});
							settle(() =>
								resolve({
									content: [{ type: "text", text: formatted.text }],
									details: Object.keys(formatted.details).length > 0 ? formatted.details : undefined,
								}),
							);
							return;
						}

						// Default implementation uses fd.
						const fdPath = await ensureTool("fd", true);
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						if (!fdPath) {
							settle(() => reject(new Error("fd is not available and could not be downloaded")));
							return;
						}

						// Build fd arguments. --no-require-git makes fd apply hierarchical .gitignore
						// semantics whether or not the search path is inside a git repository, without
						// leaking sibling-directory rules the way --ignore-file (a global source) would.
						const args: string[] = [
							"--glob",
							"--color=never",
							"--hidden",
							"--no-require-git",
							"--max-results",
							String(effectiveLimit),
						];
						if (ignoreCase) {
							args.push("--ignore-case");
						}

						// fd --glob matches against the basename unless --full-path is set; in --full-path
						// mode it matches against the absolute candidate path, so a path-containing
						// pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
						let finalPattern = effectivePattern;
						if (effectivePattern.includes("/")) {
							args.push("--full-path");
							if (
								!effectivePattern.startsWith("/") &&
								!effectivePattern.startsWith("**/") &&
								effectivePattern !== "**"
							) {
								finalPattern = `**/${effectivePattern}`;
							}
						}
						args.push("--", finalPattern, searchPath);

						const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						const lines: string[] = [];

						stopChild = () => {
							if (!child.killed) {
								child.kill();
							}
						};

						const cleanup = () => {
							rl.close();
						};

						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						rl.on("line", (line) => {
							lines.push(line);
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
						});

						child.on("close", (code) => {
							cleanup();
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							const output = lines.join("\n");
							if (code !== 0) {
								const errorMsg = stderr.trim() || `fd exited with code ${code}`;
								if (!output) {
									settle(() => reject(new Error(errorMsg)));
									return;
								}
							}

							const relativized: string[] = [];
							for (const rawLine of lines) {
								const line = rawLine.replace(/\r$/, "").trim();
								if (!line) continue;
								const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
								let relativePath = line;
								if (line.startsWith(searchPath)) {
									relativePath = line.slice(searchPath.length + 1);
								} else {
									relativePath = path.relative(searchPath, line);
								}
								if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
								relativized.push(toPosixPath(relativePath));
							}

							const formatted = formatFindResults(relativized, effectiveLimit, {
								toolCallId,
								artifactStore,
								broadQueryTracker,
								pattern: effectivePattern,
								rawPath: searchDir,
							});
							settle(() =>
								resolve({
									content: [{ type: "text", text: formatted.text }],
									details: Object.keys(formatted.details).length > 0 ? formatted.details : undefined,
								}),
							);
						});
					} catch (e) {
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						const error = e instanceof Error ? e : new Error(String(e));
						settle(() => reject(error));
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindCall(args, theme, context.cwd));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
