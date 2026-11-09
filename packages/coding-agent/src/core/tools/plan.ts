import { Type } from "typebox";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { AgentToolResult } from "../../kernel/types.ts";
import { MAX_TASK_DONE_CHARS, MAX_TASK_OUT_OF_SCOPE, MAX_TASK_OUT_OF_SCOPE_CHARS } from "../comms/comms-records.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { PlanExecutorPort } from "../plan/plan-executor-port.ts";
import { PLAN_LIMITS, PLAN_NODE_ID_PATTERN, PLAN_OFFERED_JOIN_KINDS } from "../plan/plan-graph.ts";
import { PLAN_TOOL_NAME } from "./plan-tool-name.ts";

/** The join kinds a step may use, as one list for the schema and the texts. */
const JOIN_KIND_LIST = PLAN_OFFERED_JOIN_KINDS.join(", ");

const stepIds = (description: string) =>
	Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: PLAN_LIMITS.idChars }), {
			maxItems: PLAN_LIMITS.edgeEntries,
			description,
		}),
	);

const step = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: PLAN_LIMITS.idChars, pattern: PLAN_NODE_ID_PATTERN.source }),
		do: Type.String({
			minLength: 1,
			maxLength: PLAN_LIMITS.intentChars,
			description: "What this step must do, in plain words, with the file paths it needs.",
		}),
		files: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				maxItems: PLAN_LIMITS.writeScopeEntries,
				description: "Files or folders this step may change. Leave out for read-only work.",
			}),
		),
		uses: stepIds("Steps whose results this step needs; it starts after them and receives their results."),
		after: stepIds("Steps that must finish first, without passing results."),
		req: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				maxItems: PLAN_LIMITS.requirementEntries,
				description: "Goal requirement ids this step proves.",
			}),
		),
		deep: Type.Optional(Type.Boolean({ description: "A hard step that needs more thinking." })),
		join: Type.Optional(
			Type.Union(
				PLAN_OFFERED_JOIN_KINDS.map((kind) => Type.Literal(kind)),
				{
					description: `Makes this step combine the steps in uses (${JOIN_KIND_LIST}): collect results, reduce findings to one answer, vote for the best, race for the first accepted, or verify independently.`,
				},
			),
		),
		question: Type.Optional(
			Type.String({
				maxLength: PLAN_LIMITS.criterionChars,
				description: "reduce: the question the combined answer answers; vote: what the winner must meet.",
			}),
		),
		by: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: PLAN_LIMITS.pinChars,
				description: "Optional: prefer this bot, leader or machine to run this step. Leave out for a worker.",
			}),
		),
		doneWhen: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: MAX_TASK_DONE_CHARS,
				description: "What makes this step done, in one line. Its result's proof sheet repeats it.",
			}),
		),
		outOfScope: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: MAX_TASK_OUT_OF_SCOPE_CHARS }), {
				maxItems: MAX_TASK_OUT_OF_SCOPE,
				description: "What this step must not touch or decide, one line each.",
			}),
		),
	},
	{ additionalProperties: false },
);

const schema = Type.Object(
	{
		action: Type.Union([Type.Literal("start"), Type.Literal("revise"), Type.Literal("cancel")]),
		title: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: PLAN_LIMITS.titleChars,
				description: "start: the plan in plain words, shown to the owner.",
			}),
		),
		steps: Type.Optional(
			Type.Array(step, {
				minItems: 1,
				maxItems: PLAN_LIMITS.nodes,
				description: "start: every step; revise: steps to add or replace (same id replaces).",
			}),
		),
		final: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: PLAN_LIMITS.idChars,
				description: "start: the step whose result finishes the plan; default: the last join, else the last step.",
			}),
		),
		remove: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: PLAN_LIMITS.idChars }), {
				maxItems: PLAN_LIMITS.nodes,
				description: "revise: step ids to drop (running ones are cancelled).",
			}),
		),
		reason: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: PLAN_LIMITS.reasonChars,
				description: "revise/cancel: why, in plain words.",
			}),
		),
	},
	{ additionalProperties: false },
);

function failed(text: string): AgentToolResult<{ readonly ok: false }> {
	return { content: [{ type: "text", text }], details: { ok: false }, isError: true };
}

/**
 * The root's one call from a goal to a running parallel graph. The tool only carries the call: the executor checks the
 * code facts, asks System One the plan graph's judgments, applies the ordered exits, records the plan and releases its
 * first ready layer, and answers in the comms codes (`h PLAN_STARTED` and one plain line per step). Root-only: the
 * worker tool ceiling forbids it, and only a root session is given a definition.
 */
export function createPlanToolDefinition(getPort: () => PlanExecutorPort | undefined): ToolDefinition<typeof schema> {
	return {
		name: PLAN_TOOL_NAME,
		label: "Plan",
		// The root director role names this tool for multi-part work, so its schema is in every request.
		neverDefer: true,
		description: `Run work with several parts as one plan: plan {action:start, title, steps:[{id, do, files?, uses?, after?, req?, deep?, join?, question?, by?, doneWhen?, outOfScope?}], final?}. The harness checks the plan, starts every ready step in parallel on workers, passes each step the results of the steps in its uses, retries, combines results in join steps (${JOIN_KIND_LIST}) and wakes you once per combined result. revise {steps, remove?, reason} adds or replaces steps (same id replaces) and keeps running work that did not change; cancel {reason} stops the plan. Use assign for a single task.`,
		promptSnippet: "Run a multi-step plan on workers (steps, files, uses, joins)",
		parameters: schema,
		// As for assign: a refusal lists every fix, and that view reaches the model as the failure record's evidence.
		failureRecovery: { getFailureEvidence: (_params, failure) => failure.message },
		async execute(toolCallId, input, signal) {
			signal?.throwIfAborted();
			const port = getPort();
			if (!port) return failed("Plans are unavailable in this session; use assign for each task.");
			harnessLog.info("delegation", "a plan call was made", {
				action: input.action,
				steps: input.steps?.length ?? 0,
				remove: input.remove?.length ?? 0,
			});
			const result = await port.applyToolCall(input, { toolCallId, ...(signal ? { signal } : {}) });
			if (!result.ok) return failed(result.text);
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					ok: true,
					planId: result.planId,
					version: result.version,
					started: result.started,
					waiting: result.waiting,
				},
			};
		},
	};
}
