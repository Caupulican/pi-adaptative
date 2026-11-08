import { Type } from "typebox";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { ASSIGN_TOOL_NAME } from "./assign-tool-name.ts";

const schema = Type.Object(
	{
		task: Type.String({
			minLength: 1,
			description: "What the worker must do, in plain words, with the file paths it needs.",
		}),
		files: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				maxItems: 64,
				description:
					"Files or folders the worker may change. Leave out for read-only work (search, review, answer).",
			}),
		),
		deep: Type.Optional(
			Type.Boolean({ description: "A hard problem that needs more thinking. Leave out for ordinary work." }),
		),
	},
	{ additionalProperties: false },
);

/**
 * The one call that hands work to a worker. Everything else is the harness's: the worker's model comes from the owner's
 * worker profile (a hard task raises only the thinking), its tools and write scope from the files named, its place in the
 * queue from the fleet's room, and its result comes back as an event. It starts the same worker the `delegate` tool's
 * `start` does, with the host's defaults filled in.
 */
export function createAssignToolDefinition(delegate: ToolDefinition): ToolDefinition<typeof schema> {
	return {
		name: ASSIGN_TOOL_NAME,
		label: "Assign",
		description:
			"Hand a task to a worker: assign {task, files?, deep?}. The harness picks the worker's model (the owner's worker profile), tools, write scope (the files you name) and queue slot, and its result arrives as an event, so carry on with other work. Use deep only for a hard problem. Starting several independent tasks in one turn runs them in parallel. Use delegate only to follow up on, wait for or inspect workers.",
		promptSnippet: "Hand work to a worker (task, files, deep)",
		parameters: schema,
		async execute(toolCallId, input, signal, onUpdate, ctx) {
			const files = input.files?.filter((file) => file.trim().length > 0);
			harnessLog.info("delegation", "work was assigned", {
				taskChars: input.task.length,
				files: files?.length ?? 0,
				deep: input.deep === true,
			});
			return delegate.execute(
				toolCallId,
				{
					action: "start",
					instructions: input.task,
					...(files && files.length > 0 ? { writePaths: files } : { readOnly: true }),
					...(input.deep === true ? { thinkingLevel: "high" } : {}),
				},
				signal,
				onUpdate,
				ctx,
			);
		},
	};
}
