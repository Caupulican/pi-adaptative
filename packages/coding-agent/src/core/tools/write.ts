import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type AgentTool, createAgentToolFailureRecoveryAuthority } from "@caupulican/pi-agent-core/types";
import { Container, Text } from "@caupulican/pi-tui";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import {
	FILE_EXISTS_RECOVERY_TARGET_KIND,
	type FileFailureRecoveryAuthority,
	selectFileFailureRecoveryAuthority,
	WORKSPACE_MUTATED_RECOVERY_TARGET_KIND,
	WRITE_RETARGET_RECOVERY_TARGET_KIND,
} from "./file-failure-recovery.ts";
import {
	type FileContentReference,
	FileMutationIntentController,
	FileMutationPreflightError,
} from "./file-mutation-intent.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { normalizeDisplayText, renderToolPath, replaceTabs, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writePathSchema = Type.String({ minLength: 1 });
const writeSchema = Type.Union([
	Type.Object(
		{
			path: writePathSchema,
			content: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			path: writePathSchema,
			contentRef: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			path: writePathSchema,
			payloadRef: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);

export type WriteToolInput = Static<typeof writeSchema>;

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Atomically create a new file and fail if any entry already occupies the path. */
	createFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
	createFile: (path, content) => fsWriteFile(path, content, { encoding: "utf-8", flag: "wx" }),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
	/** Shared backend identity for exact cross-tool recovery with custom operations. */
	failureRecoveryAuthority?: FileFailureRecoveryAuthority;
	/** Session-owned harness preflight and exact-content-reference authority. */
	intentController?: FileMutationIntentController;
}

export interface WriteToolDetails {
	phase: "written";
	contentRef?: string;
	byteCount?: number;
}

type WriteHighlightCache = {
	argsRef: unknown;
	rawPath: string | null;
	countCompleteLines: boolean;
	expanded: boolean;
	renderedLines: string[];
	totalLines?: number;
	cappedByCharacters: boolean;
	cappedByLines: boolean;
};

class WriteCallRenderComponent extends Text {
	cache?: WriteHighlightCache;

	constructor() {
		super("", 0, 0);
	}
}

const WRITE_COLLAPSED_PREVIEW_LINES = 10;
const WRITE_COLLAPSED_PREVIEW_CHARS = 8_192;

function countWriteDisplayLines(fileContent: string): number {
	let lastContentIndex = fileContent.length - 1;
	while (lastContentIndex >= 0) {
		const code = fileContent.charCodeAt(lastContentIndex);
		if (code !== 10 && code !== 13) break;
		lastContentIndex--;
	}
	if (lastContentIndex < 0) return 0;

	let lines = 1;
	for (let i = 0; i <= lastContentIndex; i++) {
		if (fileContent.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function buildCollapsedWriteSource(fileContent: string): {
	source: string;
	cappedByCharacters: boolean;
	cappedByLines: boolean;
} {
	const rawPrefix = fileContent.slice(0, WRITE_COLLAPSED_PREVIEW_CHARS);
	const normalizedPrefix = replaceTabs(normalizeDisplayText(rawPrefix));
	let end = normalizedPrefix.length;
	let newlineCount = 0;
	for (let i = 0; i < normalizedPrefix.length; i++) {
		if (normalizedPrefix.charCodeAt(i) !== 10) continue;
		newlineCount++;
		if (newlineCount === WRITE_COLLAPSED_PREVIEW_LINES) {
			end = i;
			break;
		}
	}
	const cappedByLines = end < normalizedPrefix.length;
	return {
		source: normalizedPrefix.slice(0, end),
		cappedByCharacters: !cappedByLines && rawPrefix.length < fileContent.length,
		cappedByLines,
	};
}

function buildWriteHighlightCache(
	argsRef: unknown,
	rawPath: string | null,
	fileContent: string,
	countCompleteLines: boolean,
	expanded: boolean,
): WriteHighlightCache {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (expanded) {
		const source = replaceTabs(normalizeDisplayText(fileContent));
		const renderedLines = trimTrailingEmptyLines(lang ? highlightCode(source, lang) : source.split("\n"));
		return {
			argsRef,
			rawPath,
			countCompleteLines,
			expanded,
			renderedLines,
			totalLines: renderedLines.length,
			cappedByCharacters: false,
			cappedByLines: false,
		};
	}

	const preview = buildCollapsedWriteSource(fileContent);
	const renderedLines = trimTrailingEmptyLines(
		lang ? highlightCode(preview.source, lang) : preview.source.split("\n"),
	);
	return {
		argsRef,
		rawPath,
		countCompleteLines,
		expanded,
		renderedLines,
		totalLines: countCompleteLines ? countWriteDisplayLines(fileContent) : undefined,
		cappedByCharacters: preview.cappedByCharacters,
		cappedByLines: preview.cappedByLines,
	};
}

function getWriteHighlightCache(
	cache: WriteHighlightCache | undefined,
	argsRef: unknown,
	rawPath: string | null,
	fileContent: string,
	countCompleteLines: boolean,
	expanded: boolean,
): WriteHighlightCache {
	if (
		cache &&
		cache.argsRef === argsRef &&
		cache.rawPath === rawPath &&
		cache.countCompleteLines === countCompleteLines &&
		cache.expanded === expanded
	) {
		return cache;
	}
	return buildWriteHighlightCache(argsRef, rawPath, fileContent, countCompleteLines, expanded);
}

function formatWriteCall(
	args: { path?: string; file_path?: string; content?: string; contentRef?: string; payloadRef?: string } | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
	cache: WriteHighlightCache | undefined,
	cwd: string,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const fileContent = str(args?.content);
	const hasContent = typeof args?.content === "string";
	const pathDisplay = renderToolPath(rawPath, theme, cwd);
	let text = `${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}`;

	if (!hasContent && typeof args?.contentRef !== "string" && typeof args?.payloadRef !== "string") {
		text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
	} else if (hasContent && fileContent) {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const displayLines = cache?.renderedLines ?? [];
		text += `\n\n${displayLines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
		if (!options.expanded && cache && (cache.cappedByCharacters || cache.cappedByLines)) {
			const total = cache.totalLines;
			if (cache.cappedByCharacters) {
				const totalSuffix = total === undefined ? "" : `; ${total} total line${total === 1 ? "" : "s"}`;
				text += `${theme.fg("muted", `\n... (preview capped at ${WRITE_COLLAPSED_PREVIEW_CHARS} characters${totalSuffix},`)} ${keyHint("app.tools.expand", "to expand")})`;
			} else if (total === undefined) {
				text += `${theme.fg("muted", "\n... (preview capped,")} ${keyHint("app.tools.expand", "to expand")})`;
			} else {
				const remaining = Math.max(0, total - displayLines.length);
				if (remaining > 0) {
					text += `${theme.fg("muted", `\n... (${remaining} more lines, ${total} total,`)} ${keyHint("app.tools.expand", "to expand")})`;
				}
			}
		}
	} else if (args?.contentRef) {
		text += `\n\n${theme.fg("muted", `reuse ${args.contentRef}`)}`;
	} else if (args?.payloadRef) {
		text += `\n\n${theme.fg("muted", `retarget ${args.payloadRef}`)}`;
	}

	return text;
}

async function writeCollisionWithRetainedPayload(
	error: FileMutationPreflightError,
	input: WriteToolInput,
	intentController: FileMutationIntentController,
	signal?: AbortSignal,
): Promise<Error> {
	const retargetError = (reference: string): Error =>
		new Error(
			`PI_FILE_MUTATION_RETARGET write_collision: ${reference}. Choose only a corrected path; the exact valid write payload is retained.`,
		);
	if ("contentRef" in input) {
		await intentController.assertContentReference(input.contentRef, signal);
		return retargetError(`contentRef ${input.contentRef}`);
	}
	if ("payloadRef" in input) {
		await intentController.assertMutationPayload(input.payloadRef, "write", signal);
		return retargetError(`payloadRef ${input.payloadRef}`);
	}

	try {
		const retained = await intentController.retainMutationPayload("write", input.content);
		if (retained) {
			return retargetError(`payloadRef ${retained.payloadRef}`);
		}
	} catch {
		// The collision remains authoritative when the bounded retry cache is unavailable.
	}
	return new Error(`${error.message} The payload could not be retained within the secure retry-cache bound.`);
}

function formatWriteResult(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean },
	theme: Theme,
): string | undefined {
	if (!result.isError) {
		return undefined;
	}
	const output = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text || "")
		.join("\n");
	if (!output) {
		return undefined;
	}
	return `\n${theme.fg("error", output)}`;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, WriteToolDetails> {
	const ops = options?.operations ?? defaultWriteOperations;
	const failureRecoveryAuthority = selectFileFailureRecoveryAuthority(
		options?.operations !== undefined,
		options?.failureRecoveryAuthority,
	);
	if (options?.operations && !options.intentController) {
		throw new Error("Custom write operations require a matching file mutation intent controller.");
	}
	const intentController = options?.intentController ?? new FileMutationIntentController();
	const retargetRecoveryAuthority = createAgentToolFailureRecoveryAuthority();
	return {
		name: "write",
		label: "write",
		description:
			"Create a new file without overwriting. Send path and exactly one of content or contentRef. After a path-only collision, use the returned payloadRef with only a corrected path. The harness owns preflight, bounded payload retention, and atomic rechecks.",
		promptSnippet: "Preflight new paths; never overwrite",
		promptGuidelines: [
			"Call once per file: path plus exactly one of content/contentRef; writes to different files may be emitted together in one message. Harness owns preparation/collision checks.",
			"Collision with payloadRef: choose new path, reuse reference; never regenerate content.",
			"write is create-only; edit existing files. Reuse contentRef for exact copies.",
		],
		parameters: writeSchema,
		failureRecovery: {
			getFailureTargets: (params, failure) =>
				failure.failureCode === "mutation_retarget_required"
					? [
							{
								authority: retargetRecoveryAuthority,
								kind: WRITE_RETARGET_RECOVERY_TARGET_KIND,
								scope: resolveToCwd(params.path, cwd),
							},
						]
					: [],
			actions: [
				{
					kind: "correct",
					authority: retargetRecoveryAuthority,
					targetKind: WRITE_RETARGET_RECOVERY_TARGET_KIND,
					instruction:
						"Use write with the retained payloadRef and a corrected new path; write cannot overwrite an existing entry.",
				},
				...(failureRecoveryAuthority
					? [
							{
								kind: "repair" as const,
								authority: failureRecoveryAuthority.contractAuthority,
								targetKind: FILE_EXISTS_RECOVERY_TARGET_KIND,
								instruction:
									"If the goal requires this exact missing file and its content is known, create it with write.",
							},
							{
								kind: "repair" as const,
								authority: failureRecoveryAuthority.contractAuthority,
								targetKind: WORKSPACE_MUTATED_RECOVERY_TARGET_KIND,
								instruction:
									"When a command failed because workspace contents need repair, create the required file and rerun that exact command.",
							},
						]
					: []),
			],
		},
		async execute(_toolCallId, input: WriteToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const { path } = input;
			const absolutePath = resolveToCwd(path, cwd);
			const content = "content" in input && typeof input.content === "string" ? input.content : undefined;
			const contentRef =
				"contentRef" in input && typeof input.contentRef === "string" ? input.contentRef : undefined;
			const payloadRef =
				"payloadRef" in input && typeof input.payloadRef === "string" ? input.payloadRef : undefined;
			if ([content, contentRef, payloadRef].filter((value) => value !== undefined).length !== 1) {
				throw new Error("Write requires exactly one of content, contentRef, or payloadRef.");
			}
			try {
				const lease = await intentController.prepare("write", absolutePath, signal, path);
				return await withFileMutationQueue(absolutePath, async () => {
					// Do not reject from an abort event listener here: that would release the
					// mutation queue while an in-flight filesystem operation may still finish.
					// Checking signal.aborted after each await observes the same aborts while
					// keeping the queue locked until the current operation has settled.
					const throwIfAborted = (): void => {
						if (signal?.aborted) throw new Error("Operation aborted");
					};

					throwIfAborted();
					await intentController.assertCurrent(lease, signal);
					await ops.mkdir(dirname(absolutePath));
					throwIfAborted();

					let contentReference: FileContentReference;
					try {
						if (content !== undefined) {
							await ops.createFile(absolutePath, content);
							contentReference = intentController.rememberContent(absolutePath, content);
						} else if (contentRef !== undefined) {
							contentReference = await intentController.copyReferencedContent(contentRef, absolutePath, signal);
						} else {
							if (payloadRef === undefined) throw new Error("Write requires a payload reference.");
							contentReference = await intentController.copyMutationPayload(payloadRef, absolutePath, signal);
						}
					} catch (error) {
						if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
							throw new FileMutationPreflightError(
								"write_collision",
								`Write collision: ${path} already exists; no content was overwritten.`,
							);
						}
						throw error;
					}
					throwIfAborted();

					const byteCount = contentReference.byteLength;
					return {
						content: [
							{
								type: "text" as const,
								text: `Successfully wrote ${byteCount} bytes to ${path}; this write is complete, so do not call write again for this path. To copy these exact bytes to a different new path, call write once for that path with contentRef ${contentReference.contentRef}.`,
							},
						],
						details: {
							phase: "written" as const,
							contentRef: contentReference.contentRef,
							byteCount,
						},
					};
				});
			} catch (error) {
				if (error instanceof FileMutationPreflightError && error.reason === "write_collision") {
					throw await writeCollisionWithRetainedPayload(error, input, intentController, signal);
				}
				throw error;
			}
		},
		renderCall(args, theme, context) {
			const renderArgs = args as
				| { path?: string; file_path?: string; content?: string; contentRef?: string; payloadRef?: string }
				| undefined;
			const rawPath = str(renderArgs?.file_path ?? renderArgs?.path);
			const fileContent = str(renderArgs?.content);
			const component =
				(context.lastComponent as WriteCallRenderComponent | undefined) ?? new WriteCallRenderComponent();
			if (fileContent !== null) {
				component.cache = getWriteHighlightCache(
					component.cache,
					args,
					rawPath,
					fileContent,
					context.argsComplete,
					context.expanded,
				);
			} else {
				component.cache = undefined;
			}
			component.setText(
				formatWriteCall(
					renderArgs,
					{ expanded: context.expanded, isPartial: context.isPartial },
					theme,
					component.cache,
					context.cwd,
				),
			);
			return component;
		},
		renderResult(result, _options, theme, context) {
			const output = formatWriteResult({ ...result, isError: context.isError }, theme);
			if (!output) {
				const component = (context.lastComponent as Container | undefined) ?? new Container();
				component.clear();
				return component;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(output);
			return text;
		},
	};
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
