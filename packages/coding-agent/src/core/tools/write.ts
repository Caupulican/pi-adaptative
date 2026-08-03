import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { Container, Text } from "@caupulican/pi-tui";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import {
	type FileContentReference,
	FileMutationIntentController,
	hasFileMutationIntentIdShape,
} from "./file-mutation-intent.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { normalizeDisplayText, renderToolPath, replaceTabs, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writePathSchema = Type.String({ minLength: 1 });
const writeActionProperties = {
	action: Type.Literal("write"),
	path: writePathSchema,
	intentId: Type.String({ minLength: 1 }),
};
const writeSchema = Type.Union([
	Type.Object(
		{
			action: Type.Literal("prepare"),
			path: writePathSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...writeActionProperties,
			content: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...writeActionProperties,
			contentRef: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
]);

export type WriteToolInput = Static<typeof writeSchema>;

function prepareWriteArguments(input: unknown): WriteToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input as WriteToolInput;
	const args = input as Record<string, unknown>;
	if (
		typeof args.path === "string" &&
		(args.action === undefined || (args.action === "write" && !hasFileMutationIntentIdShape(args.intentId)))
	) {
		return { action: "prepare", path: args.path };
	}
	return args as WriteToolInput;
}

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
	/** Session-owned two-phase intent and exact-content-reference authority. */
	intentController?: FileMutationIntentController;
}

export interface WriteToolDetails {
	phase: "prepared" | "written";
	intentId?: string;
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
	args: { action?: string; path?: string; file_path?: string; content?: string; contentRef?: string } | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
	cache: WriteHighlightCache | undefined,
	cwd: string,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const fileContent = str(args?.content);
	const hasContent = typeof args?.content === "string";
	const pathDisplay = renderToolPath(rawPath, theme, cwd);
	const action = args?.action === "prepare" ? "prepare" : undefined;
	let text = `${theme.fg("toolTitle", theme.bold("write"))}${action ? ` ${theme.fg("muted", action)}` : ""} ${pathDisplay}`;

	if (args?.action === "write" && !hasContent && typeof args.contentRef !== "string") {
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
	}

	return text;
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
	if (options?.operations && !options.intentController) {
		throw new Error("Custom write operations require a matching file mutation intent controller.");
	}
	const intentController = options?.intentController ?? new FileMutationIntentController();
	return {
		name: "write",
		label: "write",
		description:
			'Create a file without overwriting: first call write with action "prepare" and path, then call write with action "write", the accepted intentId, and content or contentRef. Preparation rejects collisions before content generation; writing rechecks atomically.',
		promptSnippet: "Preflight new paths; never overwrite",
		promptGuidelines: [
			'Before content generation, call write with action "prepare" and path; then call write with action "write", the returned intentId, and one of content or contentRef.',
			"Write is create-only; edit existing files. Reuse contentRef for exact copies.",
		],
		parameters: writeSchema,
		prepareArguments: prepareWriteArguments,
		async execute(_toolCallId, input: WriteToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const { path } = input;
			const absolutePath = resolveToCwd(path, cwd);
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				if (input.action === "prepare") {
					const prepared = await intentController.prepare("write", absolutePath, signal, path);
					return {
						content: [
							{
								type: "text" as const,
								text: `Write path accepted. Call write again with action "write", path ${path}, and intentId ${prepared.intentId}. The call also needs exactly one required payload field: content with the exact requested text, or contentRef for previously returned exact bytes. Do not omit the payload field.`,
							},
						],
						details: { phase: "prepared" as const, intentId: prepared.intentId },
					};
				}

				const content = "content" in input && typeof input.content === "string" ? input.content : undefined;
				const contentRef =
					"contentRef" in input && typeof input.contentRef === "string" ? input.contentRef : undefined;
				if ((content === undefined) === (contentRef === undefined)) {
					throw new Error('Write action "write" requires exactly one of content or contentRef.');
				}
				const lease = intentController.consume(input.intentId, "write", absolutePath);
				await intentController.assertCurrent(lease, signal);
				await ops.mkdir(dirname(absolutePath));
				throwIfAborted();

				let contentReference: FileContentReference;
				try {
					if (content !== undefined) {
						await ops.createFile(absolutePath, content);
						contentReference = intentController.rememberContent(absolutePath, content);
					} else {
						if (contentRef === undefined) throw new Error('Write action "write" requires content or contentRef.');
						contentReference = await intentController.copyReferencedContent(contentRef, absolutePath, signal);
					}
				} catch (error) {
					if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
						throw new Error(`Write collision: ${path} already exists; no content was overwritten.`);
					}
					throw error;
				}
				throwIfAborted();

				const byteCount = contentReference.byteLength;
				return {
					content: [
						{
							type: "text" as const,
							text: `Successfully wrote ${byteCount} bytes to ${path}; this write is complete, so do not call write again for this path. To copy these exact bytes to a different new path, prepare that different path first, then use contentRef ${contentReference.contentRef}.`,
						},
					],
					details: {
						phase: "written" as const,
						contentRef: contentReference.contentRef,
						byteCount,
					},
				};
			});
		},
		renderCall(args, theme, context) {
			const renderArgs = args as
				| { action?: string; path?: string; file_path?: string; content?: string; contentRef?: string }
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
					context.argsComplete && !context.toolGroupSummary,
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
