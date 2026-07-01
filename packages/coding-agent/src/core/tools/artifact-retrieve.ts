import type { AgentTool } from "@caupulican/pi-agent-core";
import { Text } from "@caupulican/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import {
	type ArtifactRetrievalMode,
	DEFAULT_RETRIEVAL_MAX_LINES,
	retrieveArtifactSlice,
} from "../context/artifact-retrieval.ts";
import type { ArtifactStore } from "../context/context-artifacts.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { formatSize } from "./truncate.ts";

const ARTIFACT_ID_PREFIX = "tool-output:";

const artifactRetrieveSchema = Type.Object({
	artifactId: Type.String({
		description:
			"Artifact id from a 'Full output: artifact tool-output:<id>' reference in a prior tool result. The 'tool-output:' prefix is optional.",
	}),
	mode: Type.Optional(
		Type.Union([Type.Literal("metadata"), Type.Literal("head"), Type.Literal("tail")], {
			description:
				"'metadata' for tool/path/size info only (no content); 'head' (default) for the first lines; 'tail' for the last lines.",
		}),
	),
	maxLines: Type.Optional(
		Type.Number({ description: `Maximum lines to return for head/tail (default: ${DEFAULT_RETRIEVAL_MAX_LINES})` }),
	),
});

export type ArtifactRetrieveToolInput = Static<typeof artifactRetrieveSchema>;

export interface ArtifactRetrieveToolDetails {
	found: boolean;
	mode: ArtifactRetrievalMode;
}

export interface ArtifactRetrieveToolOptions {
	/** Session-scoped artifact store to resolve ids against. Omitted: the tool reports unavailable. */
	artifactStore?: ArtifactStore;
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
		description:
			"Retrieve a bounded slice of a packed tool-output artifact by id, from a 'Full output: artifact tool-output:<id>' reference in a prior tool result. Returns metadata, or a bounded head/tail slice -- never the full raw payload in one call.",
		promptSnippet: "Retrieve a bounded slice of a packed tool-output artifact",
		parameters: artifactRetrieveSchema,
		toolGroup: "explore",
		async execute(
			_toolCallId,
			{ artifactId, mode, maxLines }: { artifactId: string; mode?: ArtifactRetrievalMode; maxLines?: number },
		) {
			const effectiveMode = mode ?? "head";
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
			});

			if (!result.found) {
				return {
					content: [
						{
							type: "text",
							text: `Artifact not found: ${artifactId} (${result.missingReason}). It may have been cleaned up, or the id may be incorrect.`,
						},
					],
					details: { found: false, mode: effectiveMode },
				};
			}

			if (result.mode === "metadata") {
				return {
					content: [{ type: "text", text: formatMetadataText(result.ref) }],
					details: { found: true, mode: "metadata" },
				};
			}

			let text = result.slice;
			if (result.truncation.truncated) {
				text += `\n\n[Showing ${result.mode} ${result.truncation.outputLines} of ${result.truncation.totalLines} lines. Full artifact: ${formatSize(result.ref.byteLength)}. Retrieve again with a different mode/maxLines for another slice.]`;
			}
			return {
				content: [{ type: "text", text }],
				details: { found: true, mode: result.mode },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const content = result.content.find((part) => part.type === "text");
			const body = content && "text" in content ? content.text : "";
			const lines = body.split("\n");
			const maxLines = options.expanded ? lines.length : 20;
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;
			let rendered = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
			if (remaining > 0) rendered += `\n${theme.fg("muted", `... (${remaining} more lines)`)}`;
			text.setText(rendered);
			return text;
		},
	};
}

export function createArtifactRetrieveTool(
	cwd: string,
	options?: ArtifactRetrieveToolOptions,
): AgentTool<typeof artifactRetrieveSchema> {
	return wrapToolDefinition(createArtifactRetrieveToolDefinition(cwd, options));
}
