import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { TaskDirectoryRuntime } from "../tasks/task-directory-runtime.ts";
import { resolveTaskStepSelector, type TaskStepsState } from "../tasks/task-state.ts";

const identity = Type.String({ minLength: 1, maxLength: 200 });
const path = Type.String({ minLength: 1, maxLength: 4096 });
const schema = Type.Union([
	Type.Object({ action: Type.Literal("status") }, { additionalProperties: false }),
	Type.Object(
		{ action: Type.Union([Type.Literal("register"), Type.Literal("reattach")]), workspaceId: identity, path },
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("select"), workspaceId: identity }, { additionalProperties: false }),
	Type.Object(
		{
			action: Type.Literal("bind"),
			taskId: identity,
			pinned: Type.Boolean(),
			workspaceId: Type.Optional(identity),
			path: Type.Optional(path),
		},
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("forget"), taskId: identity }, { additionalProperties: false }),
]);

/** Directory commands own bindings only; task_steps remains the sole task identity and active cursor. */
export function createTaskDirectoryToolDefinition(
	runtime: TaskDirectoryRuntime,
	getSteps: () => TaskStepsState | undefined,
): ToolDefinition<typeof schema> {
	return {
		name: "task_directory",
		label: "Task directory",
		description:
			"Manage persistent working directories. Register a workspace with an absolute native path, select the workspace followed by unpinned tasks, and bind a task_steps id with explicit pinned true/false. Use task_steps to activate a task. Reattach a moved or foreign-host workspace explicitly. Status shows the effective context. A directory binding never expands file authority.",
		promptSnippet: "Register/select workspaces and explicitly pin or unpin task working directories.",
		promptGuidelines: [
			"Use task_directory to retain project directories; do not rely on shell cd between calls.",
			"Pin tasks that must stay in one project. Unpinned tasks follow workspace selection. task_steps owns the active task.",
		],
		parameters: schema,
		executionMode: "sequential",
		async execute(_id, input: Static<typeof schema>, signal) {
			if (input.action === "register" || input.action === "reattach") {
				await runtime.change(input, signal);
			} else if (input.action === "select" || input.action === "forget") {
				// A cleared/compacted checklist must not prevent removal of its saved binding by exact id.
				await runtime.change(input, signal);
			} else if (input.action === "bind") {
				const task = resolveTaskStepSelector(getSteps()?.steps ?? [], input.taskId);
				await runtime.change({ ...input, taskId: task.id }, signal);
			}
			const { state, activeTaskId, effective, unavailable } = await runtime.getStatus(signal);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({ activeTaskId, effective, unavailable, ...state }),
					},
				],
				details: { state, effective, unavailable },
			};
		},
	};
}
