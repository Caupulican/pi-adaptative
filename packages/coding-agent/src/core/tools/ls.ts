import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "@caupulican/pi-agent-core/truncate";
import nodePath from "path";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import {
	FILE_EXISTS_RECOVERY_TARGET_KIND,
	type FileFailureRecoveryAuthority,
	selectFileFailureRecoveryAuthority,
} from "./file-failure-recovery.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import {
	formatCollapsibleToolResult,
	renderTextComponent,
	renderToolPath,
	str,
	toolTextResult,
} from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
	metadata: Type.Optional(Type.Boolean({ description: "Include file size and permission metadata (default: false)" })),
});

export type LsToolInput = Static<typeof lsSchema>;

const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
}

/**
 * Pluggable operations for the ls tool.
 * Override these to delegate directory listing to remote systems (for example SSH).
 */
export interface LsEntryStats {
	isDirectory: () => boolean;
	size?: number;
	mode?: number;
}

export interface LsOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Get file or directory stats. Throws if not found. */
	stat: (absolutePath: string) => Promise<LsEntryStats> | LsEntryStats;
	/** Read directory entries */
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

const defaultLsOperations: LsOperations = {
	exists: pathExists,
	stat: fsStat,
	readdir: fsReaddir,
};

export interface LsToolOptions {
	/** Custom operations for directory listing. Default: local filesystem */
	operations?: LsOperations;
	/** Shared backend identity for exact cross-tool recovery with custom operations. */
	failureRecoveryAuthority?: FileFailureRecoveryAuthority;
}

function formatLsCall(args: { path?: string; limit?: number } | undefined, theme: Theme, cwd: string): string {
	const limit = args?.limit;
	const pathDisplay = renderToolPath(str(args?.path), theme, cwd, { emptyFallback: "." });
	let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${pathDisplay}`;
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

function formatLsResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: LsToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	return formatCollapsibleToolResult({
		result,
		options,
		theme,
		showImages,
		collapsedLineLimit: 20,
		warnings: (details) => {
			const warnings: string[] = [];
			if (details?.entryLimitReached) warnings.push(`${details.entryLimitReached} entries limit`);
			if (details?.truncation?.truncated) {
				warnings.push(`${formatSize(details.truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
			}
			return warnings;
		},
	});
}

function getPermissionString(mode: number, isDirectory: boolean): string {
	const typeChar = isDirectory ? "d" : "-";
	const rwx = (m: number) => [m & 4 ? "r" : "-", m & 2 ? "w" : "-", m & 1 ? "x" : "-"].join("");
	const owner = rwx((mode >> 6) & 7);
	const group = rwx((mode >> 3) & 7);
	const others = rwx(mode & 7);
	return `${typeChar}${owner}${group}${others}`;
}

export function createLsToolDefinition(
	cwd: string,
	options?: LsToolOptions,
): ToolDefinition<typeof lsSchema, LsToolDetails | undefined> {
	const ops = options?.operations ?? defaultLsOperations;
	const failureRecoveryAuthority = selectFileFailureRecoveryAuthority(
		options?.operations !== undefined,
		options?.failureRecoveryAuthority,
	);
	return {
		name: "ls",
		label: "ls",
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Batchable: emit alongside other independent calls in one message; never spend a turn per read.`,
		promptSnippet: "List directory contents",
		parameters: lsSchema,
		failureRecovery: {
			actions: failureRecoveryAuthority
				? [
						{
							kind: "correct",
							authority: failureRecoveryAuthority.contractAuthority,
							targetKind: FILE_EXISTS_RECOVERY_TARGET_KIND,
							instruction:
								"Use ls on the parent directory to find the actual entry, then submit a changed path.",
						},
					]
				: [],
		},
		async execute(
			_toolCallId,
			{ path, limit, metadata }: { path?: string; limit?: number; metadata?: boolean },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const onAbort = () => reject(new Error("Operation aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const dirPath = resolveToCwd(path || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;

						// Check if path exists.
						if (!(await ops.exists(dirPath))) {
							reject(new Error(`Path not found: ${dirPath}`));
							return;
						}

						// Check if path is a directory.
						const stat = await ops.stat(dirPath);
						if (!stat.isDirectory()) {
							reject(new Error(`Not a directory: ${dirPath}`));
							return;
						}

						// Read directory entries.
						let entries: string[];
						try {
							entries = await ops.readdir(dirPath);
						} catch (e: any) {
							reject(new Error(`Cannot read directory: ${e.message}`));
							return;
						}

						// Sort alphabetically, case-insensitive.
						entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

						// Format entries with directory indicators.
						const results: string[] = [];
						let entryLimitReached = false;
						for (const entry of entries) {
							if (results.length >= effectiveLimit) {
								entryLimitReached = true;
								break;
							}

							const fullPath = nodePath.join(dirPath, entry);
							let suffix = "";
							let sizeStr = "";
							let modeStr = "";
							try {
								const entryStat = await ops.stat(fullPath);
								const isDir = entryStat.isDirectory();
								if (isDir) suffix = "/";

								if (metadata) {
									if (isDir) {
										sizeStr = "    -";
									} else {
										const sizeVal = entryStat.size ?? 0;
										sizeStr = formatSize(sizeVal).padStart(7);
									}
									if (typeof entryStat.mode === "number") {
										modeStr = getPermissionString(entryStat.mode, isDir);
									} else {
										modeStr = isDir ? "d---------" : "----------";
									}
								}
							} catch {
								if (metadata) {
									sizeStr = "???????";
									modeStr = "??????????";
								}
							}
							if (metadata) {
								results.push(`${modeStr}  ${sizeStr}  ${entry}${suffix}`);
							} else {
								results.push(entry + suffix);
							}
						}

						signal?.removeEventListener("abort", onAbort);

						if (results.length === 0) {
							resolve({ content: [{ type: "text", text: "(empty directory)" }], details: undefined });
							return;
						}

						const rawOutput = results.join("\n");
						// Apply byte truncation. There is no separate line limit because entry count is already capped.
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
						let output = truncation.content;
						const details: LsToolDetails = {};
						// Build actionable notices for truncation and entry limits.
						const notices: string[] = [];
						if (entryLimitReached) {
							notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
							details.entryLimitReached = effectiveLimit;
						}
						if (truncation.truncated) {
							notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
							details.truncation = truncation;
						}
						if (notices.length > 0) {
							output += `\n\n[${notices.join(". ")}]`;
						}

						resolve(toolTextResult({ text: output, details }));
					} catch (e: any) {
						signal?.removeEventListener("abort", onAbort);
						reject(e);
					}
				})();
			});
		},
		renderCall(args, theme, context) {
			return renderTextComponent(context.lastComponent, formatLsCall(args, theme, context.cwd));
		},
		renderResult(result, options, theme, context) {
			return renderTextComponent(
				context.lastComponent,
				formatLsResult(result as Parameters<typeof formatLsResult>[0], options, theme, context.showImages),
			);
		},
	};
}

export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema> {
	return wrapToolDefinition(createLsToolDefinition(cwd, options));
}
