import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { formatWallClockCap } from "../autonomy/bounded-completion.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import {
	COMMS_RECORD_VERSION,
	type CommsResultEnvelope,
	MAX_TASK_GOAL_CHARS,
	MAX_TASK_NOTE_CHARS,
	MAX_TASK_REF_CHARS,
	MAX_TASK_REFS,
	renderCommsErrView,
	renderCommsStateLine,
	renderTaskBrief,
	TASK_BRIEF_CURRENT_VERSION,
	TASK_EVIDENCE_KINDS,
	TASK_OUTPUT_KINDS,
	type TaskBrief,
	type TaskEvidenceKind,
	type TaskOutputKind,
	taskBriefProblem,
} from "../comms/comms-records.ts";
import type { SessionRootReply } from "../delegation/session-root-mailbox.ts";
import {
	normalizeWorkerAgentDependencyTaskIds,
	type WorkerAgentActivity,
	type WorkerAgentBroadcastTargetResult,
	type WorkerAgentControlPort,
	type WorkerAgentView,
	WorkerControlIdentityConflictError,
	type WorkerGrantSummary,
} from "../delegation/worker-agent-control.ts";
import { workerClaimSettlementLines } from "../delegation/worker-claim.ts";
import { MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES } from "../delegation/worker-conversation-store.ts";
import { describeWorkerModelMoves, type WorkerModelMove } from "../delegation/worker-credential-health.ts";
import {
	MAX_PARALLEL_WORK_JUSTIFICATION_LENGTH,
	parseWorkerParallelWorkIntent,
	type WorkerDelegationRequest,
} from "../delegation/worker-delegation-request.ts";
import { formatFanoutGroupLine, planFanout, WorkerFanoutError } from "../delegation/worker-fanout.ts";
import {
	FANOUT_MEMBER_ID_PATTERN,
	MAX_FANOUT_MEMBER_ID_CHARS,
	MAX_FANOUT_PARTITION_SLICES,
	MAX_FANOUT_RACE_CANDIDATES,
} from "../delegation/worker-fanout-header.ts";
import { isReceiptTool } from "../delegation/worker-receipts.ts";
import type { WorkerRunOutcome } from "../delegation/worker-runner.ts";
import type { WorkerTaskSessionView } from "../delegation/worker-task-view.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { knowledgeGrantReferencesSchema, parseKnowledgeGrantReferences } from "../memory/knowledge-grant.ts";
import {
	MAX_ORCHESTRATION_COLLECTION_LENGTH,
	MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH,
	MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
	MAX_ORCHESTRATION_MODEL_ID_LENGTH,
	MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
	MAX_WORKER_AUTHORITY_PATH_LENGTH,
	ORCHESTRATION_THINKING_LEVELS,
	type OrchestrationThinkingLevel,
} from "../orchestration/contracts.ts";
import { ORCHESTRATION_PROFILE_TOOL_NAMES } from "../orchestration/lane-tool-manifests.ts";
import type { TaskProfileWriterPort } from "../orchestration/task-profile-writer.ts";
import type { WorkerModelPinPolicy } from "../orchestration/worker-model-pins.ts";
import type { CommsStateCode } from "../provider-prompt-contracts.ts";
import { partitionToolsForReadOnly } from "../tool-capability-policy.ts";
import {
	createDelegateEventParameterSchemas,
	DELEGATE_EVENT_ACTIONS,
	type DelegateEventToolDetails,
	delegateEventPanelModel,
	executeDelegateEventAction,
} from "./delegate-events.ts";
import { BLOCK_AT_OCCURRENCE, RepeatedRejectionDetector, rejectionSignature } from "./delegate-rejection-signature.ts";
import {
	type DelegateErrRecord,
	delegateInputRemedies,
	delegateRejection,
	delegateStartRejection,
	isInputRejection,
	isSpecialistStateRefusal,
	MAX_DELEGATE_SCHEMA_FRAGMENT_CHARS,
	parseSpecialistReleaseHold,
	type RejectionOverrides,
	renderDelegateRemedyLines,
} from "./delegate-rejections.ts";
import {
	DELEGATE_STATUS_ACTIONS,
	type DelegateStatusDependencies,
	type DelegateStatusToolDetails,
	delegateStatusPanelModel,
	executeDelegateStatusAction,
} from "./delegate-status.ts";
import {
	emptyOrchestrationCall,
	type OrchestrationPanelModel,
	type OrchestrationRowStatus,
	renderOrchestrationToolResult,
} from "./orchestration-panel.ts";
import {
	createDelegateProfileParameterSchemas,
	DELEGATE_PROFILE_ACTIONS,
	type DelegateProfileToolDetails,
	delegateProfilePanelModel,
	executeDelegateProfileAction,
} from "./profile-writer.ts";

const DELEGATE_CONTROL_ACTIONS = [
	"tasks",
	"list",
	"transcript",
	"wait",
	"wait_many",
	"interrupt",
	"resume",
	"retire",
	"cancel",
] as const;

const DELEGATE_MESSAGE_ACTIONS = ["send", "broadcast", "follow_up"] as const;
const DELEGATE_ROOT_CONTROL_ACTIONS = ["inbox", "inbox_wait", "inbox_ack"] as const;
const DELEGATE_WORKER_CONTROL_ACTIONS = ["reply"] as const;

export const DELEGATE_ACTIONS = [
	"start",
	...DELEGATE_CONTROL_ACTIONS,
	...DELEGATE_MESSAGE_ACTIONS,
	...DELEGATE_ROOT_CONTROL_ACTIONS,
	...DELEGATE_WORKER_CONTROL_ACTIONS,
	...DELEGATE_STATUS_ACTIONS,
	...DELEGATE_PROFILE_ACTIONS,
	...DELEGATE_EVENT_ACTIONS,
] as const;

export type DelegateAction = (typeof DELEGATE_ACTIONS)[number];

const LEAF_ORCHESTRATION_TOOL_NAMES = ORCHESTRATION_PROFILE_TOOL_NAMES.filter((name) => name !== "delegate");
const ORCHESTRATION_TOOL_NAME_PATTERN = `^(?:${LEAF_ORCHESTRATION_TOOL_NAMES.join("|")})$`;

function createDelegateSchema(actions: readonly DelegateAction[]) {
	const actionDescription = [
		actions.includes("start") ? "start dispatches a worker" : undefined,
		actions.includes("tasks")
			? "tasks lists durable tasks, list worker metadata and activity, transcript pages messages"
			: undefined,
		actions.includes("status") ? "status reads bounded claims" : undefined,
		actions.includes("review") ? "review acknowledges a worker's mutations" : undefined,
		actions.includes("events")
			? "events recalls exact CI evidence and discovers source subjects; subscriptions reads or replaces task-bound event subscriptions"
			: undefined,
		actions.includes("profile_create") ? "profile_inspect/profile_create manage narrowed session presets" : undefined,
		actions.includes("send")
			? "send/broadcast post non-waking peer evidence, follow_up starts an idle worker or steers an active one"
			: undefined,
		actions.includes("reply") ? "reply answers one request" : undefined,
		actions.includes("inbox")
			? "inbox/inbox_wait/inbox_ack read and consume explicit replies, never completion"
			: undefined,
		actions.includes("wait") ? "wait/wait_many block on event-driven completion" : undefined,
		actions.includes("interrupt")
			? "interrupt stops a running worker, which writes one tool-free report and wakes you (message is the reason; continue with follow_up), resume re-enters a worker the host suspended, retire needs an idle worker with an empty mailbox, cancel ends only the current task"
			: undefined,
	]
		.filter((value): value is string => value !== undefined)
		.join("; ");
	const model = Type.Optional(
		Type.Object(
			{
				provider: Type.String({ minLength: 1, maxLength: MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH }),
				modelId: Type.String({ minLength: 1, maxLength: MAX_ORCHESTRATION_MODEL_ID_LENGTH }),
			},
			{ additionalProperties: false },
		),
	);
	const thinkingLevel = Type.Optional(Type.Union(ORCHESTRATION_THINKING_LEVELS.map((level) => Type.Literal(level))));
	const toolNames = Type.Optional(
		Type.Array(
			Type.String({
				minLength: 1,
				maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
				pattern: ORCHESTRATION_TOOL_NAME_PATTERN,
			}),
			{
				maxItems: MAX_ORCHESTRATION_COLLECTION_LENGTH,
				uniqueItems: true,
				description:
					"Subset of this session's active tools; a name outside them is refused. Omit to inherit every compatible foreground tool. Every worker also gets bash.",
			},
		),
	);
	const schema = Type.Object(
		{
			action: Type.Optional(
				Type.String({
					maxLength: 16,
					enum: [...actions],
					description: `Orchestration action. ${actionDescription}.`,
				}),
			),
			profileId: Type.Optional(
				Type.String({
					maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
					description: "Loaded profile preset; omit to inherit the foreground base.",
				}),
			),
			model,
			thinkingLevel,
			path: Type.Optional(
				Type.String({
					minLength: 1,
					maxLength: MAX_WORKER_AUTHORITY_PATH_LENGTH,
					description: "Worker cwd and write scope; default is the parent cwd.",
				}),
			),
			writePaths: Type.Optional(
				Type.Array(
					Type.String({
						minLength: 1,
						maxLength: MAX_WORKER_AUTHORITY_PATH_LENGTH,
					}),
					{
						maxItems: 16,
						description: "Extra absolute roots the worker may write besides its cwd.",
					},
				),
			),
			toolNames,
			knowledge: Type.Optional(
				knowledgeGrantReferencesSchema(
					"Exact accepted knowledge IDs and revisions selected for this task only. Omit to grant none; read knowledge first to obtain current references.",
				),
			),
			readOnly: Type.Optional(
				Type.Boolean({
					description:
						"True: the worker edits nothing. It keeps read tools and bash, but a command that changes files or repository state, creates a file outside its scratch directory ($TMPDIR), uses the network or reads private harness files is refused; write/edit, python, scripts and network tools are excluded. A named specialist must already match its persisted grant.",
				}),
			),
			instructions: Type.Optional(
				Type.String({
					maxLength: MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH,
					description:
						"Free-text leaf-worker task, the alternative to goal (send exactly one). Workers run no tests, test files or test runs unless the task says the owner asked.",
				}),
			),
			goal: Type.Optional(
				Type.String({
					description: `start only: the task in one sentence (at most ${MAX_TASK_GOAL_CHARS} characters); the host renders the worker's task text from goal, note, refs, evid and out.`,
				}),
			),
			note: Type.Optional(
				Type.String({
					description: `With goal: constraints and the stop condition no other field expresses (at most ${MAX_TASK_NOTE_CHARS} characters).`,
				}),
			),
			refs: Type.Optional(
				Type.Array(Type.String({ minLength: 1 }), {
					maxItems: MAX_TASK_REFS,
					description: `With goal: paths and ids to read, never pasted content (each at most ${MAX_TASK_REF_CHARS} characters).`,
				}),
			),
			evid: Type.Optional(
				Type.Union(
					(Object.keys(TASK_EVIDENCE_KINDS) as TaskEvidenceKind[]).map((kind) => Type.Literal(kind)),
					{ description: "With goal: the evidence to bring back (cite file:line, cmd output, diff, none)." },
				),
			),
			out: Type.Optional(
				Type.Union(
					(Object.keys(TASK_OUTPUT_KINDS) as TaskOutputKind[]).map((kind) => Type.Literal(kind)),
					{ description: "With goal: the answer shape (find findings, edit, ans answer, rev verdict)." },
				),
			),
			agentId: Type.Optional(
				Type.String({
					maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
					description: "Worker id returned by start; with start, reuses that worker and its context.",
				}),
			),
			parallelWork: Type.Optional(
				Type.Object(
					{
						independentOf: Type.Array(
							Type.String({ minLength: 1, maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH }),
							{ maxItems: MAX_ORCHESTRATION_COLLECTION_LENGTH },
						),
						justification: Type.String({ minLength: 1, maxLength: MAX_PARALLEL_WORK_JUSTIFICATION_LENGTH }),
					},
					{
						additionalProperties: false,
						description: "Justification for a separate worker instead of reusing compatible context.",
					},
				),
			),
			slices: Type.Optional(
				Type.Array(
					Type.Object(
						{
							id: Type.String({
								minLength: 1,
								maxLength: MAX_FANOUT_MEMBER_ID_CHARS,
								pattern: FANOUT_MEMBER_ID_PATTERN,
							}),
							instructions: Type.String({
								minLength: 1,
								maxLength: MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH,
							}),
						},
						{ additionalProperties: false },
					),
					{
						minItems: 2,
						maxItems: MAX_FANOUT_PARTITION_SLICES,
						description:
							"start only: one fresh worker per slice under one fan-out group; instructions is the shared brief. status and handoffs report slices with no accepted result.",
					},
				),
			),
			race: Type.Optional(
				Type.Integer({
					minimum: 2,
					maximum: MAX_FANOUT_RACE_CANDIDATES,
					description:
						"start only: this many fresh workers attempt the same instructions; the first accepted result wins and the rest are cancelled. Each is budgeted and charged separately.",
				}),
			),
			agentIds: Type.Optional(
				Type.Array(Type.String({ minLength: 1, maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH }), {
					minItems: 1,
					maxItems: MAX_ORCHESTRATION_COLLECTION_LENGTH,
					uniqueItems: true,
					description: "Worker targets for broadcast or wait_many; duplicates run once.",
				}),
			),
			dependsOn: Type.Optional(
				Type.Array(Type.String({ minLength: 1, maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH }), {
					maxItems: MAX_ORCHESTRATION_COLLECTION_LENGTH,
					uniqueItems: true,
					description: "Same-objective task ids that must complete before start; get ids from tasks.",
				}),
			),
			requirementId: Type.Optional(
				Type.String({
					maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
					description: "Goal requirement bound to this dispatch.",
				}),
			),
			requirementIds: Type.Optional(
				Type.Array(Type.String({ minLength: 1, maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH }), {
					maxItems: MAX_ORCHESTRATION_COLLECTION_LENGTH,
					uniqueItems: true,
					description: "Goal requirements bound to this dispatch.",
				}),
			),
			forkTurns: Type.Optional(
				Type.String({
					minLength: 1,
					maxLength: 16,
					description:
						"New-worker context: none (default), all, or a positive recent-turn count; all or a count requires the exact provider/model.",
				}),
			),
			mode: Type.Optional(
				Type.Union([Type.Literal("any"), Type.Literal("all")], {
					description: "wait_many completes when any or all target agents are no longer active.",
				}),
			),
			message: Type.Optional(
				Type.String({
					maxLength: 4_096,
					description:
						"Text for send, broadcast, follow_up and reply; for interrupt, the reason. send/broadcast never control or complete workers.",
				}),
			),
			threadId: Type.Optional(
				Type.String({
					maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
					description: "Peer-message thread id.",
				}),
			),
			replyToMessageId: Type.Optional(
				Type.String({
					maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
					description: "Id of the reply-expected request that reply answers.",
				}),
			),
			requestMessageId: Type.Optional(
				Type.String({
					maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
					description: "Only inbox replies to this request id.",
				}),
			),
			messageId: Type.Optional(
				Type.String({
					maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
					description: "Inbox reply id that inbox_ack consumes.",
				}),
			),
			ackToken: Type.Optional(
				Type.String({
					maxLength: 128,
					description: "Token returned with that inbox reply.",
				}),
			),
			expectReply: Type.Optional(
				Type.Boolean({ description: "Mark this peer message as awaiting an explicit reply." }),
			),
			cursor: Type.Optional(
				Type.Integer({
					minimum: 0,
					description: "Continue a list or transcript page with nextCursor, even after an empty page.",
				}),
			),
			maxMessages: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES,
					description:
						"Page size for list/transcript/inbox; a transcript page may hold fewer or no messages; omittedMessages marks oversized entries.",
				}),
			),
			timeoutMs: Type.Optional(
				Type.Integer({
					minimum: 0,
					maximum: 300_000,
					description:
						"Event wait timeout; expiry is nonterminal, not stall evidence, and never grounds for interrupt.",
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description:
						"retire only: discard the worker's undelivered control messages instead of refusing to retire.",
				}),
			),
			laneId: Type.Optional(
				Type.String({
					maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
					description: "Worker lane for status or review.",
				}),
			),
			...createDelegateProfileParameterSchemas(),
			...createDelegateEventParameterSchemas(),
		},
		{ additionalProperties: false },
	);
	// Keep action requirements in the advertised schema so malformed calls are classified by
	// shared preflight before any adapter runs. Direct internal calls retain defensive checks.
	const requiredFields = {
		start: ["instructions"],
		tasks: [],
		list: [],
		transcript: ["agentId"],
		send: ["agentId", "message"],
		broadcast: ["agentIds", "message"],
		follow_up: ["agentId", "message"],
		inbox: [],
		inbox_wait: [],
		inbox_ack: ["messageId", "ackToken"],
		reply: ["message", "replyToMessageId"],
		wait: ["agentId"],
		wait_many: ["agentIds", "mode"],
		interrupt: ["agentId"],
		resume: ["agentId"],
		retire: ["agentId"],
		cancel: ["agentId"],
		status: [],
		review: ["laneId"],
		profile_inspect: [],
		profile_create: ["task"],
		events: [],
		subscriptions: ["taskId"],
	} satisfies Record<DelegateAction, readonly (keyof typeof schema.properties)[]>;
	return {
		...schema,
		anyOf: actions.flatMap((action) => {
			// Preserve the executor's intentional plural wait and task-only start spellings.
			const alternates = action === "wait" ? [["agentIds"]] : action === "start" ? [["task"], ["goal"]] : [];
			const alternatives = [requiredFields[action], ...alternates];
			return alternatives.map((fields) => ({
				properties: { action: { const: action } },
				required: [...(action === "start" ? [] : ["action"]), ...fields],
			}));
		}),
	};
}

const delegateSchema = createDelegateSchema(DELEGATE_ACTIONS);
const MAX_DELEGATE_RESULT_CHARS = 16 * 1024;
const MAX_DELEGATE_CONTROL_RESULT_BYTES = 16 * 1024;
const MAX_DELEGATE_TRANSCRIPT_MESSAGE_BYTES = 12 * 1024;
const MAX_DELEGATE_ERROR_CHARS = 1_900;
const MAX_DELEGATE_MESSAGE_CHARS = 4_096;
const MAX_DELEGATE_ACK_TOKEN_CHARS = 128;
const MAX_VISIBLE_ORCHESTRATION_PROFILES = 1;
const MAX_PROFILE_GUIDELINE_FIELD_CHARS = 36;

function isDelegateAction(value: string): value is DelegateAction {
	return DELEGATE_ACTIONS.some((action) => action === value);
}

export type DelegateToolInput = Static<typeof delegateSchema>;

type DelegateInputField = keyof DelegateToolInput;

const EXACT_ACTION_ALLOWED_FIELDS = {
	start: [
		"action",
		"profileId",
		"model",
		"thinkingLevel",
		"path",
		"writePaths",
		"toolNames",
		"knowledge",
		"subscriptions",
		"readOnly",
		"instructions",
		"goal",
		"note",
		"refs",
		"evid",
		"out",
		"agentId",
		"parallelWork",
		"slices",
		"race",
		"dependsOn",
		"forkTurns",
		"requirementId",
		"requirementIds",
	],
	tasks: ["action"],
	list: ["action", "cursor", "maxMessages"],
	transcript: ["action", "agentId", "cursor", "maxMessages"],
	send: ["action", "agentId", "message", "threadId", "expectReply"],
	broadcast: ["action", "agentIds", "message", "threadId", "expectReply"],
	follow_up: ["action", "agentId", "message", "threadId", "expectReply"],
	inbox: ["action", "agentId", "requestMessageId", "maxMessages"],
	inbox_wait: ["action", "agentId", "requestMessageId", "maxMessages", "timeoutMs"],
	inbox_ack: ["action", "messageId", "ackToken"],
	reply: ["action", "message", "replyToMessageId"],
	wait: ["action", "agentId", "timeoutMs"],
	wait_many: ["action", "agentIds", "mode", "timeoutMs"],
	interrupt: ["action", "agentId", "message"],
	resume: ["action", "agentId"],
	retire: ["action", "agentId", "force"],
	cancel: ["action", "agentId"],
	status: ["action", "laneId", "agentId"],
	review: ["action", "laneId", "agentId"],
	profile_inspect: ["action"],
	profile_create: ["action", "task", "baseProfileId", "model", "thinkingLevel", "path", "toolNames"],
	events: ["action", "taskId", "eventId", "eventView", "cursor", "maxMessages"],
	subscriptions: ["action", "taskId", "expectedRevision", "subscriptions", "cursor", "maxMessages"],
} as const satisfies Record<DelegateAction, readonly DelegateInputField[]>;

/** One placeholder value of a schema property's type, for a minimal valid call. */
function exampleValue(field: string): unknown {
	const node: unknown = Reflect.get(delegateSchema.properties, field);
	if (!node || typeof node !== "object") return `<${field}>`;
	const schema = node as { type?: unknown; minimum?: unknown; anyOf?: unknown; enum?: unknown };
	const literal = Array.isArray(schema.anyOf)
		? (schema.anyOf as { const?: unknown }[]).find((member) => member.const !== undefined)?.const
		: Array.isArray(schema.enum)
			? schema.enum[0]
			: undefined;
	if (literal !== undefined) return literal;
	if (schema.type === "array") return [`<${field.replace(/s$/, "")}>`];
	if (schema.type === "integer" || schema.type === "number")
		return typeof schema.minimum === "number" ? Math.max(schema.minimum, 1) : 1;
	if (schema.type === "boolean") return true;
	return `<${field}>`;
}

/**
 * The `s` of an input refusal: the action's required fields (each alternative the advertised schema accepts), its
 * optional fields and one minimal valid call, read from the advertised schema and the action's field list. Bounded
 * so the whole refusal fits the kernel's failure-evidence bound, where the model reads it.
 */
function delegateSchemaFragment(action: DelegateAction): string {
	const alternatives = delegateSchema.anyOf
		.filter((alternative) => alternative.properties.action.const === action)
		.map((alternative) => alternative.required.filter((field) => field !== "action"));
	const required = alternatives[0] ?? [];
	const optional = (EXACT_ACTION_ALLOWED_FIELDS[action] as readonly string[]).filter(
		(field) => field !== "action" && !alternatives.some((fields) => fields.includes(field)),
	);
	const instead =
		alternatives.length > 1
			? ` (or ${alternatives
					.slice(1)
					.map((fields) => fields.join("+"))
					.join(" or ")} in place of ${required.join("+")})`
			: "";
	const example = { action, ...Object.fromEntries(required.map((field) => [field, exampleValue(field)])) };
	const fragment = `delegate ${action} required: ${required.join(", ") || "none"}${instead}; optional: ${optional.join(", ") || "none"}; minimal call ${JSON.stringify(example)}`;
	return fragment.length <= MAX_DELEGATE_SCHEMA_FRAGMENT_CHARS
		? fragment
		: `${fragment.slice(0, MAX_DELEGATE_SCHEMA_FRAGMENT_CHARS - 1)}…`;
}

/**
 * Wrong-field input that CARRIES A PAYLOAD is corrected by name instead of being deleted. Deleting
 * these produced a downstream error that never named the field the model actually sent
 * (`agentIds` -> `delegate cancel requires agentId`). A plural spelling on a singular lifecycle
 * action ALWAYS rejects: adopting `agentIds: [one]` would make it work sometimes, which is the
 * ambiguity these actions exist to avoid. Spellings with exactly one reading are absorbed instead
 * (`task` on follow_up/send is the message, `agentId` on status is that agent's latest lane,
 * `message` on interrupt is queued for the paused worker) — see sanitizeExactActionInput and the
 * executor. A lossless spelling in the closed alias map is applied and reported in `n`, never
 * silently; authority fields are never aliased. Every other disallowed field is refused by name
 * (`E_FIELD`) with the action's schema and a removal patch, never deleted.
 */
const EXACT_ACTION_FIELD_CORRECTIONS: ReadonlyArray<{
	readonly actions: readonly DelegateAction[];
	readonly field: DelegateInputField;
	readonly correction: (action: DelegateAction) => string;
	readonly counterpart?: { readonly field: DelegateInputField; readonly conflict: string };
}> = [
	{
		actions: ["status", "review"],
		field: "agentIds",
		correction: (action) =>
			`delegate ${action} does not accept agentIds. Nothing was inspected or acknowledged. Use one agentId or one exact laneId per call; omit selectors only for a status overview.`,
	},
	{
		// `wait` is not here: waiting is read-only, so a plural wait can only mean wait_many and is
		// normalized to it before this table runs (see the action resolution in the executor).
		actions: ["cancel", "interrupt", "resume", "retire"],
		field: "agentIds",
		correction: (action) =>
			`delegate ${action} does not accept field agentIds. Nothing was executed. Use singular agentId — one call per worker.`,
		counterpart: { field: "agentId", conflict: "Both agentIds and agentId were sent; keep only agentId." },
	},
	// follow_up and send continue the worker's current task and carry only a message. A task field sent
	// with one would change what the call means, so it is refused rather than deleted: deleting it ran the
	// next task under the previous task's requirement ids, and its report was checked against the wrong ones.
	...(["requirementId", "requirementIds", "dependsOn"] as const).map((field) => ({
		actions: ["follow_up", "send"] as readonly DelegateAction[],
		field,
		correction: (action: DelegateAction) =>
			`delegate ${action} does not accept ${field}: it carries a message on the worker's current task and cannot change what that task is correlated to. Nothing was queued. For new work on this worker with its own requirement ids or dependencies, call delegate start with its agentId and ${field}.`,
	})),
];

/** A refused action input: the reason, the dispatch-level skip code, and the record fields the refusal sets. */
interface ActionViolation {
	readonly message: string;
	readonly skipReason: string;
	readonly overrides?: RejectionOverrides;
}

/**
 * Runs against the ORIGINAL input before any deletion or adoption, so a mapped violation can never
 * follow a partial sanitization and the verdict never depends on object-key order.
 */
function correctExactActionInput(input: DelegateToolInput, action: DelegateAction): ActionViolation | undefined {
	for (const entry of EXACT_ACTION_FIELD_CORRECTIONS) {
		if (!entry.actions.includes(action)) continue;
		if (Reflect.get(input, entry.field) === undefined) continue;
		const conflict =
			entry.counterpart && Reflect.get(input, entry.counterpart.field) !== undefined
				? ` ${entry.counterpart.conflict}`
				: "";
		return {
			message: `${entry.correction(action)}${conflict}`,
			skipReason: "action_field_forbidden",
			overrides: { f: entry.field, h: "DROP_FIELD" },
		};
	}
	return undefined;
}

/** The brief as plain instructions: the goal, the instructions and the detail fields (note, refs, evid, out), in that order. */
function foldedBriefInput(input: DelegateToolInput): DelegateToolInput {
	const { goal, note, refs, evid, out, instructions, ...rest } = input as DelegateToolInput & {
		evid?: unknown;
		out?: unknown;
	};
	const parts = [
		goal?.trim(),
		instructions?.trim(),
		note?.trim() ? `Note: ${note.trim()}` : undefined,
		refs && refs.length > 0 ? `References:\n${refs.map((ref) => `- ${ref}`).join("\n")}` : undefined,
		evid ? `Evidence: ${JSON.stringify(evid)}` : undefined,
		out ? `Report: ${JSON.stringify(out)}` : undefined,
	].filter((part): part is string => part !== undefined && part.length > 0);
	return { ...rest, instructions: parts.join("\n\n") } as DelegateToolInput;
}

/**
 * A `start` that states its task in fields: exactly one of `goal` or `instructions`, the other fields only with
 * `goal`, each inside its budget. The worker's task text is rendered from the record and replaces `instructions`
 * for every reader after this point; the record travels beside it as the dispatch `brief`.
 */
function resolveTaskBrief(
	input: DelegateToolInput,
	action: DelegateAction,
): { input: DelegateToolInput; brief?: TaskBrief; violation?: ActionViolation } {
	if (action !== "start") return { input };
	const companion = (["note", "refs", "evid", "out"] as const).find((field) => input[field] !== undefined);
	// Detail fields without a goal, and a goal that is not one clean line or that comes with instructions, are one brief in
	// plain words: nothing is rejected for how the model split its own text (the record form stays for a one-line goal).
	if (input.goal === undefined) return companion === undefined ? { input } : { input: foldedBriefInput(input) };
	if (input.instructions !== undefined || /[\r\n\u0000-\u001f]/.test(input.goal.trim()))
		return { input: foldedBriefInput(input) };
	const note = input.note?.trim();
	const refs = input.refs?.map((ref) => ref.trim()).filter(Boolean);
	const brief: TaskBrief = {
		v: TASK_BRIEF_CURRENT_VERSION,
		goal: input.goal.trim(),
		...(note ? { note } : {}),
		...(input.evid ? { evid: input.evid } : {}),
		...(input.out ? { out: input.out } : {}),
		...(refs && refs.length > 0 ? { refs } : {}),
	};
	const problem = taskBriefProblem(brief);
	if (problem) {
		const maxima = { goal: MAX_TASK_GOAL_CHARS, note: MAX_TASK_NOTE_CHARS, refs: MAX_TASK_REF_CHARS } as const;
		return {
			input,
			violation: {
				message:
					problem.kind === "limit"
						? `delegate start ${problem.field === "refs" ? `refs (at most ${MAX_TASK_REFS}, each` : problem.field} may not exceed ${maxima[problem.field]} characters${problem.field === "refs" ? ")" : ""}.`
						: problem.field === "goal"
							? "delegate start goal must be one non-empty line without line breaks or control characters; put detail in note."
							: `delegate start ${problem.field} is not usable: each ref is one non-empty line without control characters.`,
				skipReason: `${problem.field}_${problem.kind === "limit" ? "too_long" : "invalid"}`,
			},
		};
	}
	return { input: { ...input, instructions: renderTaskBrief(brief) }, brief };
}

/**
 * The input an action accepts: refused by name, or with each absorbed spelling of the closed alias map moved to its
 * canonical field and listed in `normalized` as `from->to`, so the result reports it.
 */
function sanitizeExactActionInput(
	input: DelegateToolInput,
	action: DelegateAction,
): { input: DelegateToolInput; violation: ActionViolation } | { input: DelegateToolInput; normalized: string[] } {
	const allowed = EXACT_ACTION_ALLOWED_FIELDS[action] as readonly string[];
	const normalized: string[] = [];
	const correction = correctExactActionInput(input, action);
	if (correction) return { input: { ...input }, violation: correction };
	const exactInput = { ...input };
	if (
		(action === "status" || action === "review") &&
		exactInput.agentId !== undefined &&
		exactInput.laneId !== undefined
	) {
		return {
			input: exactInput,
			violation: {
				message: `delegate ${action} takes one selector: agentId (the agent's latest lane) or laneId, not both. Nothing was inspected or acknowledged.`,
				skipReason: "action_field_forbidden",
				overrides: { f: "agentId", h: "DROP_FIELD" },
			},
		};
	}
	for (const field of Object.keys(exactInput)) {
		if (Reflect.get(exactInput, field) === undefined || allowed.includes(field)) continue;
		if ((action === "follow_up" || action === "send") && field === "task") {
			const taskText = typeof exactInput.task === "string" ? exactInput.task.trim() : "";
			const messageText = typeof exactInput.message === "string" ? exactInput.message.trim() : "";
			// `task` is the start/profile_create brief on the shared schema; on a message action
			// it can only be the message. Both fields together is a conflict; drop neither.
			if (taskText && !messageText) {
				exactInput.message = exactInput.task;
				delete exactInput.task;
				normalized.push("task->message");
				continue;
			}
			return {
				input: exactInput,
				violation: {
					message: `delegate ${action} does not accept field task alongside message. Nothing was queued. Both task and message were sent; keep only message.`,
					skipReason: "action_field_forbidden",
					overrides: { f: "task", h: "DROP_FIELD" },
				},
			};
		}
		if (action === "profile_create" && field === "resourceProfileNames") {
			return {
				input: exactInput,
				violation: {
					message:
						"delegate profile_create field resourceProfileNames is forbidden. Profiles may narrow only model, thinkingLevel, path, and toolNames; inherited resources remain host-owned.",
					skipReason: "action_field_forbidden",
					overrides: { c: "E_AUTH", f: field, h: "DROP_FIELD" },
				},
			};
		}
		if (action === "start" && field === "authority") {
			return {
				input: exactInput,
				violation: {
					message:
						"delegate start field authority is not accepted; no worker started. Use only the optional model, thinkingLevel, path, writePaths and toolNames overrides: the host compiles the execution grant.",
					skipReason: "action_field_forbidden",
					overrides: { c: "E_AUTH", f: field, h: "DROP_FIELD" },
				},
			};
		}
		if (action === "start" && field === "task") {
			const taskText = typeof exactInput.task === "string" ? exactInput.task.trim() : "";
			const instructionsText = typeof exactInput.instructions === "string" ? exactInput.instructions.trim() : "";
			// `task` is a profile_create field on the shared schema. A start that only
			// populated it still has the worker brief — use it. Both fields together is a
			// conflict; do not drop either.
			if (taskText) {
				exactInput.instructions = instructionsText ? `${taskText}\n\n${instructionsText}` : taskText;
				delete exactInput.task;
				normalized.push("task->instructions");
				continue;
			}
			return {
				input: exactInput,
				violation: {
					message:
						"delegate start field task is not a start field; no worker started and nothing was dropped. The task text belongs in instructions.",
					skipReason: "action_field_forbidden",
					overrides: { f: field, h: "MOVE_FIELD", x: "instructions" },
				},
			};
		}
		if (action === "start" && field === "budget") {
			return {
				input: exactInput,
				violation: {
					message:
						"delegate start does not accept model-authored budgets; no worker started. Ceilings come only from host settings or an owner-authored profileId.",
					skipReason: "action_field_forbidden",
					overrides: { c: "E_AUTH", f: field, h: "DROP_FIELD" },
				},
			};
		}
		if (action === "profile_create" && field === "budget") {
			return {
				input: exactInput,
				violation: {
					message:
						"delegate profile_create does not accept model-authored budgets; the immutable task profile inherits its owner-authored base ceiling",
					skipReason: "profile_budget_forbidden",
				},
			};
		}
		if ((action === "follow_up" || action === "send") && field === "writePaths") {
			return {
				input: exactInput,
				violation: {
					message: `delegate ${action} cannot change a worker's write scope: a reused worker keeps the scope it was created with. Nothing was queued. Start a new worker with \`writePaths\` for the extra roots.`,
					skipReason: "action_field_forbidden",
					overrides: { c: "E_AUTH", f: field, h: "DROP_FIELD" },
				},
			};
		}
		if (field === "laneId") {
			return {
				input: exactInput,
				violation: {
					message: `delegate ${action} field laneId is forbidden; laneId is only for status or review. Omit it when starting a fresh worker, then use the returned agentId to reuse that worker`,
					skipReason: "action_field_forbidden",
					overrides: { f: field, h: "DROP_FIELD" },
				},
			};
		}
		if ((action === "send" || action === "follow_up") && field === "replyToMessageId") {
			return {
				input: exactInput,
				violation: {
					message: `delegate ${action} cannot answer a request; use reply`,
					skipReason: "reply_action_required",
				},
			};
		}
		if (action === "reply" && (field === "agentId" || field === "threadId" || field === "expectReply")) {
			return {
				input: exactInput,
				violation: {
					message: `delegate reply field ${field} is forbidden; destination is inferred and reply accepts only message and replyToMessageId`,
					skipReason: "reply_target_forbidden",
					overrides: { f: field },
				},
			};
		}
		// Every other field outside the action's list and outside the closed alias map is refused by name, with the
		// action's schema and a removal patch: deleting it and proceeding ran a call the model did not write, and the
		// reply never said which of its fields the host ignored.
		return {
			input: exactInput,
			violation: {
				message: `delegate ${action} does not accept field ${field}; nothing ran.`,
				skipReason: "action_field_forbidden",
				overrides: { f: field, h: "DROP_FIELD" },
			},
		};
	}
	return { input: exactInput, normalized };
}

/** A call whose input passed every check that reads only the input itself. */
interface ScreenedDelegateCall {
	readonly action: DelegateAction;
	/** The exact input; a structured start carries its rendered task text as `instructions`. */
	readonly input: DelegateToolInput;
	readonly brief?: TaskBrief;
	readonly agentIds?: string[];
	readonly dependsOnTaskIds?: string[];
	/** Absorbed spellings as `from->to`, reported on the result. */
	readonly normalized: readonly string[];
}

/** A call refused before anything ran: the reason, the detail fields and the record fields the refusal sets. */
interface DelegateCallRefusal {
	readonly message: string;
	readonly details: DelegateToolDetails;
	readonly overrides?: RejectionOverrides;
}

/**
 * Every check of a `delegate` call that reads only its input and the caller's fixed action list, in the order the
 * executor applies them. Pure: the executor runs it before any host call, and a refusal it returns is the same for
 * the same input.
 */
function screenDelegateInput(
	originalInput: DelegateToolInput,
	availableActions: readonly DelegateAction[],
): { screened: ScreenedDelegateCall } | { refusal: DelegateCallRefusal } {
	const requestedAction = originalInput.action ?? "start";
	const refuse = (message: string, details: DelegateToolDetails, overrides?: RejectionOverrides) => ({
		refusal: { message, details, ...(overrides ? { overrides } : {}) },
	});
	if (!isDelegateAction(requestedAction)) {
		return refuse(`delegate action is invalid: ${requestedAction}`, { started: false, skipReason: "invalid_action" });
	}
	if (!availableActions.includes(requestedAction)) {
		return refuse(`delegate action is unavailable to this caller: ${requestedAction}`, {
			started: false,
			action: requestedAction,
			skipReason: "action_unavailable",
		});
	}
	// A wait for several workers is wait_many however the caller spelled it: waiting is
	// read-only, so the plural never means anything else (unlike cancel/interrupt/resume/retire,
	// whose plural spelling stays refused). Measured live: `wait` with agentIds was refused, the
	// corrected call came a turn later, and the failure ledger rode every request after it. A
	// plural wait without a mode waits for all of them.
	const pluralWait =
		requestedAction === "wait" &&
		originalInput.agentIds !== undefined &&
		originalInput.agentId === undefined &&
		availableActions.includes("wait_many");
	const action: DelegateAction = pluralWait ? "wait_many" : requestedAction;
	const normalizedInput =
		pluralWait && originalInput.mode === undefined ? { ...originalInput, mode: "all" as const } : originalInput;
	const sanitized = sanitizeExactActionInput(normalizedInput, action);
	if ("violation" in sanitized) {
		const { violation } = sanitized;
		return refuse(
			violation.message,
			{ started: false, action, skipReason: violation.skipReason },
			violation.overrides,
		);
	}
	const resolved = resolveTaskBrief(sanitized.input, action);
	if (resolved.violation) {
		const { violation } = resolved;
		return refuse(
			violation.message,
			{ started: false, action, skipReason: violation.skipReason },
			violation.overrides,
		);
	}
	const { input, brief } = resolved;
	const normalized = [...(pluralWait ? ["wait->wait_many"] : []), ...sanitized.normalized];
	if (input.parallelWork !== undefined) {
		try {
			const intent = parseWorkerParallelWorkIntent(input.parallelWork);
			if (input.agentId && intent.independentOf.includes(input.agentId)) {
				throw new Error(`${input.agentId} cannot run independently of itself; name a different recipient`);
			}
		} catch (error) {
			return refuse(error instanceof Error ? error.message : String(error), {
				started: false,
				action,
				skipReason: "worker_parallel_intent_invalid",
			});
		}
	}
	let agentIds: string[] | undefined;
	if (input.agentIds !== undefined) {
		if (
			!Array.isArray(input.agentIds) ||
			input.agentIds.length < 1 ||
			input.agentIds.length > MAX_ORCHESTRATION_COLLECTION_LENGTH
		) {
			return refuse(`delegate agentIds must contain from 1 through ${MAX_ORCHESTRATION_COLLECTION_LENGTH} entries`, {
				started: false,
				action,
				skipReason: "agent_ids_invalid",
			});
		}
		agentIds = [];
		for (const agentId of input.agentIds) {
			if (
				typeof agentId !== "string" ||
				!agentId.trim() ||
				agentId.trim().length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH
			) {
				return refuse("delegate agentIds contains an invalid logical worker id", {
					started: false,
					action,
					skipReason: "agent_ids_invalid",
				});
			}
			agentIds.push(agentId.trim());
		}
	}
	let dependsOnTaskIds: string[] | undefined;
	if (input.dependsOn !== undefined) {
		try {
			dependsOnTaskIds = [...normalizeWorkerAgentDependencyTaskIds(input.dependsOn)];
		} catch (error) {
			return refuse(error instanceof Error ? error.message : String(error), {
				started: false,
				action,
				skipReason: "dependency_ids_invalid",
			});
		}
	}
	if (input.mode !== undefined && input.mode !== "any" && input.mode !== "all") {
		return refuse("delegate wait mode is invalid", { started: false, action, skipReason: "wait_mode_invalid" });
	}
	if (input.instructions !== undefined && input.instructions.length > MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH) {
		return refuse(
			`delegate instructions may not exceed ${MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH} characters`,
			{
				started: false,
				action,
				skipReason: "instructions_too_long",
			},
		);
	}
	if (input.profileId !== undefined && input.profileId.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH) {
		return refuse(`delegate profileId may not exceed ${MAX_ORCHESTRATION_IDENTIFIER_LENGTH} characters`, {
			started: false,
			action,
			skipReason: "profile_id_too_long",
		});
	}
	if (input.agentId !== undefined && input.agentId.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH) {
		return refuse(`delegate agentId may not exceed ${MAX_ORCHESTRATION_IDENTIFIER_LENGTH} characters`, {
			started: false,
			action,
			skipReason: "agent_id_too_long",
		});
	}
	if (input.message !== undefined && input.message.length > MAX_DELEGATE_MESSAGE_CHARS) {
		return refuse(`delegate message may not exceed ${MAX_DELEGATE_MESSAGE_CHARS} characters`, {
			started: false,
			action,
			skipReason: "message_too_long",
		});
	}
	for (const [label, value] of [
		["threadId", input.threadId],
		["replyToMessageId", input.replyToMessageId],
		["requestMessageId", input.requestMessageId],
		["messageId", input.messageId],
	] as const) {
		if (
			value !== undefined &&
			(!value.trim() || value.trim() !== value || value.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH)
		) {
			return refuse(`delegate ${label} is invalid`, { started: false, action, skipReason: "control_id_invalid" });
		}
	}
	if (
		input.ackToken !== undefined &&
		(!input.ackToken.trim() ||
			input.ackToken.trim() !== input.ackToken ||
			input.ackToken.length > MAX_DELEGATE_ACK_TOKEN_CHARS)
	) {
		return refuse("delegate ackToken is invalid", { started: false, action, skipReason: "ack_token_invalid" });
	}
	if (input.cursor !== undefined && (!Number.isSafeInteger(input.cursor) || input.cursor < 0)) {
		return refuse("delegate cursor is invalid", { started: false, action, skipReason: "cursor_invalid" });
	}
	if (
		input.maxMessages !== undefined &&
		(!Number.isSafeInteger(input.maxMessages) ||
			input.maxMessages < 1 ||
			input.maxMessages > MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES)
	) {
		return refuse("delegate maxMessages is invalid", { started: false, action, skipReason: "page_size_invalid" });
	}
	if (
		input.timeoutMs !== undefined &&
		(!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > 300_000)
	) {
		return refuse("delegate timeoutMs is invalid", { started: false, action, skipReason: "timeout_invalid" });
	}
	return {
		screened: {
			action,
			input,
			...(brief ? { brief } : {}),
			...(agentIds ? { agentIds } : {}),
			...(dependsOnTaskIds ? { dependsOnTaskIds } : {}),
			normalized,
		},
	};
}

/**
 * The refusal record of a screened call. An input refusal carries the action's schema fragment `s` and its remedies
 * `r`; `occurrence` (from the repeated-rejection detector) leads the second with the repeat and turns the third and
 * later into a block with a plain reason. A refusal that reads state is the bare record.
 */
function screenedRefusalRecord(
	refusal: DelegateCallRefusal,
	input: DelegateToolInput,
	occurrence: number,
): DelegateErrRecord {
	const { skipReason, action } = refusal.details;
	const err = delegateRejection(skipReason, refusal.message, refusal.overrides);
	if (!isInputRejection(skipReason)) return err;
	const blocked = occurrence >= BLOCK_AT_OCCURRENCE;
	const record = blocked
		? delegateRejection(
				"request_repeated",
				`Blocked: the host refused this same call ${occurrence - 1} times in the last ten minutes and refuses it again unchanged (${err.m}) Apply a remedy below or change the call.`,
				{
					c: err.c,
					...(err.f ? { f: err.f } : {}),
					...(err.h ? { h: err.h } : {}),
					...(err.x ? { x: err.x } : {}),
				},
			)
		: occurrence === 2
			? delegateRejection(
					skipReason,
					`This is the same call the host refused a moment ago. ${refusal.message}`,
					refusal.overrides,
				)
			: err;
	const s = action && isDelegateAction(action) ? delegateSchemaFragment(action) : undefined;
	const r = delegateInputRemedies(err, input as Record<string, unknown>);
	return { ...record, ...(s ? { s } : {}), ...(r.length > 0 ? { r } : {}) };
}

export interface DelegateRunOutcome {
	started: boolean;
	skipReason?: string;
	record?: LaneRecord;
	outcome?: WorkerRunOutcome;
}

/**
 * Root of the `modelPinBypass: <role>` evasion diagnostic: reads it off whichever result shape
 * carried it (the async start() result puts it at the top level; the sync run() result nests it
 * inside `outcome`, since WorkerRunOutcome is what threads through that path — see
 * worker-delegation-controller.ts and worker-runner.ts).
 */
function modelPinBypassFrom(source: { modelPinBypass?: string; outcome?: WorkerRunOutcome }): string | undefined {
	return source.modelPinBypass ?? source.outcome?.modelPinBypass;
}

export interface DelegateDispatchToolDetails {
	started: boolean;
	action?: DelegateAction;
	agentId?: string;
	agentIds?: readonly string[];
	agentIdsOmitted?: number;
	skipReason?: string;
	profileId?: string;
	modelRef?: string;
	thinkingLevel?: OrchestrationThinkingLevel;
	laneId?: string;
	label?: string;
	status?: LaneRecord["status"];
	reasonCode?: string;
	accepted?: boolean;
	costUsd?: number;
	summary?: string;
	blockers?: readonly string[];
	inconclusive?: readonly string[];
	queued?: boolean;
	messageId?: string;
	broadcastResults?: readonly WorkerAgentBroadcastTargetResult[];
	broadcastResultsOmitted?: number;
	timedOut?: boolean;
	/** A wait the owner's input ended: the waited work is still in flight, and that input is read next. */
	steered?: boolean;
	/** A fan-out start: the group and, per declared member, the lane it started or why it did not. */
	fanout?: {
		groupId: string;
		kind: "partition" | "race";
		members: readonly { memberId: string; laneId?: string; agentId?: string; skipReason?: string }[];
	};
	/** Why an admitted worker has not started yet (for example the foreground hold); it starts without further action. */
	waitReason?: string;
	replayed?: boolean;
	/**
	 * Set when a pin policy is active, the effective role had no pin, and this delegation requested
	 * an explicit model — the owner's model pin was evaded, not merely inapplicable. Diagnostics
	 * only: admission was never blocked on this. Value is the effective role that bypassed the pin.
	 */
	modelPinBypass?: string;
}

type DelegateDispatchDetailProjection = Partial<
	Pick<
		DelegateDispatchToolDetails,
		| "skipReason"
		| "agentIds"
		| "agentIdsOmitted"
		| "summary"
		| "blockers"
		| "broadcastResults"
		| "broadcastResultsOmitted"
	>
>;

export type DelegateToolDetails = (
	| DelegateDispatchToolDetails
	| DelegateStatusToolDetails
	| DelegateProfileToolDetails
	| DelegateEventToolDetails
) &
	DelegateDispatchDetailProjection &
	CommsResultEnvelope & {
		/** Spellings the host absorbed into their canonical fields before the call ran, as `from->to`. */
		n?: readonly string[];
	};

interface DelegateToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: DelegateToolDetails;
	isError?: boolean;
	errorKind?: "operation_outcome";
}

/** Every `delegate` result carries the machine-record version in `details`, whichever action produced it. */
type DelegateExecute = (
	toolCallId: string,
	input: DelegateToolInput,
	signal: AbortSignal | undefined,
) => Promise<DelegateToolResult>;

function stampCommsVersion(run: DelegateExecute): DelegateExecute {
	return async (toolCallId, input, signal) => {
		const result = await run(toolCallId, input, signal);
		return { ...result, details: { ...result.details, v: COMMS_RECORD_VERSION } };
	};
}

/** The line a result carries when the host moved absorbed spellings to their canonical fields before running the call. */
function withNormalizations(result: DelegateToolResult, normalized: readonly string[]): DelegateToolResult {
	if (normalized.length === 0) return result;
	return {
		...result,
		content: [
			...result.content,
			{
				type: "text",
				text: `n ${normalized.join(", ")}: the host renamed these fields to the canonical ones before the call ran; send the canonical names next time.`,
			},
		],
		details: { ...result.details, n: normalized },
	};
}

/**
 * The executor's boundary: every input-only check runs first ({@link screenDelegateInput}). A refused input is
 * counted by its signature, so the repeat leads the second refusal and the third identical one is blocked; a
 * screened call runs and its result reports the spellings the host absorbed.
 */
function screenedExecution(
	availableActions: readonly DelegateAction[],
	rejections: RepeatedRejectionDetector,
	run: (
		toolCallId: string,
		screened: ScreenedDelegateCall,
		signal: AbortSignal | undefined,
	) => Promise<DelegateToolResult>,
): DelegateExecute {
	return stampCommsVersion(async (toolCallId, originalInput, signal) => {
		const outcome = screenDelegateInput(originalInput, availableActions);
		if ("screened" in outcome)
			return withNormalizations(await run(toolCallId, outcome.screened, signal), outcome.screened.normalized);
		const { refusal } = outcome;
		const { skipReason } = refusal.details;
		const occurrence = isInputRejection(skipReason)
			? rejections.note(
					rejectionSignature({
						action: refusal.details.action ?? String(originalInput.action ?? "start"),
						skipReason: skipReason ?? "",
						...(refusal.overrides?.f ? { field: refusal.overrides.f } : {}),
						input: originalInput,
					}),
				).occurrence
			: 1;
		const record = screenedRefusalRecord(refusal, originalInput, occurrence);
		return refusalResult(
			record,
			occurrence >= BLOCK_AT_OCCURRENCE ? { ...refusal.details, skipReason: "request_repeated" } : refusal.details,
		);
	});
}

/**
 * A refusal: nothing ran. The record is the canonical fact; the content is its tagged model view, with the `s` and
 * `r` lines of an input refusal after it.
 */
function refusalResult(err: DelegateErrRecord, details: DelegateToolDetails, errorKind?: "operation_outcome") {
	return {
		content: [
			{ type: "text" as const, text: [renderCommsErrView(err), ...renderDelegateRemedyLines(err)].join("\n") },
		],
		details: { ...details, err },
		isError: true as const,
		...(errorKind ? { errorKind } : {}),
	};
}

/** The content line of a result's host state codes, appended after the result's own text. */
function withStateLine(text: string, codes: readonly CommsStateCode[]): string {
	const line = renderCommsStateLine(codes);
	return line ? `${text}\n${line}` : text;
}

export type DelegateCaller = { kind: "session_root" } | { kind: "worker"; agentId: string };

type DelegateStartOutcome =
	| { started: false; skipReason: string }
	| {
			started: true;
			record: LaneRecord;
			modelPinBypass?: string;
			similarLaneIds?: string[];
			modelMoves?: readonly WorkerModelMove[];
	  };

export interface DelegateToolDependencies {
	startWorkerDelegation?: (
		args: WorkerDelegationRequest,
		signal?: AbortSignal,
	) => DelegateStartOutcome | Promise<DelegateStartOutcome>;
	runWorkerDelegation: (args: WorkerDelegationRequest) => Promise<DelegateRunOutcome>;
	orchestrationProfiles?: readonly { profileId: string; role: string; description: string }[];
	/** Active owner settings only; omitted/absent preserves the existing lean prompt verbatim. */
	workerModelPinPolicy?: WorkerModelPinPolicy;
	workerAgentControl?: WorkerAgentControlPort;
	/** Effective tools and capabilities the host compiled for a lane, shown once on start. */
	describeWorkerGrant?: (laneId: string) => WorkerGrantSummary | undefined;
	/** Root-only bounded lane inspection and durable mutation-review acknowledgement. */
	status?: DelegateStatusDependencies;
	/** Root-only immutable session task-profile inspection and creation. */
	profileWriter?: TaskProfileWriterPort;
	/** Required host-owned caller class. Missing identity never aliases the session root. */
	caller: DelegateCaller;
	/** Host-owned durable turn identity used only by actions that can mutate worker mailboxes. */
	resolveMessageReplayScope?: () => { sessionId: string; branchId: string };
	/**
	 * The parent's CURRENT goal, read at dispatch. A task started now belongs to the goal the parent
	 * is pursuing now; without this port a reused specialist would inherit whatever goal it happened
	 * to run first. Host-owned: the model never supplies goal state.
	 */
	getGoalStateSnapshot?: () => GoalState | undefined;
}

/** Why a queued lane has not started, as every start receipt states it (the scheduler's wait state on the record). */
function queuedWaitLine(record: LaneRecord | undefined): string | undefined {
	return record?.status === "queued" && record.waitReason ? `waiting: ${record.waitReason}` : undefined;
}

/**
 * First line of a start result. The model chose the worker's tools, model, and path; this is the
 * host's answer to what it actually compiled, plus why a queued lane is not running yet.
 */
function describeStartedWorker(
	record: LaneRecord,
	grant: WorkerGrantSummary | undefined,
	similarLaneIds?: readonly string[],
	modelMoves?: readonly WorkerModelMove[],
): string {
	const parts = [
		`delegate started (${record.status}) — stable agentId ${record.agentId ?? record.laneId}, task laneId ${record.laneId}`,
	];
	if (record.modelRef) parts.push(`effective model ${record.modelRef}, thinking ${record.thinkingLevel ?? "unknown"}`);
	// The harness already moved the worker past an unusable model: said here so the parent neither probes nor names one.
	const moved = describeWorkerModelMoves(modelMoves);
	if (moved) parts.push(moved);
	if (grant) {
		parts.push(
			`tools: ${grant.toolNames.length > 0 ? grant.toolNames.join(", ") : "none"}`,
			`capabilities: ${grant.capabilities.length > 0 ? grant.capabilities.join(", ") : "none"}`,
			`budget: wall clock ${grant.budget?.maxWallClockMs ? formatWallClockCap(grant.budget.maxWallClockMs) : "unbounded"}, usd ${grant.budget?.maxCostUsd ? grant.budget.maxCostUsd.toFixed(2) : "unbounded"}`,
		);
	}
	const waiting = queuedWaitLine(record);
	if (waiting) parts.push(waiting);
	if (similarLaneIds?.length) {
		parts.push(
			`similar active lane${similarLaneIds.length === 1 ? "" : "s"}: ${similarLaneIds.join(", ")} — if this duplicates one, cancel the copy`,
		);
	}
	return parts.join("; ");
}

const MAX_IDLE_SPECIALISTS_LISTED = 5;

/**
 * Said at the moment a fresh worker is minted: the specialists that already exist, are idle, and were
 * passed over. Waking one keeps its history and costs no new context; the model routes, so it is told.
 */
function describeIdleSpecialists(agents: readonly WorkerAgentView[]): string | undefined {
	if (agents.length === 0) return undefined;
	const listed = agents.slice(0, MAX_IDLE_SPECIALISTS_LISTED).map((agent) => {
		const detail = [
			agent.role,
			agent.modelRef,
			agent.lastResult ? `last ${agent.lastResult.status}/${agent.lastResult.reasonCode}` : undefined,
			agent.awaitingParent ? "awaiting you" : undefined,
		].filter((part): part is string => part !== undefined);
		return `${agent.agentId} (${detail.join(", ")})`;
	});
	const more = agents.length > listed.length ? `, +${agents.length - listed.length} more` : "";
	return `idle specialists not used: ${listed.join("; ")}${more} — delegate follow_up with an agentId wakes one with its history instead of a new context; retire the ones you are done with`;
}

const DELEGATE_DESCRIPTION_CORE =
	"Coordinate persistent leaf workers. start reuses a compatible idle worker across project sessions; agentId selects one specialist, and busy or ambiguous matches refuse (parallelWork forces a separate context). You own routing: when idle specialists exist, name the recipient with agentId. Reuse keeps grants and history and never widens write scope (start a new worker with writePaths instead). A fresh worker inherits the foreground model, reasoning, compatible tools and machine-wide read access, and writes only inside its cwd plus writePaths; model, thinkingLevel, path and toolNames narrow that base in guarded mode (YOLO ignores them), while readOnly holds in every mode. Completion and replies are event-driven: never poll. Assign work with start or follow_up; broadcast carries common coordination evidence only. The host owns queue, concurrency, budgets, leases and cancellation.";

// Async wiring (`deps.startWorkerDelegation` present): `execute` starts the lane and returns immediately; the
// result surfaces later through the event-driven terminal handoff and a bounded transcript/status read. The
// synchronous wiring awaits `runWorkerDelegation` and answers in the same call, so it omits this suffix.
const ASYNC_DELEGATE_DESCRIPTION_SUFFIX =
	"start returns as soon as the lane starts and its terminal handoff wakes the parent: continue independent work or end the turn, read the report after the handoff (delegate status; transcript pages on demand, or in full when the handoff says h READ_ALL), and use wait/wait_many only when this turn cannot proceed without the result.";

// Fresh-start authority clause; an owner model pin policy replaces it (see createDelegateToolDefinition).
const DELEGATE_AUTHORITY_CLAUSE =
	"Fresh start: omit overrides to inherit; allowed overrides are model, thinkingLevel, path, writePaths, toolNames, with existing ids only.";

function delegatePanelModel(details: DelegateToolDetails | undefined): OrchestrationPanelModel {
	if (!details) {
		return {
			label: "workers",
			action: "dispatch",
			status: "idle",
			emptyText: "No structured worker details were retained.",
		};
	}
	if ("kind" in details) {
		if (details.kind === "events") return delegateEventPanelModel(details);
		return details.kind === "profile" ? delegateProfilePanelModel(details) : delegateStatusPanelModel(details);
	}
	if (!details.started) {
		return {
			label: "workers",
			action: "dispatch skipped",
			status: "warning",
			emptyText: details.skipReason ?? "The worker was not started.",
		};
	}
	const laneStatus = details.status ?? "queued";
	const rowStatus: OrchestrationRowStatus = laneStatus;
	const meta = [
		details.profileId ? `profile ${details.profileId}` : undefined,
		details.modelRef ? `model ${details.modelRef}` : undefined,
		details.thinkingLevel ? `thinking ${details.thinkingLevel}` : undefined,
		details.reasonCode,
		details.accepted === undefined ? undefined : details.accepted ? "accepted" : "not accepted",
		details.costUsd === undefined ? undefined : `$${details.costUsd.toFixed(4)}`,
	].filter((value): value is string => value !== undefined);
	const detailsLines = [
		details.summary ? `untrusted claim: ${details.summary}` : undefined,
		...(details.blockers ?? []).map((blocker) => `blocker: ${blocker}`),
	].filter((value): value is string => value !== undefined);
	const active = laneStatus === "queued" || laneStatus === "running";
	return {
		label: "workers",
		action: active ? "dispatched" : "completed",
		status: active
			? "running"
			: laneStatus === "succeeded" && details.accepted !== false
				? "success"
				: laneStatus === "failed"
					? "error"
					: "warning",
		summary: active ? ["terminal handoff will wake this session"] : undefined,
		rows: [
			{
				status: rowStatus,
				label: details.label ?? details.laneId ?? "worker lane",
				meta: [details.label ? details.laneId : undefined, ...meta].filter(
					(value): value is string => value !== undefined,
				),
				details: detailsLines,
			},
		],
		notices:
			details.accepted === false
				? [{ status: "warning", text: "Worker output was not accepted; inspect and verify before use." }]
				: undefined,
	};
}

function availableDelegateActions(caller: DelegateCaller, deps: DelegateToolDependencies): readonly DelegateAction[] {
	const actions: DelegateAction[] = caller.kind === "session_root" ? ["start"] : [];
	if (deps.workerAgentControl) {
		actions.push(...DELEGATE_CONTROL_ACTIONS);
		if (deps.workerAgentControl.readHostEvents && deps.workerAgentControl.changeHostEventSubscriptions)
			actions.push(...DELEGATE_EVENT_ACTIONS);
		if (deps.resolveMessageReplayScope) actions.push(...DELEGATE_MESSAGE_ACTIONS);
		if (caller.kind === "session_root") actions.push(...DELEGATE_ROOT_CONTROL_ACTIONS);
		else actions.push(...DELEGATE_WORKER_CONTROL_ACTIONS);
	}
	if (caller.kind === "session_root") {
		if (deps.status) {
			actions.push("status");
			if (deps.status.acknowledgeWorkerReview) actions.push("review");
		}
		if (deps.profileWriter) actions.push(...DELEGATE_PROFILE_ACTIONS);
	}
	return actions;
}

function orchestrationProfileDescription(
	profiles: readonly { profileId: string; role: string; description: string }[] | undefined,
): string | undefined {
	if (!profiles || profiles.length === 0) return undefined;
	const visibleProfiles = profiles.slice(0, MAX_VISIBLE_ORCHESTRATION_PROFILES);
	const entries = visibleProfiles.map((profile) => {
		const profileId = profile.profileId.slice(0, MAX_PROFILE_GUIDELINE_FIELD_CHARS);
		const role = profile.role.slice(0, MAX_PROFILE_GUIDELINE_FIELD_CHARS);
		const description = profile.description.slice(0, MAX_PROFILE_GUIDELINE_FIELD_CHARS);
		return `${profileId} (${role}: ${description})`;
	});
	const omitted = profiles.length - visibleProfiles.length;
	return `Worker profiles (${profiles.length}): ${entries.join("; ")}${omitted > 0 ? `; ${omitted} more in the owner profile catalog` : ""}.`;
}

function workerModelPinAuthorityClause(policy: WorkerModelPinPolicy | undefined): string | undefined {
	if (!policy || policy.status === "absent") return undefined;
	if (policy.status === "invalid") {
		return "Invalid owner model pins block fresh starts. Never retry; report the configuration error.";
	}
	return "Owner model pins are hard ceilings: omit conflicting model/thinkingLevel, never evade or retry; start reports the binding.";
}

function normalizeDelegateCaller(value: unknown): DelegateCaller {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("A valid delegate caller is required.");
	}
	const candidate = value as Record<string, unknown>;
	const fields = Object.keys(candidate);
	if (candidate.kind === "session_root" && fields.length === 1 && fields[0] === "kind") {
		return { kind: "session_root" };
	}
	if (
		candidate.kind === "worker" &&
		fields.length === 2 &&
		fields.includes("kind") &&
		fields.includes("agentId") &&
		typeof candidate.agentId === "string"
	) {
		const agentId = candidate.agentId.trim();
		if (agentId && agentId.length <= MAX_ORCHESTRATION_IDENTIFIER_LENGTH) return { kind: "worker", agentId };
	}
	throw new TypeError("A valid delegate caller is required.");
}

/**
 * `scopeKind` selects which part of the host scope bounds the identity. Mailbox coordination is
 * branch-scoped, but a START's durable identity must survive the session leaf moving on: the leaf
 * advances with every appended entry, so a replay that arrives after the task settled would
 * otherwise key differently and admit the same call twice.
 */
function messageIdempotencyKey(
	caller: DelegateCaller,
	scope: { sessionId: string; branchId: string },
	toolCallId: string,
	action: "start" | "send" | "broadcast" | "follow_up",
	scopeKind: "branch" | "session" = "branch",
): string {
	const callerIdentity = caller.kind === "worker" ? `worker:${caller.agentId}` : "session_root";
	const sessionId = scope.sessionId.trim();
	const branchId = scopeKind === "session" ? sessionId : scope.branchId.trim();
	if (
		!sessionId ||
		sessionId.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH ||
		!branchId ||
		branchId.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH
	) {
		throw new TypeError("Delegate message replay scope is invalid.");
	}
	const tuple = [callerIdentity, sessionId, branchId, toolCallId, action];
	return `delegate-message-${createHash("sha256")
		.update("pi-delegate-message-idempotency-v1")
		.update("\0")
		.update(JSON.stringify(tuple))
		.digest("hex")}`;
}

function boundedDelegateControlCollectionJson<Item>(
	items: readonly Item[],
	buildPayload: (selected: readonly Item[], omittedCount: number) => unknown,
	overflow: "stop" | "skip" = "stop",
	onSelected?: (selected: readonly Item[]) => void,
): string {
	const selected: Item[] = [];
	for (const item of items) {
		const candidate = [...selected, item];
		const serialized = JSON.stringify(buildPayload(candidate, items.length - candidate.length));
		if (Buffer.byteLength(serialized, "utf-8") > MAX_DELEGATE_CONTROL_RESULT_BYTES) {
			if (overflow === "stop") break;
			continue;
		}
		selected.push(item);
	}
	let serialized = JSON.stringify(buildPayload(selected, items.length - selected.length));
	while (selected.length > 0 && Buffer.byteLength(serialized, "utf-8") > MAX_DELEGATE_CONTROL_RESULT_BYTES) {
		selected.pop();
		serialized = JSON.stringify(buildPayload(selected, items.length - selected.length));
	}
	if (Buffer.byteLength(serialized, "utf-8") <= MAX_DELEGATE_CONTROL_RESULT_BYTES) {
		onSelected?.(selected);
		return serialized;
	}
	onSelected?.([]);
	return JSON.stringify({ error: "delegate_control_result_oversized", omittedCount: items.length });
}

function boundedBroadcastDetails(results: readonly WorkerAgentBroadcastTargetResult[]): DelegateToolDetails {
	const acceptedCount = results.filter((result) => result.accepted).length;
	const buildDetails = (selected: readonly WorkerAgentBroadcastTargetResult[]): DelegateToolDetails => ({
		started: acceptedCount > 0,
		action: "broadcast",
		agentIds: selected.map(({ agentId }) => agentId),
		accepted: acceptedCount === results.length,
		queued: acceptedCount > 0,
		broadcastResults: selected,
		...(selected.length < results.length ? { broadcastResultsOmitted: results.length - selected.length } : {}),
	});
	const selected: WorkerAgentBroadcastTargetResult[] = [];
	for (const result of results) {
		const candidate = [...selected, result];
		if (Buffer.byteLength(JSON.stringify(buildDetails(candidate)), "utf-8") > MAX_DELEGATE_CONTROL_RESULT_BYTES) {
			continue;
		}
		selected.push(result);
	}
	return buildDetails(selected);
}

function boundedWaitManyDetails(statuses: readonly { agentId: string }[], timedOut: boolean): DelegateToolDetails {
	const agentIds = statuses.map(({ agentId }) => agentId);
	const buildDetails = (selected: readonly string[]): DelegateToolDetails => ({
		started: true,
		action: "wait_many",
		agentIds: selected,
		...(selected.length < agentIds.length ? { agentIdsOmitted: agentIds.length - selected.length } : {}),
		timedOut,
	});
	const selected: string[] = [];
	for (const agentId of agentIds) {
		const candidate = [...selected, agentId];
		if (Buffer.byteLength(JSON.stringify(buildDetails(candidate)), "utf-8") > MAX_DELEGATE_CONTROL_RESULT_BYTES) {
			break;
		}
		selected.push(agentId);
	}
	return buildDetails(selected);
}

function sessionRootReplyJson(replies: readonly SessionRootReply[], timedOut?: boolean, steered = false): string {
	return boundedDelegateControlCollectionJson(replies, (selected, omittedCount) => ({
		...(timedOut === undefined ? {} : { timedOut }),
		...(timedOut
			? boundedWaitTimeoutProjection(
					"explicit_replies_only",
					"Use delegate wait/wait_many for worker completion. Never interrupt solely because this bounded inbox wait timed out.",
				)
			: {}),
		...(steered && selected.length === 0 ? waitSteeredProjection("explicit_replies_only", "replies") : {}),
		replies: selected,
		omittedCount,
	}));
}

function boundedWaitTimeoutProjection(observes: string, nextAction: string) {
	return {
		waitState: "nonterminal" as const,
		observes,
		workerStallProven: false,
		reasonCode: "bounded_wait_elapsed" as const,
		nextAction,
		h: ["WAIT_ELAPSED"] as readonly CommsStateCode[],
	};
}

/**
 * A wait the owner's input ended before what it waited for arrived. It is neither a timeout nor a stall: the wait
 * returned so the input is not held behind it, and the waited work keeps going.
 */
function waitSteeredProjection(observes: string, awaited: string) {
	return {
		steered: true as const,
		waitState: "nonterminal" as const,
		observes,
		workerStallProven: false,
		reasonCode: "wait_steered" as const,
		nextAction: `Wait steered: the owner sent input while this wait ran, so the wait returned early to let it through. The awaited ${awaited} still arrive; never interrupt because of this wait.`,
	};
}

function workerWaitTimeoutProjection(statuses: readonly WorkerAgentActivity[]) {
	if (statuses.length > 0 && statuses.every((status) => status === "idle")) {
		return {
			...boundedWaitTimeoutProjection(
				"worker_activity",
				"Returned workers are now idle. The bounded deadline elapsed before this result was delivered. Read status/transcript and continue reconciliation; never interrupt solely because the deadline elapsed.",
			),
			waitState: "completed_after_timeout" as const,
		};
	}
	return boundedWaitTimeoutProjection(
		"worker_activity",
		"Review the returned worker statuses; active, suspended, or unknown work remains nonterminal. Never interrupt solely because this bounded wait timed out; continue independent work or issue another event-driven dependency wait.",
	);
}

function workerWaitProjection(
	statuses: readonly WorkerAgentActivity[],
	timedOut: boolean,
	foregroundHeld = false,
	steered = false,
) {
	if (foregroundHeld) {
		return {
			waitState: "nonterminal" as const,
			observes: "worker_activity" as const,
			workerStallProven: false,
			workerCompletionMissed: false,
			workerHarnessFailureProven: false,
			reasonCode: "worker_held_for_foreground" as const,
			nextAction:
				"This worker shares the local model with this turn, so it starts by itself when the turn ends; waiting now cannot help. Continue other work, or end your turn: its terminal handoff wakes you. Do not wait again.",
			h: ["HELD"] as readonly CommsStateCode[],
		};
	}
	if (timedOut) return workerWaitTimeoutProjection(statuses);
	if (statuses.length > 0 && statuses.every((status) => status === "idle")) {
		return {
			waitState: "completed" as const,
			observes: "worker_activity" as const,
			workerStallProven: false,
			workerCompletionMissed: false,
			workerHarnessFailureProven: false,
			reasonCode: "worker_idle" as const,
			nextAction:
				"Read the terminal report with delegate status (session root): each lane names its reading mode (h READ_REPORT or READ_ALL) before you judge the claim. Inbox actions observe explicit replies only.",
			h: ["IDLE"] as readonly CommsStateCode[],
		};
	}
	if (steered) return waitSteeredProjection("worker_activity", "worker terminals");
	if (!statuses.includes("suspended")) return {};
	return {
		waitState: "nonterminal" as const,
		observes: "worker_activity" as const,
		workerStallProven: false,
		workerCompletionMissed: false,
		reasonCode: "worker_suspended" as const,
		nextAction:
			"Continue independent work; host-owned transient retry resumes automatically and the terminal handoff notifies the parent.",
		h: ["SUSPENDED"] as readonly CommsStateCode[],
	};
}

function workerTaskSessionJson(
	view: ReturnType<WorkerAgentControlPort["getWorkerTaskSessionView"]>,
	onSelectedTasks?: (tasks: readonly WorkerTaskSessionView["tasks"][number][]) => void,
): string {
	const hasQueuedTask = view.tasks.some((task) => task.latestAttempt?.status === "queued");
	return boundedDelegateControlCollectionJson(
		view.tasks,
		(tasks, omittedCount) => ({
			totalTasks: view.totalTasks,
			omittedTaskCount: view.omittedTaskCount + omittedCount,
			...(hasQueuedTask
				? {
						queueState: "admitted_nonterminal" as const,
						workerStallProven: false,
						workerHarnessFailureProven: false,
						h: ["QUEUED"] as readonly CommsStateCode[],
					}
				: {}),
			tasks,
		}),
		"skip",
		(selected) => onSelectedTasks?.(selected),
	);
}

/**
 * The single normalization from one `delegate start` call to the host request. Both start entrances
 * -- anonymous and explicitly named with options -- describe the same admitted command, so they build
 * it here instead of each repeating the authority, fork and task-context shaping.
 */
function buildDelegateStartRequest(input: {
	instructions: string;
	/** The structured task `instructions` was rendered from; stored beside it on the dispatch. */
	brief?: TaskBrief;
	toolInput: DelegateToolInput;
	requirementIds: readonly string[];
	dependsOnTaskIds?: readonly string[];
	messageReplayKey?: string;
	reuseAgentId?: string;
}): WorkerDelegationRequest {
	const tool = input.toolInput;
	// A requirement is met on a command receipt or a recorded change. A read-only worker whose tools run no command has neither,
	// so its report could never meet a requirement: refuse the dispatch instead of burning a run that ends needs_more.
	if (
		input.requirementIds.length > 0 &&
		tool.readOnly === true &&
		tool.toolNames !== undefined &&
		!tool.toolNames.some(isReceiptTool)
	) {
		throw new Error(
			"requirementIds need proof a read-only worker can only give through a command: add bash, run_process or python to toolNames, or drop requirementIds.",
		);
	}
	const profileId = tool.profileId?.trim();
	const hasAuthority =
		tool.model !== undefined ||
		tool.thinkingLevel !== undefined ||
		tool.path !== undefined ||
		tool.writePaths !== undefined ||
		tool.toolNames !== undefined ||
		tool.readOnly !== undefined;
	return {
		instructions: input.instructions,
		...(tool.knowledge !== undefined ? { knowledge: parseKnowledgeGrantReferences(tool.knowledge) } : {}),
		...(tool.subscriptions !== undefined ? { subscriptions: tool.subscriptions } : {}),
		...(input.brief ? { brief: input.brief } : {}),
		...(input.messageReplayKey ? { messageReplayKey: input.messageReplayKey } : {}),
		...(input.reuseAgentId ? { reuseAgentId: input.reuseAgentId } : {}),
		...(profileId ? { profileId } : {}),
		...(hasAuthority
			? {
					authority: {
						...(tool.model ? { model: structuredClone(tool.model) } : {}),
						...(tool.thinkingLevel ? { thinkingLevel: tool.thinkingLevel } : {}),
						...(tool.path ? { path: tool.path } : {}),
						...(tool.writePaths ? { writePaths: [...tool.writePaths] } : {}),
						...(tool.toolNames ? { toolNames: [...tool.toolNames] } : {}),
						...(tool.readOnly !== undefined ? { readOnly: tool.readOnly } : {}),
					},
				}
			: {}),
		...(tool.forkTurns ? { forkTurns: tool.forkTurns } : {}),
		// A named recipient is already the caller's routing decision and runs alongside any other worker;
		// parallelWork only asks for a separate context when no recipient is named.
		...(tool.parallelWork && !tool.agentId ? { parallelWork: parseWorkerParallelWorkIntent(tool.parallelWork) } : {}),
		...(input.dependsOnTaskIds || input.requirementIds.length > 0
			? {
					taskContext: {
						requirementIds: [...input.requirementIds],
						dependsOnTaskIds: [...(input.dependsOnTaskIds ?? [])],
						acceptanceCriterionIds: [],
						resourcePointerIds: [],
					},
				}
			: {}),
	};
}

/**
 * `delegate start` with `slices` or `race`: one ordinary start per member under one fan-out group. Every
 * member passes the same admission as any start (grant, fleet caps, verifier headroom, budgets, the
 * queue); the group only adds the declaration up front, a headroom check for all members before the
 * first starts, and attribution afterwards. A member the host refuses is reported, never retried
 * around, and a partition still lists it as a slice with no result.
 */
async function executeDelegateFanoutStart(args: {
	deps: DelegateToolDependencies;
	caller: DelegateCaller;
	toolCallId: string;
	input: DelegateToolInput;
	instructions: string;
	requirementIds: readonly string[];
	dependsOnTaskIds: readonly string[] | undefined;
	signal: AbortSignal | undefined;
}): Promise<{ content: Array<{ type: "text"; text: string }>; details: DelegateToolDetails; isError?: true }> {
	const { deps, caller, input } = args;
	const fail = (text: string, skipReason: string) =>
		refusalResult(delegateRejection(skipReason, text), { started: false, action: "start" as const, skipReason });
	if (caller.kind !== "session_root") {
		return fail("delegate slices/race are available only to the session root", "root_only_action");
	}
	const startWorker = deps.startWorkerDelegation;
	if (!startWorker) {
		return fail(
			"delegate slices/race need the asynchronous worker wiring; start the workers one by one instead",
			"fanout_unavailable",
		);
	}
	const replayScope = deps.resolveMessageReplayScope?.();
	const groupId = `fo-${createHash("sha256")
		.update("pi-delegate-fanout-v1\0")
		.update(replayScope?.sessionId ?? "")
		.update("\0")
		.update(args.toolCallId)
		.digest("hex")
		.slice(0, 8)}`;
	let plan: ReturnType<typeof planFanout>;
	try {
		plan = planFanout({
			groupId,
			instructions: args.instructions,
			declaration: {
				...(input.slices ? { slices: input.slices } : {}),
				...(input.race !== undefined ? { race: input.race } : {}),
			},
		});
	} catch (error) {
		if (error instanceof WorkerFanoutError) return fail(`delegate not started: ${error.message}`, error.skipReason);
		throw error;
	}
	const started: { memberId: string; record: LaneRecord }[] = [];
	const refused: { memberId: string; reason: string }[] = [];
	for (const [index, member] of plan.members.entries()) {
		args.signal?.throwIfAborted();
		const base = buildDelegateStartRequest({
			instructions: member.instructions,
			toolInput: input,
			requirementIds: args.requirementIds,
			...(replayScope
				? {
						messageReplayKey: messageIdempotencyKey(
							caller,
							replayScope,
							`${args.toolCallId}#${member.memberId}`,
							"start",
							"session",
						),
					}
				: {}),
			...(args.dependsOnTaskIds ? { dependsOnTaskIds: args.dependsOnTaskIds } : {}),
		});
		const request: WorkerDelegationRequest = {
			...base,
			// A member is deliberately a separate context beside its siblings and any compatible specialist.
			parallelWork: {
				independentOf: started.flatMap(({ record }) => [record.agentId ?? record.laneId]),
				justification: `fan-out ${groupId} member ${member.memberId}`,
			},
			fanoutRemaining: plan.members.length - index,
		};
		try {
			const outcome = await startWorker(request, args.signal);
			if (outcome.started) started.push({ memberId: member.memberId, record: outcome.record });
			else refused.push({ memberId: member.memberId, reason: outcome.skipReason });
		} catch (error) {
			if (args.signal?.aborted) throw error;
			refused.push({
				memberId: member.memberId,
				reason: (error instanceof Error ? error.message : String(error)).slice(0, 200),
			});
		}
	}
	const members = plan.members.map(({ memberId }) => {
		const hit = started.find((entry) => entry.memberId === memberId);
		const miss = refused.find((entry) => entry.memberId === memberId);
		return {
			memberId,
			...(hit ? { laneId: hit.record.laneId, agentId: hit.record.agentId ?? hit.record.laneId } : {}),
			...(miss ? { skipReason: miss.reason } : {}),
		};
	});
	if (started.length === 0) {
		const firstReason = refused[0]?.reason ?? "not_started";
		return refusalResult(delegateStartRejection(firstReason), {
			started: false,
			action: "start",
			skipReason: firstReason,
			fanout: { groupId, kind: plan.kind, members },
		});
	}
	const queuedLine = started.some(({ record }) => record.status === "queued")
		? renderCommsStateLine(["QUEUED"])
		: undefined;
	const noun = plan.kind === "partition" ? "slices" : "candidates";
	const lines = [
		`fan-out ${groupId} (${plan.kind}, ${plan.members.length} ${noun}): ${started.length} started`,
		...started.map(
			({ memberId, record }) =>
				`- ${memberId}: lane ${record.laneId} agent ${record.agentId ?? record.laneId} (${record.status})`,
		),
		...refused.map(({ memberId, reason }) => `- ${memberId}: NOT STARTED (${reason})`),
		...(refused.length > 0 && plan.kind === "partition"
			? [
					"No worker covers the slices that did not start: the group reports each as a coverage gap. Start them separately if the work is still needed.",
				]
			: []),
		plan.kind === "partition"
			? "Coverage: delegate status lists the group and every terminal handoff carries its line; a slice with no accepted result is a finding, never a block on other work."
			: "Race: the first accepted result wins and the host cancels the other candidates; each terminal handoff carries the outcome.",
		...(queuedLine ? [queuedLine] : []),
	];
	const first = started[0]?.record;
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			started: true,
			action: "start",
			agentIds: started.map(({ record }) => record.agentId ?? record.laneId),
			...(first ? { laneId: first.laneId, status: first.status } : {}),
			...(queuedLine ? { h: ["QUEUED" as const] } : {}),
			fanout: { groupId, kind: plan.kind, members },
		},
	};
}

export function createDelegateToolDefinition(deps: DelegateToolDependencies): ToolDefinition {
	const caller = normalizeDelegateCaller(deps.caller);
	const isAsyncWiring = deps.startWorkerDelegation !== undefined;
	const profileDescription = orchestrationProfileDescription(deps.orchestrationProfiles);
	// An owner model pin policy replaces the fresh-start authority clause.
	const authorityClause = workerModelPinAuthorityClause(deps.workerModelPinPolicy) ?? DELEGATE_AUTHORITY_CLAUSE;
	const availableActions = availableDelegateActions(caller, deps);
	// One window of refused calls per session and caller: a definition is built for exactly one of each.
	const rejections = new RepeatedRejectionDetector();
	return {
		name: "delegate",
		label: "delegate",
		description: [
			DELEGATE_DESCRIPTION_CORE,
			authorityClause,
			...(profileDescription ? [profileDescription] : []),
			...(isAsyncWiring ? [ASYNC_DELEGATE_DESCRIPTION_SUFFIX] : []),
		].join(" "),
		promptSnippet: "Persistent leaf workers",
		neverDefer: true,
		parameters: createDelegateSchema(availableActions),
		// The flat wire schema exposes profile_create's `task` (3,500-char cap) beside start's
		// `instructions` (16k cap). `sanitizeExactActionInput` already folds a start that only
		// supplied `task` onto `instructions`, but it runs after schema validation, so a long brief
		// was refused by the wrong cap. Apply the same fold before validation.
		prepareArguments(args: unknown) {
			if (!args || typeof args !== "object" || Array.isArray(args)) return args as DelegateToolInput;
			const input = args as Record<string, unknown>;
			const action = input.action ?? "start";
			if (action !== "start" || typeof input.task !== "string" || typeof input.instructions === "string") {
				return args as DelegateToolInput;
			}
			const { task, ...rest } = input;
			return { ...rest, instructions: task } as DelegateToolInput;
		},
		renderShell: "self",
		foregroundWait: (input: { action?: unknown }) =>
			input.action === "wait" || input.action === "wait_many" || input.action === "inbox_wait",
		renderCall() {
			return emptyOrchestrationCall();
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as DelegateToolDetails | undefined;
			return renderOrchestrationToolResult(theme, delegatePanelModel(details), {
				isPartial,
				collapse: !expanded && details?.started === true && !("kind" in details && details.kind === "error"),
				expanded,
			});
		},
		// The kernel shows the model a failed call's record, not the call's own result; the refusal view (its reason, and
		// for an input refusal the schema fragment and remedies) reaches the model as that record's evidence.
		failureRecovery: { getFailureEvidence: (_params, failure) => failure.message },
		execute: screenedExecution(availableActions, rejections, async (toolCallId, screened, signal) => {
			const { action, input, brief, agentIds, dependsOnTaskIds } = screened;
			// Every refusal is an `err` record: the class, field and hint come from the skip reason's table entry.
			const invalid = (message: string, actionDetails: DelegateToolDetails, overrides?: RejectionOverrides) =>
				refusalResult(delegateRejection(actionDetails.skipReason, message, overrides), actionDetails);
			const requireAgentId = (): string | undefined => {
				const agentId = input.agentId?.trim();
				if (agentId) return agentId;
				return undefined;
			};
			const workerScope = caller.kind === "worker" ? { callerAgentId: caller.agentId } : undefined;
			try {
				if (action === "events" || action === "subscriptions") {
					const control = deps.workerAgentControl;
					if (!control?.readHostEvents || !control.changeHostEventSubscriptions)
						throw new Error("Task event controls are unavailable.");
					return executeDelegateEventAction(
						action,
						input,
						{
							readHostEvents: control.readHostEvents.bind(control),
							changeHostEventSubscriptions: control.changeHostEventSubscriptions.bind(control),
						},
						workerScope,
					);
				}
				if (action === "status" || action === "review") {
					if (caller.kind !== "session_root") {
						return invalid(`delegate ${action} is available only to the session root`, {
							started: false,
							action,
							skipReason: "root_only_action",
						});
					}
					if (!deps.status) {
						return invalid(`delegate ${action} is unavailable`, {
							started: false,
							action,
							skipReason: "worker_status_unavailable",
						});
					}
					const readLastText = deps.workerAgentControl?.readWorkerAgentLastText?.bind(deps.workerAgentControl);
					const status = {
						...deps.status,
						...(readLastText
							? {
									getLastWorkerText: (record: LaneRecord) => {
										if (!record.agentId) return undefined;
										try {
											return readLastText(record.agentId, record.laneId, workerScope ?? {});
										} catch (error) {
											// Status still answers; the missing words are named, not hidden.
											return `(last words unavailable: ${error instanceof Error ? error.message : String(error)})`;
										}
									},
								}
							: {}),
					};
					let statusRecords: LaneRecord[] | undefined;
					let exposedStatusRecords: readonly LaneRecord[] | undefined;
					const statusDependencies =
						action === "status"
							? {
									...status,
									getLaneRecords: () => {
										const records = status.getLaneRecords();
										statusRecords = records;
										return records;
									},
									observeExposedTerminalRecords: (records: readonly LaneRecord[]) => {
										exposedStatusRecords = records;
									},
								}
							: status;
					let laneId = input.laneId?.trim() || undefined;
					let resolvedFromAgent: string | undefined;
					const statusAgentId = input.agentId?.trim();
					if (!laneId && statusAgentId) {
						// An agent identity names its latest task lane; a status question about an agent
						// has that one exact answer, so it is resolved instead of refused.
						const resolver = deps.workerAgentControl?.resolveWorkerAgentLane;
						if (!resolver) {
							return invalid(
								`delegate ${action} cannot resolve agentId here; use the laneId from the status overview`,
								{
									started: false,
									action,
									agentId: statusAgentId,
									skipReason: "worker_agent_control_unavailable",
								},
							);
						}
						const resolved = resolver.call(deps.workerAgentControl, statusAgentId);
						if (!resolved) {
							return invalid(
								`delegate ${action}: worker ${statusAgentId} has no task lane yet; nothing was inspected or acknowledged`,
								{ started: false, action, agentId: statusAgentId, skipReason: "worker_agent_lane_missing" },
							);
						}
						laneId = resolved.laneId;
						resolvedFromAgent = `${statusAgentId} → lane ${resolved.laneId} (latest task, ${resolved.status})`;
					}
					const rawStatusResult = executeDelegateStatusAction(action, { laneId }, statusDependencies);
					const statusResult = resolvedFromAgent
						? {
								...rawStatusResult,
								content: rawStatusResult.content.map((item, index) =>
									index === 0 && item.type === "text"
										? { ...item, text: `resolved ${resolvedFromAgent}\n${item.text}` }
										: item,
								),
								details: { ...rawStatusResult.details, agentId: statusAgentId },
							}
						: rawStatusResult;
					if (action === "status") {
						if (exposedStatusRecords !== undefined && statusRecords !== undefined) {
							const exposed = new Set(exposedStatusRecords);
							const observed =
								exposed.size === statusRecords.length
									? statusRecords
									: statusRecords.filter((record) => exposed.has(record));
							deps.workerAgentControl?.observeWorkerTerminalRecords?.(observed);
						}
					}
					const fanoutGroups =
						action === "status" && !laneId ? deps.workerAgentControl?.getWorkerFanoutGroups?.() : undefined;
					if (!fanoutGroups || fanoutGroups.length === 0) return statusResult;
					// Group coverage and race outcomes ride the overview: attribution, never a gate.
					const groupLines = fanoutGroups.slice(-8).map((group) => `- ${formatFanoutGroupLine(group)}`);
					return {
						...statusResult,
						content: statusResult.content.map((item, index) =>
							index === 0 && item.type === "text"
								? { ...item, text: `${item.text}\nFan-out groups:\n${groupLines.join("\n")}` }
								: item,
						),
					};
				}
				if (action === "profile_inspect" || action === "profile_create") {
					if (caller.kind !== "session_root") {
						return invalid(`delegate ${action} is available only to the session root`, {
							started: false,
							action,
							skipReason: "root_only_action",
						});
					}
					if (!deps.profileWriter) {
						return invalid(`delegate ${action} is unavailable`, {
							started: false,
							action,
							skipReason: "profile_management_unavailable",
						});
					}
					return executeDelegateProfileAction(action, input, deps.profileWriter);
				}
				if (action === "tasks") {
					if (!deps.workerAgentControl) {
						return invalid("delegate tasks is unavailable", {
							started: false,
							action,
							skipReason: "worker_agent_control_unavailable",
						});
					}
					let exposedTasks: readonly WorkerTaskSessionView["tasks"][number][] = [];
					const text = workerTaskSessionJson(deps.workerAgentControl.getWorkerTaskSessionView(), (tasks) => {
						exposedTasks = tasks;
					});
					deps.workerAgentControl.observeWorkerAttemptTerminals?.(
						exposedTasks.flatMap((task) => (task.latestAttempt?.attemptId ? [task.latestAttempt.attemptId] : [])),
					);
					return {
						content: [
							{
								type: "text" as const,
								text,
							},
						],
						details: { started: true, action },
					};
				}
				if (action === "list") {
					if (!deps.workerAgentControl)
						return invalid("delegate list is unavailable", {
							started: false,
							action,
							skipReason: "worker_agent_control_unavailable",
						});
					const agents = workerScope
						? deps.workerAgentControl.listWorkerAgents(workerScope)
						: deps.workerAgentControl.listWorkerAgents();
					const cursor = input.cursor ?? 0;
					if (cursor > agents.length)
						return invalid("delegate list cursor exceeds the agent count", {
							started: false,
							action,
							skipReason: "cursor_out_of_range",
						});
					const pageSize = input.maxMessages ?? MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES;
					const page = agents.slice(cursor, cursor + pageSize);
					let exposedAgents: readonly WorkerAgentView[] = [];
					const text = boundedDelegateControlCollectionJson(
						page,
						(selected, omittedCount) => {
							const nextCursor = cursor + selected.length;
							return {
								cursor,
								totalAgents: agents.length,
								agents: selected,
								...(nextCursor < agents.length ? { nextCursor } : {}),
								...(omittedCount > 0 ? { omittedCount } : {}),
							};
						},
						"stop",
						(selected) => {
							exposedAgents = selected;
						},
					);
					deps.workerAgentControl.observeWorkerAttemptTerminals?.(
						exposedAgents.flatMap((agent) => (agent.attemptId ? [agent.attemptId] : [])),
					);
					return {
						content: [
							{
								type: "text" as const,
								text,
							},
						],
						details: { started: true, action },
					};
				}
				if (action === "inbox" || action === "inbox_wait" || action === "inbox_ack") {
					if (caller.kind !== "session_root") {
						return invalid(`delegate ${action} is available only to the session root`, {
							started: false,
							action,
							skipReason: "root_only_action",
						});
					}
					if (!deps.workerAgentControl) {
						return invalid(`delegate ${action} is unavailable`, {
							started: false,
							action,
							skipReason: "worker_agent_control_unavailable",
						});
					}
					if (action === "inbox_ack") {
						const messageId = input.messageId?.trim();
						const ackToken = input.ackToken;
						if (!messageId || !ackToken) {
							return invalid("delegate inbox_ack requires messageId and ackToken", {
								started: false,
								action,
								skipReason: "missing_ack_identity",
							});
						}
						const accepted = deps.workerAgentControl.acknowledgeSessionRootReply(messageId, ackToken);
						return {
							content: [
								{
									type: "text" as const,
									text: accepted
										? `session-root reply ${messageId} acknowledged`
										: `session-root reply ${messageId} was not found`,
								},
							],
							details: { started: accepted, action, messageId, accepted },
						};
					}
					const sourceAgentId = input.agentId?.trim();
					const requestMessageId = input.requestMessageId?.trim();
					const query = {
						...(sourceAgentId ? { sourceAgentId } : {}),
						...(requestMessageId ? { requestMessageId } : {}),
						maxMessages: input.maxMessages ?? MAX_WORKER_TRANSCRIPT_PAGE_MESSAGES,
					};
					if (action === "inbox") {
						const replies = deps.workerAgentControl.listSessionRootReplies(query);
						return {
							content: [{ type: "text" as const, text: sessionRootReplyJson(replies) }],
							details: { started: true, action },
						};
					}
					const waited = await deps.workerAgentControl.waitForSessionRootReplies({
						...query,
						...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
						...(signal ? { signal } : {}),
					});
					return {
						content: [
							{
								type: "text" as const,
								text: sessionRootReplyJson(waited.replies, waited.timedOut, waited.steered !== undefined),
							},
						],
						details: {
							started: true,
							action,
							timedOut: waited.timedOut,
							...(waited.steered !== undefined ? { steered: true } : {}),
						},
					};
				}
				if (action === "reply") {
					if (caller.kind !== "worker") {
						return invalid("delegate reply is available only to workers", {
							started: false,
							action,
							skipReason: "worker_only_action",
						});
					}
					const message = input.message?.trim();
					const replyToMessageId = input.replyToMessageId?.trim();
					if (!message || !replyToMessageId) {
						return invalid("delegate reply requires message and replyToMessageId", {
							started: false,
							action,
							skipReason: "missing_reply_fields",
						});
					}
					if (!deps.workerAgentControl) {
						return invalid("delegate reply is unavailable", {
							started: false,
							action,
							skipReason: "worker_agent_control_unavailable",
						});
					}
					const outcome = deps.workerAgentControl.replyToWorkerAgentMessage(
						caller.agentId,
						message,
						replyToMessageId,
					);
					return {
						content: [
							{
								type: "text" as const,
								text: `reply ${outcome.messageId} accepted for ${outcome.destination}`,
							},
						],
						details: {
							started: true,
							action,
							messageId: outcome.messageId,
							accepted: true,
							queued: true,
							...(outcome.destination === "worker"
								? {
										laneId: outcome.record?.laneId,
										status: outcome.record?.status,
										skipReason: outcome.skipReason,
									}
								: {}),
						},
					};
				}
				if (action === "wait_many" || action === "broadcast") {
					if (!agentIds) {
						return invalid(`delegate ${action} requires agentIds`, {
							started: false,
							action,
							skipReason: "missing_agent_ids",
						});
					}
					if (!deps.workerAgentControl) {
						return invalid(`delegate ${action} is unavailable`, {
							started: false,
							action,
							skipReason: "worker_agent_control_unavailable",
						});
					}
					if (action === "wait_many") {
						if (!input.mode) {
							return invalid("delegate wait_many requires mode any or all", {
								started: false,
								action,
								skipReason: "missing_wait_mode",
							});
						}
						const waited = workerScope
							? await deps.workerAgentControl.waitForWorkerAgents(
									agentIds,
									input.mode,
									input.timeoutMs,
									workerScope,
									signal,
								)
							: await deps.workerAgentControl.waitForWorkerAgents(
									agentIds,
									input.mode,
									input.timeoutMs,
									{
										returnWhenForegroundHeld: true,
									},
									signal,
								);
						return {
							content: [
								{
									type: "text" as const,
									text: boundedDelegateControlCollectionJson(waited.statuses, (statuses, omittedCount) => {
										const includedAgentIds = new Set(statuses.map(({ agentId }) => agentId));
										return {
											statuses,
											updatedAgentIds: waited.updatedAgentIds.filter((agentId) =>
												includedAgentIds.has(agentId),
											),
											timedOut: waited.timedOut,
											...workerWaitProjection(
												waited.statuses.map(({ status }) => status),
												waited.timedOut,
												waited.foregroundHeldAgentIds !== undefined,
												waited.steered !== undefined,
											),
											...(waited.foregroundHeldAgentIds
												? { foregroundHeldAgentIds: waited.foregroundHeldAgentIds }
												: {}),
											...(omittedCount > 0 ? { omittedCount } : {}),
										};
									}),
								},
							],
							details: {
								...boundedWaitManyDetails(waited.statuses, waited.timedOut),
								...(waited.steered !== undefined ? { steered: true } : {}),
							},
						};
					}
					const message = input.message?.trim();
					if (!message) {
						return invalid("delegate broadcast requires message", {
							started: false,
							action,
							skipReason: "missing_message",
						});
					}
					const replayScope = deps.resolveMessageReplayScope?.();
					if (!replayScope) {
						return invalid("delegate broadcast requires a durable message replay scope", {
							started: false,
							action,
							skipReason: "message_replay_scope_unavailable",
						});
					}
					const outcome = deps.workerAgentControl.broadcastWorkerAgentMessage(agentIds, message, {
						...(caller.kind === "worker" ? { senderAgentId: caller.agentId } : {}),
						...(input.threadId ? { threadId: input.threadId.trim() } : {}),
						...(input.expectReply === true ? { expectReply: true } : {}),
						idempotencyKey: messageIdempotencyKey(caller, replayScope, toolCallId, "broadcast"),
					});
					const boundedDetails = boundedBroadcastDetails(outcome.results);
					return {
						content: [
							{
								type: "text" as const,
								text: boundedDelegateControlCollectionJson(outcome.results, (results, omittedCount) => ({
									results,
									...(omittedCount > 0 ? { omittedCount } : {}),
								})),
							},
						],
						details: boundedDetails,
					};
				}
				if (action !== "start") {
					const agentId = requireAgentId();
					if (!agentId)
						return invalid(`delegate ${action} requires agentId`, {
							started: false,
							action,
							skipReason: "missing_agent_id",
						});
					if (action === "transcript") {
						if (!deps.workerAgentControl)
							return invalid("delegate transcript is unavailable", {
								started: false,
								action,
								agentId,
								skipReason: "worker_agent_control_unavailable",
							});
						const page = deps.workerAgentControl.readWorkerAgentTranscript(agentId, {
							...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
							...(input.maxMessages !== undefined ? { maxMessages: input.maxMessages } : {}),
							maxBytes: MAX_DELEGATE_TRANSCRIPT_MESSAGE_BYTES,
							...(workerScope ?? {}),
						});
						const serialized = JSON.stringify(page);
						if (Buffer.byteLength(serialized, "utf-8") > MAX_DELEGATE_CONTROL_RESULT_BYTES) {
							return invalid("delegate transcript exceeded its bounded response envelope", {
								started: false,
								action,
								agentId,
								skipReason: "worker_transcript_envelope_exceeded",
							});
						}
						return {
							content: [{ type: "text" as const, text: serialized }],
							details: { started: true, action, agentId },
						};
					}
					if (action === "wait") {
						if (!deps.workerAgentControl)
							return invalid("delegate wait is unavailable", {
								started: false,
								action,
								agentId,
								skipReason: "worker_agent_control_unavailable",
							});
						const waited = workerScope
							? await deps.workerAgentControl.waitForWorkerAgent(agentId, input.timeoutMs, workerScope, signal)
							: await deps.workerAgentControl.waitForWorkerAgent(
									agentId,
									input.timeoutMs,
									{
										returnWhenForegroundHeld: true,
									},
									signal,
								);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										agentId,
										status: waited.status,
										timedOut: waited.timedOut,
										...workerWaitProjection(
											[waited.status],
											waited.timedOut,
											waited.foregroundHeld === true,
											waited.steered !== undefined,
										),
									}),
								},
							],
							details: {
								started: true,
								action,
								agentId,
								timedOut: waited.timedOut,
								...(waited.steered !== undefined ? { steered: true } : {}),
							},
						};
					}
					if (action === "send" || action === "follow_up") {
						const message = input.message?.trim();
						if (!message)
							return invalid(`delegate ${action} requires message`, {
								started: false,
								action,
								agentId,
								skipReason: "missing_message",
							});
						if (!deps.workerAgentControl)
							return invalid(`delegate ${action} is unavailable`, {
								started: false,
								action,
								agentId,
								skipReason: "worker_agent_control_unavailable",
							});
						const replayScope = deps.resolveMessageReplayScope?.();
						if (!replayScope) {
							return invalid(`delegate ${action} requires a durable message replay scope`, {
								started: false,
								action,
								agentId,
								skipReason: "message_replay_scope_unavailable",
							});
						}
						const idempotencyKey = messageIdempotencyKey(caller, replayScope, toolCallId, action);
						const messageOptions = {
							...(input.threadId ? { threadId: input.threadId.trim() } : {}),
							...(input.expectReply === true ? { expectReply: true } : {}),
							idempotencyKey,
						};
						if (action === "send") {
							const outcome =
								caller.kind === "session_root"
									? deps.workerAgentControl.sendSessionRootWorkerAgentMessage(agentId, message, messageOptions)
									: deps.workerAgentControl.sendWorkerAgentMessage(agentId, message, {
											...messageOptions,
											senderAgentId: caller.agentId,
										});
							return {
								content: [
									{
										type: "text" as const,
										text: `message ${outcome.messageId} queued for ${agentId}; it will not wake the worker`,
									},
								],
								details: {
									started: true,
									action,
									agentId,
									messageId: outcome.messageId,
									queued: outcome.queued,
								},
							};
						}
						const outcome =
							caller.kind === "session_root"
								? deps.workerAgentControl.followUpSessionRootWorkerAgent(agentId, message, messageOptions)
								: deps.workerAgentControl.followUpWorkerAgent(agentId, message, {
										...messageOptions,
										senderAgentId: caller.agentId,
									});
						const details = {
							started: outcome.started,
							action,
							agentId,
							messageId: outcome.messageId,
							laneId: outcome.record?.laneId,
							status: outcome.record?.status,
							skipReason: outcome.skipReason,
						};
						const reason = outcome.skipReason?.slice(0, MAX_DELEGATE_ERROR_CHARS);
						if (!outcome.messageId) {
							return invalid(
								`delegate follow_up was not accepted for ${agentId}: ${reason ?? "not_started"}`,
								details,
							);
						}
						// An accepted message waits in the mailbox while its worker is suspended, running or still
						// releasing resources; the host starts it when the worker is idle again. A failed release
						// names what the turn waits for instead: the host's retry, or nothing in this session.
						const releaseHold = parseSpecialistReleaseHold(outcome.skipReason);
						const waitsForIdle =
							!outcome.started &&
							!outcome.steering &&
							(outcome.skipReason === "worker_suspended" ||
								outcome.skipReason === "worker_active" ||
								outcome.skipReason === "worker_cleanup_pending" ||
								releaseHold !== undefined);
						const state = outcome.started
							? "started"
							: outcome.steering
								? "steering queued"
								: waitsForIdle
									? "queued, not started"
									: "not started";
						const idleNote = !waitsForIdle
							? ""
							: releaseHold === undefined
								? ` It runs when ${agentId} returns to idle.`
								: releaseHold.retained
									? ` It runs when the host's retry releases ${agentId}'s resources.`
									: ` It stays queued: nothing retries ${agentId}'s failed release in this session.`;
						const followUpWaiting = queuedWaitLine(outcome.record);
						const lane = outcome.record
							? `; lane ${outcome.record.laneId} (${outcome.record.status}${followUpWaiting ? `; ${followUpWaiting}` : ""})`
							: "";
						return {
							content: [
								{
									type: "text" as const,
									text: withStateLine(
										`follow_up ${outcome.messageId} ${state} for ${agentId}${lane}${reason ? `; reason ${reason}` : ""}.${idleNote}`,
										["ACCEPTED"],
									),
								},
							],
							details: { ...details, h: ["ACCEPTED"] },
						};
					}
					if (action === "interrupt") {
						if (!deps.workerAgentControl)
							return invalid("delegate interrupt is unavailable", {
								started: false,
								action,
								agentId,
								skipReason: "worker_agent_control_unavailable",
							});
						const haltReason = input.message?.trim() || undefined;
						const outcome = deps.workerAgentControl.interruptWorkerAgent(agentId, workerScope, {
							...(haltReason ? { message: haltReason } : {}),
						});
						const interruptText = !outcome.interrupted
							? outcome.reason === "agent_not_running"
								? `worker ${agentId} was not interrupted (agent_not_running): it has no running request to halt. A queued task starts on its own and cancel withdraws it; an idle worker has already finished its task.`
								: `worker ${agentId} was not interrupted (${outcome.reason ?? "unknown"})`
							: outcome.reason === "halt_already_requested"
								? `worker ${agentId} already has a halt in flight; its report arrives through the terminal handoff`
								: `worker ${agentId} halt requested: it finishes its current request, is told you stopped it${haltReason ? " and why" : ""}, and reports to you; its terminal handoff wakes you. A worker that reaches no request boundary in time is cancelled and that is reported instead. Continue it afterwards with follow_up on the same agentId. Do not poll or wait on it.`;
						return {
							content: [{ type: "text" as const, text: interruptText }],
							details: {
								started: outcome.interrupted,
								action,
								agentId,
								...(outcome.mode ? { mode: outcome.mode } : {}),
								skipReason: outcome.reason,
							},
						};
					}
					if (action === "resume") {
						if (!deps.workerAgentControl)
							return invalid("delegate resume is unavailable", {
								started: false,
								action,
								agentId,
								skipReason: "worker_agent_control_unavailable",
							});
						const outcome = workerScope
							? deps.workerAgentControl.resumeWorkerAgent(agentId, workerScope)
							: deps.workerAgentControl.resumeWorkerAgent(agentId);
						return {
							content: [
								{
									type: "text" as const,
									text: outcome.started
										? `worker ${agentId} resumed with its admitted transcript and authority${outcome.waitReason ? `; it has not started yet, waiting on ${outcome.waitReason}` : ""}`
										: `worker ${agentId} was not resumed (${outcome.skipReason ?? "unknown"})`,
								},
							],
							details: {
								started: outcome.started,
								action,
								agentId,
								laneId: outcome.record?.laneId,
								status: outcome.record?.status,
								skipReason: outcome.skipReason,
								...(outcome.waitReason ? { waitReason: outcome.waitReason } : {}),
							},
						};
					}
					if (action === "retire") {
						if (!deps.workerAgentControl) {
							return invalid("delegate retire is unavailable", {
								started: false,
								action,
								agentId,
								skipReason: "worker_agent_control_unavailable",
							});
						}
						const retireOptions = input.force === true ? { discardPending: true } : undefined;
						const outcome = retireOptions
							? deps.workerAgentControl.retireWorkerAgent(agentId, workerScope, retireOptions)
							: workerScope
								? deps.workerAgentControl.retireWorkerAgent(agentId, workerScope)
								: deps.workerAgentControl.retireWorkerAgent(agentId);
						return {
							content: [
								{
									type: "text" as const,
									text: `worker ${agentId} ${outcome.replayed ? "was already retired" : "retired"}; binding and transcript retained`,
								},
							],
							details: {
								started: true,
								action,
								agentId,
								accepted: true,
								replayed: outcome.replayed,
							},
						};
					}
					if (!deps.workerAgentControl)
						return invalid("delegate cancel is unavailable", {
							started: false,
							action,
							agentId,
							skipReason: "worker_agent_control_unavailable",
						});
					const cancelled = workerScope
						? deps.workerAgentControl.cancelWorkerAgent(agentId, undefined, workerScope)
						: deps.workerAgentControl.cancelWorkerAgent(agentId);
					return {
						content: [
							{
								type: "text" as const,
								text: cancelled
									? `worker ${agentId} cancelled for its current task`
									: `worker ${agentId} was not cancelled`,
							},
						],
						details: {
							started: Boolean(cancelled),
							action,
							agentId,
							laneId: cancelled?.laneId,
							status: cancelled?.status,
							reasonCode: cancelled?.reasonCode,
						},
					};
				}
				// Persistent reuse: start with agentId dispatches this task onto the existing worker's
				// durable conversation instead of silently minting a context-free fresh agent.
				const reuseAgentId = input.agentId?.trim();
				if (reuseAgentId && (input.slices !== undefined || input.race !== undefined)) {
					// A named recipient is one worker's persistent context; a fan-out starts fresh ones. The
					// recipient is never silently dropped to make the call work.
					return invalid(
						"delegate slices/race start fresh workers and cannot name an agentId; drop agentId, or start the named worker without slices/race",
						{ started: false, action, agentId: reuseAgentId, skipReason: "fanout_agent_id_conflict" },
					);
				}
				if (reuseAgentId) {
					if (!deps.workerAgentControl)
						return invalid("delegate start with agentId is unavailable", {
							started: false,
							action,
							agentId: reuseAgentId,
							skipReason: "worker_agent_control_unavailable",
						});
					const reuseInstructions = input.instructions?.trim() ? input.instructions : undefined;
					if (!reuseInstructions)
						return invalid("delegate start requires goal or instructions", {
							started: false,
							action,
							agentId: reuseAgentId,
							skipReason: "missing_instructions",
						});
					const reuseOverrideFields = (
						[
							["model", input.model],
							["thinkingLevel", input.thinkingLevel],
							["path", input.path],
							["writePaths", input.writePaths],
							["toolNames", input.toolNames],
							["readOnly", input.readOnly],
							["profileId", input.profileId],
							["forkTurns", input.forkTurns],
							["knowledge", input.knowledge],
							["subscriptions", input.subscriptions],
						] as const
					)
						.filter((entry) => entry[1] !== undefined)
						.map(([field]) => field);
					// Explicit options on a named worker are not refused unheard: the host compiles them and
					// admits the start only if they describe that worker's own effective specialization.
					// Anything else is different work and is reported as incompatible, not duplicated.
					const validatedReuse = reuseOverrideFields.length > 0;
					const replayScope = deps.resolveMessageReplayScope?.();
					if (!replayScope) {
						return invalid("delegate start with agentId requires a durable message replay scope", {
							started: false,
							action,
							agentId: reuseAgentId,
							skipReason: "message_replay_scope_unavailable",
						});
					}
					const reuseRequirementIds = [
						...(input.requirementId?.trim() ? [input.requirementId.trim()] : []),
						...(input.requirementIds ? input.requirementIds.map((id) => id.trim()).filter(Boolean) : []),
					];
					const currentGoal = deps.getGoalStateSnapshot?.();
					if (validatedReuse) {
						const validatedRequest = buildDelegateStartRequest({
							instructions: reuseInstructions,
							...(brief ? { brief } : {}),
							toolInput: input,
							requirementIds: reuseRequirementIds,
							reuseAgentId,
							messageReplayKey: messageIdempotencyKey(caller, replayScope, toolCallId, "start", "session"),
							...(dependsOnTaskIds ? { dependsOnTaskIds } : {}),
						});
						const validated = deps.startWorkerDelegation
							? await deps.startWorkerDelegation(validatedRequest, signal)
							: await deps.runWorkerDelegation(validatedRequest);
						if (!validated.started) {
							const refusedDetails: DelegateToolDetails = {
								started: false,
								action,
								agentId: reuseAgentId,
								skipReason: validated.skipReason ?? "worker_reuse_overrides_incompatible",
							};
							// Options that match the worker, refused by its own state (still running, or held by a failed
							// release), are not different work: the refusal says what it waits for.
							if (validated.skipReason && isSpecialistStateRefusal(validated.skipReason)) {
								return refusalResult(
									delegateStartRejection(validated.skipReason),
									refusedDetails,
									"operation_outcome",
								);
							}
							return invalid(
								`delegate start could not apply those options to worker ${reuseAgentId}: ${validated.skipReason ?? "not_started"}. They describe different work; start without agentId to run it as its own worker.${
									reuseOverrideFields.includes("writePaths")
										? " A reused worker keeps the write scope it was created with and cannot be widened: start a new worker with `writePaths`."
										: ""
								}`,
								refusedDetails,
								{ c: "E_STATE", f: "agentId", h: "RETRY_OMIT" },
							);
						}
						const validatedRecord = "record" in validated ? validated.record : undefined;
						const validatedWaiting = queuedWaitLine(validatedRecord);
						return {
							content: [
								{
									type: "text" as const,
									text: withStateLine(
										`worker ${reuseAgentId} accepted this task with its own admitted binding (lane ${validatedRecord?.laneId ?? "queued"}${validatedWaiting ? `; ${validatedWaiting}` : ""})`,
										validatedRecord?.status === "queued" ? ["QUEUED"] : [],
									),
								},
							],
							details: {
								started: true,
								action,
								...(validatedRecord?.status === "queued" ? { h: ["QUEUED" as const] } : {}),
								agentId: validatedRecord?.agentId ?? reuseAgentId,
								laneId: validatedRecord?.laneId,
								status: validatedRecord?.status,
								modelRef: validatedRecord?.modelRef,
								thinkingLevel: validatedRecord?.thinkingLevel,
								accepted: true,
							},
						};
					}
					const followed = deps.workerAgentControl.startWorkerAgentTask(reuseAgentId, reuseInstructions, {
						...(workerScope ?? {}),
						...(dependsOnTaskIds ? { dependsOnTaskIds } : {}),
						idempotencyKey: messageIdempotencyKey(caller, replayScope, toolCallId, "start", "session"),
						// An explicit start is new work on this specialist, correlated to the goal that is
						// current right now; `follow_up` remains the intentional continuation.
						newTask: {
							...(currentGoal ? { goal: currentGoal } : {}),
							...(reuseRequirementIds.length > 0 ? { requirementIds: reuseRequirementIds } : {}),
						},
					});
					if (!followed.started && !followed.messageId) {
						const skipReason = followed.skipReason ?? "not_started";
						const followedReleaseHold = parseSpecialistReleaseHold(skipReason);
						if (followedReleaseHold) {
							return refusalResult(
								delegateStartRejection(skipReason),
								{ started: false, action, agentId: reuseAgentId, skipReason },
								"operation_outcome",
							);
						}
						return invalid(
							skipReason === "unknown_agent"
								? `unknown_agent: no reusable worker named ${reuseAgentId} in this caller's control scope; nothing started or dropped. For fresh work omit agentId and keep instructions unchanged (put any overrides or profileId on that fresh start); for reuse use an exact returned agentId.`
								: `delegate start could not reuse worker ${reuseAgentId}: ${skipReason}`,
							{
								started: false,
								action,
								agentId: reuseAgentId,
								skipReason: followed.skipReason ?? "reuse_failed",
							},
							skipReason === "unknown_agent"
								? { c: "E_REF", f: "agentId", h: "USE_ID", x: reuseAgentId }
								: undefined,
						);
					}
					const queued =
						followed.record === undefined ||
						followed.record.status === "queued" ||
						followed.record.status === "running";
					const acceptanceState = followed.skipReason ?? (followed.started ? "started" : "wake pending");
					const effectiveBinding = followed.record?.modelRef
						? `; effective model ${followed.record.modelRef}, thinking ${followed.record.thinkingLevel ?? "unknown"}`
						: "";
					const followedWaiting = queuedWaitLine(followed.record);
					return {
						content: [
							{
								type: "text" as const,
								text: withStateLine(
									`worker ${reuseAgentId} durably accepted task message ${followed.messageId} on its persistent context (lane ${followed.record?.laneId ?? "queued"}; ${acceptanceState}${effectiveBinding}${followedWaiting ? `; ${followedWaiting}` : ""})`,
									followed.record?.status === "queued" || followed.record === undefined ? ["QUEUED"] : [],
								),
							},
						],
						details: {
							started: true,
							action,
							...(followed.record?.status === "queued" || followed.record === undefined
								? { h: ["QUEUED" as const] }
								: {}),
							agentId: reuseAgentId,
							laneId: followed.record?.laneId,
							status: followed.record?.status,
							modelRef: followed.record?.modelRef,
							thinkingLevel: followed.record?.thinkingLevel,
							accepted: true,
							messageId: followed.messageId,
							queued,
							skipReason: followed.skipReason,
						},
					};
				}
				// Validated on the trimmed view, forwarded verbatim: the brief is the worker's task text.
				const instructions = input.instructions?.trim() ? input.instructions : undefined;
				if (!instructions)
					return invalid("delegate start requires goal or instructions", {
						started: false,
						action,
						skipReason: "missing_instructions",
					});
				if (input.readOnly && input.toolNames) {
					// readOnly narrows the capability set before tools are matched against it, so an
					// explicit shell/write/network tool can never be granted. Say so here, before a lane
					// exists, instead of failing the dispatch with a capability code the model has to decode.
					const { excluded } = partitionToolsForReadOnly(input.toolNames);
					if (excluded.length > 0) {
						return invalid(
							`delegate start readOnly excludes ${excluded.join(", ")}: readOnly keeps reads (read, grep, find, ls, repo_read for git history and diffs, skill, memory query) and bash limited to commands that edit nothing, write only into its scratch directory and use no network. Drop readOnly to grant them, or drop them from toolNames.`,
							{ started: false, action, skipReason: "read_only_tool_conflict" },
						);
					}
				}
				const profileId = input.profileId?.trim();
				const requirementIds = [
					...(input.requirementId?.trim() ? [input.requirementId.trim()] : []),
					...(input.requirementIds ? input.requirementIds.map((id) => id.trim()).filter(Boolean) : []),
				];
				if (input.slices !== undefined || input.race !== undefined) {
					return await executeDelegateFanoutStart({
						deps,
						caller,
						toolCallId,
						input,
						instructions,
						requirementIds,
						dependsOnTaskIds,
						signal,
					});
				}
				const anonymousReplayScope = deps.resolveMessageReplayScope?.();
				const request = buildDelegateStartRequest({
					instructions,
					...(brief ? { brief } : {}),
					toolInput: input,
					requirementIds,
					// Host-owned replay identity for this exact tool call: a replay of the same call must
					// return the same task, whether it is still running or already settled.
					...(anonymousReplayScope
						? {
								messageReplayKey: messageIdempotencyKey(
									caller,
									anonymousReplayScope,
									toolCallId,
									"start",
									"session",
								),
							}
						: {}),
					...(dependsOnTaskIds ? { dependsOnTaskIds } : {}),
				});
				if (deps.startWorkerDelegation) {
					signal?.throwIfAborted();
					// Who existed before this start: a start that landed on one of them was a reuse, which needs no hint.
					const rosterBefore = new Set(
						(workerScope
							? deps.workerAgentControl?.listWorkerAgents(workerScope)
							: deps.workerAgentControl?.listWorkerAgents()
						)?.map((agent) => agent.agentId),
					);
					const started = await deps.startWorkerDelegation(request, signal);
					if (!started.started) {
						return refusalResult(
							delegateStartRejection(started.skipReason),
							{ started: false, skipReason: started.skipReason, ...(profileId ? { profileId } : {}) },
							isSpecialistStateRefusal(started.skipReason) ? "operation_outcome" : undefined,
						);
					}
					const startedAgentId = started.record.agentId ?? started.record.laneId;
					const passedOver = (
						deps.workerAgentControl && !rosterBefore.has(startedAgentId)
							? workerScope
								? deps.workerAgentControl.listWorkerAgents(workerScope)
								: deps.workerAgentControl.listWorkerAgents()
							: []
					).filter(
						(agent) =>
							agent.agentId !== startedAgentId &&
							agent.status === "registered" &&
							agent.activity === "idle" &&
							agent.controllable,
					);
					const idleHint = describeIdleSpecialists(passedOver);
					return {
						content: [
							{
								type: "text" as const,
								text: withStateLine(
									`${describeStartedWorker(started.record, deps.describeWorkerGrant?.(started.record.laneId), started.similarLaneIds, started.modelMoves)}; the owning parent will receive its terminal handoff, then read the report with delegate status (transcript pages on demand)${idleHint ? `\n${idleHint}` : ""}`,
									started.record.status === "queued" ? ["QUEUED"] : [],
								),
							},
						],
						details: {
							started: true,
							...(started.record.status === "queued" ? { h: ["QUEUED" as const] } : {}),
							...((started.record.profileId ?? profileId)
								? { profileId: started.record.profileId ?? profileId }
								: {}),
							// The durable specialist identity, which is the lane only for its first task.
							agentId: startedAgentId,
							laneId: started.record.laneId,
							...(started.record.label ? { label: started.record.label } : {}),
							status: started.record.status,
							modelRef: started.record.modelRef,
							thinkingLevel: started.record.thinkingLevel,
							...(passedOver.length > 0 ? { idleSpecialistIds: passedOver.map((agent) => agent.agentId) } : {}),
							...(modelPinBypassFrom(started) ? { modelPinBypass: modelPinBypassFrom(started) } : {}),
						},
					};
				}
				const run = await deps.runWorkerDelegation(request);
				if (!run.started) {
					const reason = run.skipReason ?? "unknown";
					return refusalResult(
						delegateStartRejection(reason),
						{ started: false, skipReason: reason, ...(profileId ? { profileId } : {}) },
						isSpecialistStateRefusal(reason) ? "operation_outcome" : undefined,
					);
				}

				const outcome = run.outcome;
				const lines: string[] = [
					`delegate ${run.record?.status ?? "unknown"}${run.record?.reasonCode ? ` (${run.record.reasonCode})` : ""}`,
				];
				if (run.record?.modelRef) {
					lines.push(
						`effective model: ${run.record.modelRef}; thinking: ${run.record.thinkingLevel ?? "unknown"}`,
					);
				}
				if (outcome) {
					lines.push(
						`accepted: ${outcome.accepted} [${outcome.acceptance.outcome}/${outcome.acceptance.reasonCode}]`,
						"Worker output (UNTRUSTED - verify before acting on it):",
						outcome.claim.summary.slice(0, 8_000),
					);
					if (outcome.claim.blockers && outcome.claim.blockers.length > 0) {
						lines.push(
							`Blockers: ${outcome.claim.blockers
								.slice(0, 16)
								.map((blocker) => blocker.slice(0, 512))
								.join("; ")}`,
						);
					}
					lines.push(...workerClaimSettlementLines(outcome.claim, (entry) => entry.slice(0, 512)));
					for (const finding of outcome.claim.evidence?.findings.slice(0, 16) ?? []) {
						lines.push(`- Finding: ${finding.summary.slice(0, 512)}`);
					}
				}
				return {
					content: [{ type: "text" as const, text: lines.join("\n").slice(0, MAX_DELEGATE_RESULT_CHARS) }],
					details: {
						started: true,
						profileId: run.record?.profileId ?? profileId,
						agentId: run.record?.agentId ?? run.record?.laneId,
						laneId: run.record?.laneId,
						label: run.record?.label,
						status: run.record?.status,
						modelRef: run.record?.modelRef,
						thinkingLevel: run.record?.thinkingLevel,
						reasonCode: run.record?.reasonCode,
						accepted: outcome?.accepted,
						costUsd: outcome?.costUsd,
						summary: outcome?.claim.summary.slice(0, 8_000),
						blockers: outcome?.claim.blockers?.slice(0, 16),
						...(outcome?.claim.inconclusive ? { inconclusive: outcome.claim.inconclusive.slice(0, 16) } : {}),
						...(modelPinBypassFrom(run) ? { modelPinBypass: modelPinBypassFrom(run) } : {}),
					},
				};
			} catch (error) {
				const reason = (error instanceof Error ? error.message : String(error)).slice(0, MAX_DELEGATE_ERROR_CHARS);
				// A replayed identity whose fields differ from what it first carried is a duplicate that disagrees: fail closed.
				const conflict = error instanceof WorkerControlIdentityConflictError;
				return invalid(
					`delegate ${action} failed: ${reason}`.slice(0, 2_048),
					{
						started: false,
						action,
						...(input.agentId?.trim() ? { agentId: input.agentId.trim() } : {}),
						skipReason: conflict ? "worker_control_identity_conflict" : "worker_agent_control_error",
					},
					conflict ? { c: "E_DUP" } : undefined,
				);
			}
		}),
	};
}
