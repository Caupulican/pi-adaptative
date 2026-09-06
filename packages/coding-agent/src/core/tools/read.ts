import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@caupulican/pi-agent-core/truncate";
import type { AgentTool } from "@caupulican/pi-agent-core/types";
import type { Api, ImageContent, Model, TextContent } from "@caupulican/pi-ai";
import { StreamingLineDecoder, type StreamingLineRecord } from "@caupulican/pi-ai/streaming-lines";
import { Text } from "@caupulican/pi-tui";
import { constants } from "fs";
import { access as fsAccess, open as fsOpen, readFile as fsReadFile, stat as fsStat } from "fs/promises";
import { type Static, Type } from "typebox";
import { getAgentDir, getReadmePath } from "../../config.ts";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { PathInputOptions } from "../../utils/paths.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import { getProcessWorkRun } from "../../utils/work-directory.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { buildCodeOutline, renderCodeOutline } from "./code-outline.ts";
import {
	FILE_CURRENT_TEXT_RECOVERY_TARGET_KIND,
	FILE_EXISTS_RECOVERY_TARGET_KIND,
	type FileFailureRecoveryAuthority,
	fileRecoveryTarget,
	selectFileFailureRecoveryAuthority,
} from "./file-failure-recovery.ts";
import { decodeReadText, decodeTextChunks } from "./file-text-decoder.ts";
import { resolveReadPathAsync, resolveToCwd } from "./path-utils.ts";
import { type ReadLine, type ReadLineWindowDetails, readLineWindow } from "./read-line-window.ts";
import { getTextOutput, renderToolPath, replaceTabs, str } from "./render-utils.ts";
import { isPiSessionJsonlPath, projectPiSessionJsonlLine } from "./session-transcript-read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	encoding: Type.Optional(
		Type.String({
			description:
				"Known source encoding for legacy or BOM-less text. BOM-marked Unicode recovers automatically; never guess an unknown encoding.",
		}),
	),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	column: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Read a character window of one line, starting at this 1-based UTF-16 position. Use the returned nextColumn to continue; surrogate pairs stay intact. Use with offset, not tail, outline, or multiple-line limits.",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
	lineNumbers: Type.Optional(Type.Boolean({ description: "Include line numbers in the output" })),
	tail: Type.Optional(Type.Number({ description: "Number of lines to read from the end of the file" })),
	mode: Type.Optional(
		Type.Literal("outline", {
			description:
				"Return the file's outline instead of its text: one `line: declaration` row per function, class, type, method, heading (TypeScript/JavaScript, Python, Rust, Go, C#, PowerShell, shell, Markdown). Use it first on files over ~300 lines, then read the range you need with offset/limit.",
		}),
	),
	filter: Type.Optional(
		Type.Union([Type.Literal("none"), Type.Literal("minimal"), Type.Literal("aggressive")], {
			description: "Safe text filtering level (none, minimal, aggressive)",
		}),
	),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	lineWindow?: ReadLineWindowDetails;
	truncation?: TruncationResult;
	/** Present for `mode: "outline"`. */
	outline?: { language: string; entries: number; totalLines: number; headFallback: boolean };
}

interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set([
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
	"GEMINI.md",
	"GEMINI.MD",
]);

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
	/** File size in bytes, used to decide between whole-file and sliced reads. */
	stat?: (absolutePath: string) => Promise<{ size: number }>;
	/**
	 * Stream a slice of lines out of the file with bounded memory. Any region of an
	 * arbitrarily large file stays reachable in batches via offset continuation.
	 * Text-producing adapters must honor encoding/BOM and signal, never decode lossily.
	 */
	readLineSlice?: (absolutePath: string, options: LineSliceOptions) => Promise<LineSlice>;
	/** Count decoded lines using the same encoding and cancellation contract as readLineSlice. */
	countLines?: (absolutePath: string, options?: { encoding?: string; signal?: AbortSignal }) => Promise<number>;
}

export interface LineSliceOptions {
	/** Zero-based UTF-16 window position. */
	startColumn?: number;
	/** Maximum retained units per source line. The native adapter caps this at 16 MiB units. */
	maxLineChars?: number;
	/** Source encoding, shared by whole-file, outline, count, and sliced reads. */
	encoding?: string;
	signal?: AbortSignal;
	/** 0-based line to start collecting at. */
	startLine: number;
	/** Maximum number of lines to collect. */
	maxLines: number;
	/** Maximum total characters to collect across lines. */
	maxChars: number;
}

export interface LineSlice {
	lines: ReadLine[];
	/** True when the end of the file was reached while collecting. */
	reachedEnd: boolean;
}

const SLICE_SCAN_CHUNK_BYTES = 1024 * 1024;

async function scanLines(
	absolutePath: string,
	onLine: (line: StreamingLineRecord, index: number) => boolean,
	options?: { encoding?: string; signal?: AbortSignal; maxLineChars?: number; startColumn?: number },
): Promise<void> {
	const handle = await fsOpen(absolutePath, "r");
	try {
		const lineDecoder = new StreamingLineDecoder(
			Math.min(options?.maxLineChars ?? DEFAULT_MAX_BYTES + 1, 16 * 1024 * 1024),
			{
				lineEndings: "lf",
				overflow: "window",
				startColumn: options?.startColumn,
			},
		);
		async function* sourceChunks() {
			const buffer = Buffer.allocUnsafe(SLICE_SCAN_CHUNK_BYTES);
			while (!options?.signal?.aborted) {
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
				if (bytesRead === 0) return;
				yield buffer.subarray(0, bytesRead);
			}
			throw new Error("Operation aborted");
		}
		let index = 0;
		let emittedAnyLine = false;
		for await (const text of decodeTextChunks(sourceChunks(), options?.encoding, options?.signal)) {
			const lines = lineDecoder.pushRecords(text);
			for (const line of lines) {
				emittedAnyLine = true;
				if (!onLine(line, index++)) return;
			}
		}
		const finalLine = lineDecoder.finishRecord();
		if (finalLine !== undefined || !emittedAnyLine) {
			onLine(finalLine ?? { text: "", startColumn: 0, totalChars: 0 }, index);
		}
	} finally {
		await handle.close();
	}
}

async function readLocalLineSlice(absolutePath: string, options: LineSliceOptions): Promise<LineSlice> {
	const lines: ReadLine[] = [];
	let collectedChars = 0;
	let sawMore = false;
	await scanLines(
		absolutePath,
		(line, index) => {
			if (index < options.startLine) return true;
			if (lines.length >= options.maxLines || collectedChars > options.maxChars) {
				sawMore = true;
				return false;
			}
			const { text, startColumn, totalChars } = line;
			lines.push({
				text,
				originalIndex: index + 1,
				...(startColumn > 0 || text.length < totalChars ? { window: { startColumn, totalChars } } : {}),
			});
			collectedChars += text.length;
			return true;
		},
		{ ...options, maxLineChars: options?.maxLineChars ?? Math.min(options.maxChars, DEFAULT_MAX_BYTES + 1) },
	);
	return { lines, reachedEnd: !sawMore };
}

async function countLocalLines(
	absolutePath: string,
	options?: { encoding?: string; signal?: AbortSignal },
): Promise<number> {
	let count = 0;
	await scanLines(
		absolutePath,
		() => {
			count++;
			return true;
		},
		{ ...options, maxLineChars: 0 },
	);
	return count;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	stat: async (path) => ({ size: (await fsStat(path)).size }),
	readLineSlice: readLocalLineSlice,
	countLines: countLocalLines,
};

// Loading a whole file before truncation lets a single giant file spike the heap
// to its full size. Beyond these budgets, text reads stream line slices (every
// region stays reachable in batches — lossless). The image budget is deliberately
// far above any real screenshot/photo so quality-degrading workarounds are never
// needed in practice; it only guards against pathological files.
const DEFAULT_MAX_TEXT_READ_BYTES = 16 * 1024 * 1024;
/** An outline of an oversized file reads this much of its head. */
const OUTLINE_MAX_SOURCE_LINES = 50_000;
const OUTLINE_MAX_SOURCE_CHARS = 8 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_READ_BYTES = 128 * 1024 * 1024;

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
	/** Custom backend path dialect and home; omitted means native path semantics. */
	pathOptions?: Pick<PathInputOptions, "flavor" | "homeDir">;
	/** Shared backend identity for exact cross-tool recovery with custom operations. */
	failureRecoveryAuthority?: FileFailureRecoveryAuthority;
	/** Whole-file load budget for text reads; larger files stream line slices instead. Default 16 MiB. */
	maxTextReadBytes?: number;
	/** Pathology guard for image reads; larger images return downscale guidance. Default 128 MiB. */
	maxImageReadBytes?: number;
}

type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number };

function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatReadLineRange(args, theme)}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function splitContentLines(text: string): string[] {
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}

function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}

function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			formatReadLineRange(args, theme) +
			expandHint
		);
	}

	return (
		theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
		" " +
		theme.fg("accent", classification.label) +
		formatReadLineRange(args, theme) +
		expandHint
	);
}

function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	_cwd: string,
	isError: boolean,
): string {
	if (!options.expanded && !isError) {
		return "";
	}

	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result, showImages);
	const lang = !isError && rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	const pathOptions = Object.freeze({ ...options?.pathOptions, normalizeUnicodeSpaces: false, stripAtPrefix: false });
	if (
		!options?.operations &&
		options?.pathOptions?.flavor &&
		options.pathOptions.flavor !== (process.platform === "win32" ? "win32" : "posix")
	) {
		throw new Error("Non-native read path semantics require custom operations");
	}
	const failureRecoveryAuthority = selectFileFailureRecoveryAuthority(
		options?.operations !== undefined,
		options?.failureRecoveryAuthority,
	);
	const maxTextReadBytes = options?.maxTextReadBytes ?? DEFAULT_MAX_TEXT_READ_BYTES;
	const maxImageReadBytes = options?.maxImageReadBytes ?? DEFAULT_MAX_IMAGE_READ_BYTES;
	const configuredSessionDirectory = join(getAgentDir(), "sessions");
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete. For a file over ~300 lines start with mode="outline" (declarations with line numbers, a fraction of the size) and then read only the ranges you need. Batchable: emit alongside other independent calls in one message; never spend a turn per read.`,
		promptSnippet: "Read file contents",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		parameters: readSchema,
		failureRecovery: {
			getFailureTargets: (params, failure) =>
				failure.failureCode === "file_not_found" && failureRecoveryAuthority
					? [
							fileRecoveryTarget(
								failureRecoveryAuthority,
								FILE_EXISTS_RECOVERY_TARGET_KIND,
								params.path,
								cwd,
								pathOptions,
							),
						]
					: [],
			actions: failureRecoveryAuthority
				? [
						{
							kind: "correct",
							authority: failureRecoveryAuthority.contractAuthority,
							targetKind: FILE_CURRENT_TEXT_RECOVERY_TARGET_KIND,
							instruction:
								"Use read on the failed edit path to obtain current text, then submit a changed edit with exact current text.",
						},
					]
				: [],
		},
		async execute(
			_toolCallId,
			{
				path,
				encoding,
				offset,
				column,
				limit,
				mode,
				lineNumbers,
				tail,
				filter,
			}: {
				path: string;
				encoding?: string;
				offset?: number;
				column?: number;
				limit?: number;
				mode?: "outline";
				lineNumbers?: boolean;
				tail?: number;
				filter?: "none" | "minimal" | "aggressive";
			},
			signal?: AbortSignal,
			_onUpdate?,
			ctx?,
		) {
			if (
				column !== undefined &&
				(!Number.isSafeInteger(column) ||
					column < 1 ||
					mode !== undefined ||
					tail !== undefined ||
					(limit !== undefined && limit !== 1))
			) {
				throw new Error(
					"column requires a positive integer and a single-line read using offset; omit outline/tail and use limit=1.",
				);
			}
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const absolutePath = await resolveReadPathAsync(
								path,
								cwd,
								(candidate) => ops.access(candidate),
								pathOptions,
								signal,
							);
							if (aborted) return;
							const projectSessionTranscript = isPiSessionJsonlPath(absolutePath, configuredSessionDirectory);
							if (column !== undefined && projectSessionTranscript)
								throw new Error(
									"Session transcripts expose projected labels, not raw character windows. Use read with offset and limit, without column.",
								);
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							const fileSize = ops.stat ? (await ops.stat(absolutePath)).size : undefined;
							if (aborted) return;
							if (mimeType) {
								if (fileSize !== undefined && fileSize > maxImageReadBytes) {
									signal?.removeEventListener("abort", onAbort);
									resolve({
										content: [
											{
												type: "text",
												text: `Image file is ${formatSize(fileSize)} (${formatSize(maxImageReadBytes)} inline decode limit). Downscale it first, e.g. with bash (ImageMagick: magick "${path}" -resize 2000x2000 "${join(getProcessWorkRun(getAgentDir(), "images", "previews").path, "preview.png")}") and read the result.`,
											},
										],
										details: undefined,
									});
									return;
								}
								// Read image as binary.
								const buffer = await ops.readFile(absolutePath);
								if (autoResizeImages) {
									// Resize image if needed before sending it back to the model.
									const resized = await resizeImage(buffer, mimeType);
									if (!resized) {
										let textNote = `Read image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]`;
										if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
										content = [{ type: "text", text: textNote }];
									} else {
										const dimensionNote = formatDimensionNote(resized);
										let textNote = `Read image file [${resized.mimeType}]`;
										if (dimensionNote) textNote += `\n${dimensionNote}`;
										if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
										content = [
											{ type: "text", text: textNote },
											{ type: "image", data: resized.data, mimeType: resized.mimeType },
										];
									}
								} else {
									let textNote = `Read image file [${mimeType}]`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: buffer.toString("base64"), mimeType },
									];
								}
							} else if (mode === "outline" && !projectSessionTranscript) {
								// Orientation instead of paging: the declarations with their line numbers, so the
								// next read is the range the model needs. Verbatim reads are untouched.
								const outlineSlice =
									fileSize !== undefined && fileSize > maxTextReadBytes && ops.readLineSlice !== undefined
										? await ops.readLineSlice(absolutePath, {
												startLine: 0,
												maxLines: OUTLINE_MAX_SOURCE_LINES,
												maxChars: OUTLINE_MAX_SOURCE_CHARS,
												encoding,
												signal,
											})
										: undefined;
								const outlineText = outlineSlice
									? outlineSlice.lines.map((item) => (item.window ? "" : item.text)).join("\n")
									: await decodeReadText(await ops.readFile(absolutePath), encoding, signal);
								const outline = buildCodeOutline(path, outlineText);
								content = [{ type: "text", text: renderCodeOutline(path, outline) }];
								const omittedLine = outlineSlice?.lines.find((item) => item.window);
								if (omittedLine)
									content.push({
										type: "text",
										text: `[Oversized source lines omitted from outline. Use read offset=${omittedLine.originalIndex} column=1 to inspect the first omitted line.]`,
									});
								details = {
									outline: {
										language: outline.language,
										entries: outline.entries.length,
										totalLines: outline.totalLines,
										headFallback: outline.headFallback,
									},
								};
							} else {
								// Read text content. Oversized files are streamed as line slices so
								// any region stays reachable in batches without loading the whole file.
								const useSlicedRead =
									ops.readLineSlice !== undefined &&
									(column !== undefined || (fileSize !== undefined && fileSize > maxTextReadBytes));
								let startLine = 0;
								let userLimitedLines = column !== undefined ? 1 : limit;
								let totalFileLines: number | undefined;
								let moreContentRemains = false;
								let textContentForJsonCheck: string | undefined;
								let slicedLines: ReadLine[];
								if (useSlicedRead && ops.readLineSlice) {
									if (offset !== undefined) {
										startLine = Math.max(0, offset - 1);
									} else if (tail !== undefined) {
										const counted = ops.countLines
											? await ops.countLines(absolutePath, { encoding, signal })
											: undefined;
										if (counted !== undefined) {
											totalFileLines = counted;
											startLine = Math.max(0, counted - tail);
										}
										if (limit === undefined) {
											userLimitedLines = tail;
										}
									}
									const slice = await ops.readLineSlice(absolutePath, {
										startColumn: column !== undefined ? column - 1 : undefined,
										maxLineChars: projectSessionTranscript ? DEFAULT_MAX_TEXT_READ_BYTES : undefined,
										startLine,
										maxLines: userLimitedLines ?? DEFAULT_MAX_LINES,
										maxChars: DEFAULT_MAX_BYTES * 4,
										encoding,
										signal,
									});
									if (slice.lines.length === 0 && startLine > 0) {
										throw new Error(`Offset ${startLine + 1} is beyond end of file`);
									}
									slicedLines = slice.lines;
									moreContentRemains = !slice.reachedEnd;
								} else {
									const buffer = await ops.readFile(absolutePath);
									const textContent = await decodeReadText(buffer, encoding, signal);
									textContentForJsonCheck = textContent;
									const allLines = splitContentLines(textContent);
									totalFileLines = allLines.length;
									// Apply offset/tail if specified. Convert from 1-indexed input to 0-indexed array access.
									if (offset !== undefined) {
										startLine = Math.max(0, offset - 1);
									} else if (tail !== undefined) {
										startLine = Math.max(0, totalFileLines - tail);
										if (limit === undefined) {
											userLimitedLines = tail;
										}
									}
									// Check if offset is out of bounds.
									if (startLine >= allLines.length && allLines.length > 0) {
										throw new Error(
											`Offset ${startLine + 1} is beyond end of file (${allLines.length} lines total)`,
										);
									}
									slicedLines =
										userLimitedLines !== undefined
											? allLines
													.map((line, idx) => ({ text: line, originalIndex: idx + 1 }))
													.slice(startLine, startLine + userLimitedLines)
											: allLines
													.map((line, idx) => ({ text: line, originalIndex: idx + 1 }))
													.slice(startLine);
									moreContentRemains =
										userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length;
								}
								const startLineDisplay = startLine + 1;
								if (projectSessionTranscript) {
									slicedLines = slicedLines.map((item) => ({
										text: item.window
											? "[Oversized session record omitted from bounded projection; raw payload withheld.]"
											: projectPiSessionJsonlLine(item.text),
										originalIndex: item.originalIndex,
									}));
								}
								const firstSelectedLine = slicedLines[0];
								if (
									!projectSessionTranscript &&
									firstSelectedLine &&
									(column !== undefined ||
										firstSelectedLine.window ||
										Buffer.byteLength(firstSelectedLine.text) > DEFAULT_MAX_BYTES - 64)
								) {
									const window = readLineWindow(firstSelectedLine, column);
									signal?.removeEventListener("abort", onAbort);
									if (!aborted)
										resolve({
											content: [{ type: "text", text: window.text }],
											details: { lineWindow: window.lineWindow },
										});
									return;
								}

								// Safe text filtering
								let canFilter = !projectSessionTranscript;
								if (mimeType) {
									canFilter = false;
								} else {
									const fileNameLower = path.toLowerCase();
									const unsafeExtensions = [
										".json",
										".jsonl",
										".yml",
										".yaml",
										".toml",
										".xml",
										".csv",
										".tsv",
									];
									if (unsafeExtensions.some((ext) => fileNameLower.endsWith(ext))) {
										canFilter = false;
									} else if (textContentForJsonCheck !== undefined) {
										try {
											JSON.parse(textContentForJsonCheck);
											canFilter = false;
										} catch {}
									}
								}

								if (canFilter && filter && filter !== "none") {
									const filtered: typeof slicedLines = [];
									if (filter === "minimal") {
										let consecutiveBlank = 0;
										for (const item of slicedLines) {
											const trimmed = item.text.trimEnd();
											if (trimmed === "") {
												consecutiveBlank++;
												if (consecutiveBlank <= 1) {
													filtered.push({ text: "", originalIndex: item.originalIndex });
												}
											} else {
												consecutiveBlank = 0;
												filtered.push({ text: trimmed, originalIndex: item.originalIndex });
											}
										}
										while (filtered.length > 0 && filtered[filtered.length - 1].text === "") {
											filtered.pop();
										}
									} else if (filter === "aggressive") {
										for (const item of slicedLines) {
											const trimmed = item.text.trimEnd();
											const trimmedStart = trimmed.trimStart();
											if (trimmedStart === "") {
												continue;
											}
											if (
												trimmedStart.startsWith("//") ||
												trimmedStart.startsWith("#") ||
												(trimmedStart.startsWith("/*") && trimmedStart.endsWith("*/"))
											) {
												continue;
											}
											filtered.push({ text: trimmed, originalIndex: item.originalIndex });
										}
									}

									// If filtering would empty a non-empty list, keep original
									const isOriginalNotEmpty = slicedLines.some((item) => item.text.trim().length > 0);
									const isFilteredEmpty = filtered.every((item) => item.text.trim().length === 0);
									if (isOriginalNotEmpty && isFilteredEmpty) {
										// Fallback to slicedLines
									} else {
										slicedLines = filtered;
									}
								}

								const finalLines = slicedLines.map((item) =>
									lineNumbers ? `${item.originalIndex}: ${item.text}` : item.text,
								);
								const selectedContent = finalLines.join("\n");

								// Apply truncation, respecting both line and byte limits.
								const truncation = truncateHead(selectedContent);
								let outputText: string;
								const totalDisplay =
									totalFileLines !== undefined
										? String(totalFileLines)
										: `a ${fileSize !== undefined ? formatSize(fileSize) : "large"} file`;
								if (truncation.firstLineExceedsLimit) {
									const window = readLineWindow(slicedLines[0]);
									outputText = window.text;
									details = { lineWindow: window.lineWindow };
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice.
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									outputText = truncation.content;
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalDisplay}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalDisplay} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation };
								} else if (moreContentRemains) {
									// More content exists beyond this slice; hand the model a continuation pointer.
									const nextOffset = startLine + slicedLines.length + 1;
									const remaining =
										totalFileLines !== undefined && userLimitedLines !== undefined
											? `${totalFileLines - (startLine + userLimitedLines)} more lines in file`
											: "More content remains";
									outputText = `${truncation.content}\n\n[${remaining}. Use offset=${nextOffset} to continue.]`;
								} else {
									// No truncation and no remaining content.
									outputText = truncation.content;
								}
								if (projectSessionTranscript) {
									outputText = `Pi session transcript (user/assistant/summary/tool labels only; thinking and payloads omitted).\n${outputText}`;
								}
								content = [{ type: "text", text: outputText }];
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: unknown) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
			text.setText(
				classification
					? formatCompactReadCall(classification, args, theme)
					: formatReadCall(args, theme, context.cwd),
			);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatReadResult(context.args, result, options, theme, context.showImages, context.cwd, context.isError),
			);
			return text;
		},
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
