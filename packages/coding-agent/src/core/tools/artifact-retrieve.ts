import type { AgentTool } from "@caupulican/pi-agent-core";
import { formatSize } from "@caupulican/pi-agent-core/truncate";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import {
	type ArtifactRetrievalMode,
	type ArtifactSlice,
	type ContextOriginalMetadata,
	DEFAULT_RETRIEVAL_MAX_LINES,
	readContextOriginal,
	retrieveArtifactSlice,
	sliceText,
} from "../context/artifact-retrieval.ts";
import type { ArtifactStore } from "../context/context-artifacts.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { classifyToolTrust, wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { invalidArgText, renderBoundedTextResult, renderTextComponent, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const ARTIFACT_ID_PREFIX = "tool-output:";
/** A context-GC packed stub names its original as `context:<key>`. */
export const CONTEXT_ID_PREFIX = "context:";

const artifactRetrieveSchema = Type.Object({
	artifactId: Type.String({
		description:
			"Id from a prior result: 'tool-output:<id>' from a 'Full output: artifact' reference (prefix optional), or 'context:<key>' from a context-GC packed stub.",
	}),
	mode: Type.Optional(
		Type.Union([Type.Literal("metadata"), Type.Literal("head"), Type.Literal("tail"), Type.Literal("offset")], {
			description:
				"'metadata' for tool/path/size info only (no content); 'head' (default) for the first lines; 'tail' for the last lines; 'offset' for the lines starting at `offset`.",
		}),
	),
	maxLines: Type.Optional(
		Type.Number({ description: `Maximum lines to return for a slice (default: ${DEFAULT_RETRIEVAL_MAX_LINES})` }),
	),
	offset: Type.Optional(Type.Number({ description: "For mode 'offset': the 1-based line the slice starts at." })),
});

export type ArtifactRetrieveToolInput = Static<typeof artifactRetrieveSchema>;

export interface ArtifactRetrieveToolDetails {
	found: boolean;
	mode: ArtifactRetrievalMode;
	/** The context-GC key this result sliced: a later pack of this result points at the same original. */
	retrievedKey?: string;
}

export interface ArtifactRetrieveToolOptions {
	/** Session-scoped artifact store to resolve ids against. Omitted: the tool reports unavailable. */
	artifactStore?: ArtifactStore;
	/** The owning session's context-GC store, where `context:<key>` originals live. */
	getContextStoreDir?: () => string | undefined;
}

function normalizeArtifactId(input: string): string {
	return input.startsWith(ARTIFACT_ID_PREFIX) ? input.slice(ARTIFACT_ID_PREFIX.length) : input;
}

function formatMetadataText(ref: {
	kind: string;
	toolName?: string;
	command?: string;
	path?: string;
	byteLength: number;
	lineCount?: number;
	reproducible: boolean;
}): string {
	const lines = [
		`kind: ${ref.kind}`,
		ref.toolName ? `tool: ${ref.toolName}` : undefined,
		ref.command ? `command: ${ref.command}` : undefined,
		ref.path ? `path: ${ref.path}` : undefined,
		`size: ${formatSize(ref.byteLength)}`,
		ref.lineCount !== undefined ? `lines: ${ref.lineCount}` : undefined,
		`reproducible: ${ref.reproducible}`,
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
}

function formatContextMetadataText(key: string, text: string, metadata: ContextOriginalMetadata | undefined): string {
	const lines = [
		`kind: context-gc original`,
		`key: ${key}`,
		metadata ? `tool: ${metadata.tool}` : undefined,
		metadata?.command ? `command: ${metadata.command}` : undefined,
		metadata?.path ? `path: ${metadata.path}` : undefined,
		metadata ? `packed because: ${metadata.reason}` : undefined,
		`size: ${formatSize(Buffer.byteLength(text, "utf8"))}`,
		`lines: ${text.split("\n").length}`,
	];
	return lines.filter((line): line is string => line !== undefined).join("\n");
}

/** The slice text with its bounds stated, so a model knows what it has and how to get the rest. */
function describeSlice(slice: ArtifactSlice, size: string): string {
	if (!slice.truncation.truncated && slice.mode !== "offset") return slice.slice;
	const where =
		slice.mode === "offset"
			? `lines ${slice.startLine} to ${(slice.startLine ?? 1) + slice.truncation.outputLines - 1}`
			: `${slice.mode} ${slice.truncation.outputLines}`;
	return `${slice.slice}\n\n[Showing ${where} of ${slice.truncation.totalLines} lines. Full artifact: ${size}. Retrieve again with a different mode/maxLines/offset for another slice.]`;
}

/** The original tool's trust carries through storage: unknown provenance is not a trust grant. */
function wrapForTool(text: string, toolName: string | undefined): string {
	return !toolName || classifyToolTrust(toolName) === "untrusted"
		? wrapUntrustedText(text, `artifact:${toolName ?? "unknown"}`)
		: text;
}

function formatCall(args: { artifactId: string; mode?: string } | undefined, theme: Theme): string {
	const artifactId = str(args?.artifactId);
	const mode = args?.mode ?? "head";
	const idText = artifactId === null ? invalidArgText(theme) : theme.fg("accent", artifactId);
	return `${theme.fg("toolTitle", theme.bold("artifact_retrieve"))} ${idText}${theme.fg("toolOutput", ` (${mode})`)}`;
}

export function createArtifactRetrieveToolDefinition(
	_cwd: string,
	options?: ArtifactRetrieveToolOptions,
): ToolDefinition<typeof artifactRetrieveSchema, ArtifactRetrieveToolDetails | undefined> {
	const artifactStore = options?.artifactStore;
	return {
		name: "artifact_retrieve",
		label: "artifact_retrieve",
		readOnly: true,
		description:
			"Retrieve a bounded slice of a stored original by id: a packed tool-output artifact ('Full output: artifact tool-output:<id>') or a context-GC packed result ('artifact_retrieve context:<key>'). Returns metadata, or a bounded head/tail/offset slice -- never the full raw payload in one call.",
		promptSnippet: "Retrieve a bounded slice of a packed tool-output artifact",
		parameters: artifactRetrieveSchema,
		async execute(
			_toolCallId,
			{
				artifactId,
				mode,
				maxLines,
				offset,
			}: { artifactId: string; mode?: ArtifactRetrievalMode; maxLines?: number; offset?: number },
		) {
			const effectiveMode = mode ?? "head";
			if (artifactId.startsWith(CONTEXT_ID_PREFIX)) {
				const key = artifactId.slice(CONTEXT_ID_PREFIX.length);
				const gcDir = options?.getContextStoreDir?.();
				if (!gcDir) {
					return {
						content: [{ type: "text", text: "No context store is configured for this session." }],
						details: { found: false, mode: effectiveMode },
					};
				}
				const original = readContextOriginal(gcDir, key);
				if (!original.found) {
					return {
						content: [
							{
								type: "text",
								text:
									original.reason === "invalid_key"
										? `Invalid context key: ${artifactId}. A context key is exactly 24 hex characters, as a packed stub names it.`
										: `Context original expired: ${artifactId}. The session's store reclaimed it. Rerun the command the stub names, or read the current file at its path.`,
							},
						],
						details: { found: false, mode: effectiveMode },
					};
				}
				const text =
					effectiveMode === "metadata"
						? formatContextMetadataText(key, original.text, original.metadata)
						: describeSlice(
								sliceText(original.text, { mode: effectiveMode, maxLines, offset }),
								formatSize(Buffer.byteLength(original.text, "utf8")),
							);
				return {
					content: [{ type: "text", text: wrapForTool(text, original.metadata?.tool) }],
					details: { found: true, mode: effectiveMode, retrievedKey: key },
				};
			}
			if (!artifactStore) {
				return {
					content: [{ type: "text", text: "No artifact store is configured for this session." }],
					details: { found: false, mode: effectiveMode },
				};
			}

			const result = retrieveArtifactSlice(artifactStore, {
				artifactId: normalizeArtifactId(artifactId),
				mode,
				maxLines,
				offset,
			});

			if (!result.found) {
				return {
					content: [
						{
							type: "text",
							text:
								result.missingReason === "unavailable"
									? `Artifact could not be read: ${artifactId}. Storage is inaccessible or the record is incomplete or corrupt.`
									: `Artifact not found: ${artifactId} (${result.missingReason}). It may have been cleaned up, or the id may be incorrect.`,
						},
					],
					details: { found: false, mode: effectiveMode },
				};
			}

			const text =
				result.mode === "metadata"
					? formatMetadataText(result.ref)
					: describeSlice(result, formatSize(result.ref.byteLength));
			// Storage does not promote external evidence into trusted instructions. Use the same
			// classifier as direct tool results; unknown provenance is not a trust grant.
			return {
				content: [{ type: "text", text: wrapForTool(text, result.ref.toolName) }],
				details: { found: true, mode: result.mode },
			};
		},
		renderCall(args, theme, context) {
			return renderTextComponent(context.lastComponent, formatCall(args, theme));
		},
		renderResult(result, options, theme, context) {
			return renderBoundedTextResult(result, options.expanded, theme, context.lastComponent, 20);
		},
	};
}

export function createArtifactRetrieveTool(
	cwd: string,
	options?: ArtifactRetrieveToolOptions,
): AgentTool<typeof artifactRetrieveSchema> {
	return wrapToolDefinition(createArtifactRetrieveToolDefinition(cwd, options));
}
