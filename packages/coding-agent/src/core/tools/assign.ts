import { Type } from "typebox";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { AgentToolResult } from "../../kernel/types.ts";
import { renderCommsErrView } from "../comms/comms-records.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { ASSIGN_TOOL_NAME } from "./assign-tool-name.ts";
import { type DelegateErrRecord, type DelegateRemedy, renderDelegateRemedyLines } from "./delegate-rejections.ts";

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

/** The `delegate start` field each assign field becomes; a refusal of one is reported on the assign field. */
const ASSIGN_FIELD_OF: Readonly<Record<string, string>> = {
	instructions: "task",
	writePaths: "files",
	readOnly: "files",
	thinkingLevel: "deep",
};

const ASSIGN_SCHEMA_FRAGMENT = `${ASSIGN_TOOL_NAME} required: task; optional: files, deep; minimal call {"task":"<task>"}`;

function assignField(field: string): string {
	return ASSIGN_FIELD_OF[field] ?? field;
}

/** A delegate remedy restated on assign's own fields; a patch member assign has no field for is left out. */
function assignRemedy(remedy: DelegateRemedy): DelegateRemedy {
	const patch = remedy.patch
		? Object.fromEntries(
				Object.entries(remedy.patch)
					.filter(([field]) => field in ASSIGN_FIELD_OF)
					.map(([field, value]) => [assignField(field), value]),
			)
		: undefined;
	return {
		kind: remedy.kind,
		field: assignField(remedy.field),
		...(patch && Object.keys(patch).length > 0 ? { patch } : {}),
	};
}

/**
 * An input refusal of the `delegate start` an assign call became, restated for assign: its field, hint value,
 * remedies and schema fragment name assign's fields, so the repair the model reads is one it can send to assign.
 */
function assignRefusal(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
	const details = result.details as { err?: DelegateErrRecord } | undefined;
	const err = details?.err;
	if (!err || (err.s === undefined && err.r === undefined)) return result;
	const restated: DelegateErrRecord = {
		...err,
		...(err.f ? { f: assignField(err.f) } : {}),
		...(err.x ? { x: assignField(err.x) } : {}),
		s: ASSIGN_SCHEMA_FRAGMENT,
		...(err.r ? { r: err.r.map(assignRemedy) } : {}),
	};
	return {
		...result,
		content: [
			{ type: "text", text: [renderCommsErrView(restated), ...renderDelegateRemedyLines(restated)].join("\n") },
		],
		details: { ...details, err: restated },
	};
}

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
		neverDefer: true,
		parameters: schema,
		// As for delegate: the refusal view reaches the model as the failure record's evidence.
		failureRecovery: { getFailureEvidence: (_params, failure) => failure.message },
		async execute(toolCallId, input, signal, onUpdate, ctx) {
			const files = input.files?.filter((file) => file.trim().length > 0);
			harnessLog.info("delegation", "work was assigned", {
				taskChars: input.task.length,
				files: files?.length ?? 0,
				deep: input.deep === true,
			});
			const result = await delegate.execute(
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
			return result.isError ? assignRefusal(result) : result;
		},
	};
}
