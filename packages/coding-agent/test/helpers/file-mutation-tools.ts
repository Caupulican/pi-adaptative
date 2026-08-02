import type { createEditTool } from "../../src/core/tools/edit.ts";
import type { createWriteTool } from "../../src/core/tools/write.ts";

interface PreparedMutationDetails {
	intentId?: string;
}

export interface PreparedEditInput {
	path: string;
	edits: Array<{ oldText: string; newText: string }>;
}

export interface PreparedWriteInput {
	path: string;
	content: string;
}

type EditTool = ReturnType<typeof createEditTool>;
type WriteTool = ReturnType<typeof createWriteTool>;

function requireIntentId(details: PreparedMutationDetails | undefined): string {
	if (!details?.intentId) throw new Error("Expected file mutation preparation to return an intent id.");
	return details.intentId;
}

/** Adapt behavior-focused legacy tests onto the model-facing prepare/commit protocol. */
export function withPreparedEdit(tool: EditTool): {
	execute(toolCallId: string, input: PreparedEditInput, signal?: AbortSignal): ReturnType<EditTool["execute"]>;
} {
	return {
		async execute(toolCallId, input, signal) {
			const prepared = await tool.execute(`${toolCallId}:prepare`, { action: "prepare", path: input.path }, signal);
			return tool.execute(
				toolCallId,
				{
					action: "commit",
					path: input.path,
					intentId: requireIntentId(prepared.details),
					edits: input.edits,
				},
				signal,
			);
		},
	};
}

/** Adapt behavior-focused legacy tests onto the model-facing prepare/commit protocol. */
export function withPreparedWrite(tool: WriteTool): {
	execute(toolCallId: string, input: PreparedWriteInput, signal?: AbortSignal): ReturnType<WriteTool["execute"]>;
} {
	return {
		async execute(toolCallId, input, signal) {
			const prepared = await tool.execute(`${toolCallId}:prepare`, { action: "prepare", path: input.path }, signal);
			return tool.execute(
				toolCallId,
				{
					action: "commit",
					path: input.path,
					intentId: requireIntentId(prepared.details),
					content: input.content,
				},
				signal,
			);
		},
	};
}
