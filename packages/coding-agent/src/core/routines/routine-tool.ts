import { StringEnum } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readAgentToolPolicyDeniedError } from "../../kernel/index.ts";
import { MAX_PROGRESS_LINE_CHARS } from "../delegation/worker-report-progress.ts";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import {
	type KnowledgeGrantReference,
	MAX_KNOWLEDGE_GRANT_REFERENCES,
	parseKnowledgeGrantReferences,
} from "../memory/knowledge-grant.ts";
import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH } from "../orchestration/contracts.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import {
	parseRoutineAuthoringInput,
	type RoutineAuthoringInput,
	type RoutineScheduleInput,
	routineAuthoringSchema,
} from "./routine-contract.ts";
import { ROUTINE_TOOL_NAME } from "./routine-tool-names.ts";
import { isWatchSchedule } from "./routine-watch-arming.ts";

const ROUTINE_LIST_PAGE_SIZE = 20;

export interface RoutineToolInput extends RoutineAuthoringInput {
	readonly profileId?: string;
	readonly knowledge?: readonly KnowledgeGrantReference[];
}

export interface RoutineToolSummary {
	readonly routineId: string;
	readonly revision: number;
	readonly enabled: boolean;
	readonly schedule: RoutineScheduleInput;
	/** A watch routine's condition in the owner's words ('watching notes.txt for changes'); absent for other schedules. */
	readonly scheduleText?: string;
	readonly nextRunAt?: number;
	/** A `readyBy` schedule's earliest start of `nextRunAt`'s run, while no earlier run of the routine is unfinished. */
	readonly startsFrom?: number;
	/** The slot the last claimed run belongs to; ahead of the clock while a run that started early runs. */
	readonly lastRunAt?: number;
	readonly lastStatus?: string;
	/** Why this runtime cannot place the routine's slots; it has no `nextRunAt` while set. */
	readonly unschedulable?: string;
	/** The host paused it after this many failed runs in a row; it stays paused until the owner resumes it. */
	readonly pausedAfterFailures?: number;
	/** A run reported the end the owner stated as met: it runs no more and is removed once its results are delivered. */
	readonly endReportedMet?: true;
}

/** A retired routine as `get` and `list` show it: what it was and how it ended; it has no revision and cannot be changed. */
export interface RoutineToolRetired {
	readonly routineId: string;
	readonly retired: true;
	/** `spent` (its one run was delivered), `condition` (its stated end was met), `expired` (its end time passed) or `deleted`. */
	readonly reason: string;
	readonly retiredAt: number;
	readonly schedule: RoutineScheduleInput;
	readonly scheduleText?: string;
	readonly prompt: string;
	readonly lastStatus?: string;
	readonly lastRunAt?: number;
	/** The first words of the last result, inside an untrusted-content boundary. */
	readonly lastSummary?: string;
}

/** The compact line `list` gives a retired routine; `get` has the rest. */
export type RoutineToolRetiredSummary = Pick<
	RoutineToolRetired,
	"routineId" | "retired" | "reason" | "retiredAt" | "lastStatus"
>;

/** Complete authored values for read-before-edit, without compiled authority or parent identity. */
export interface RoutineToolView extends RoutineToolSummary {
	readonly prompt: string;
	/**
	 * Only on the save that armed this watch: the use of the owner's approval its check was admitted on could not be
	 * recorded and the save could not be undone, so the watch runs with that approval unrecorded. What to report.
	 */
	readonly approvalUnrecorded?: string;
	/** The last finished run's worker summary, inside an untrusted-content boundary. */
	readonly lastSummary?: string;
	/** Where the task stood after the last run, in plain words, inside an untrusted-content boundary. */
	readonly progress?: string;
	readonly profileId?: string;
	readonly knowledge: readonly KnowledgeGrantReference[];
}

/** The owning session supplies scope, admission, persistence and occurrence deduplication. */
export interface RoutineToolPort {
	list(
		after: string | undefined,
		limit: number,
		signal?: AbortSignal,
	): Promise<{
		routines: readonly RoutineToolSummary[];
		retired?: readonly RoutineToolRetiredSummary[];
		next?: string;
	}>;
	get(routineId: string, signal?: AbortSignal): Promise<RoutineToolView | RoutineToolRetired | undefined>;
	/** `invocationId` is this tool call's id: a watched command or page is admitted as a sub-call of it. */
	create(input: RoutineToolInput, invocationId: string, signal?: AbortSignal): Promise<RoutineToolView>;
	update(
		input: RoutineToolInput,
		expectedRevision: number,
		invocationId: string,
		signal?: AbortSignal,
	): Promise<RoutineToolView>;
	setEnabled(
		routineId: string,
		expectedRevision: number,
		enabled: boolean,
		signal?: AbortSignal,
	): Promise<RoutineToolView>;
	delete(routineId: string, expectedRevision: number, signal?: AbortSignal): Promise<void>;
	/** Queue a manual occurrence through the durable owner; invocationId is a host replay key. */
	run(
		routineId: string,
		expectedRevision: number,
		invocationId: string,
		signal?: AbortSignal,
	): Promise<{ occurrenceId: string }>;
	/** Sets the owner's note on where the task stands, which every later run reads; the owner's turn only. */
	note(routineId: string, text: string, signal?: AbortSignal): Promise<RoutineToolView>;
	/** Forgets where the task stood, so the next run starts fresh; the owner's turn only. */
	resetProgress(routineId: string, signal?: AbortSignal): Promise<RoutineToolView>;
}

const referenceSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	},
	{ additionalProperties: false },
);
const authoringFields = {
	...routineAuthoringSchema.properties,
	profileId: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH,
			description: "The worker profile this routine's runs use. A watch runs no worker and takes none.",
		}),
	),
	knowledge: Type.Optional(
		Type.Array(referenceSchema, {
			maxItems: MAX_KNOWLEDGE_GRANT_REFERENCES,
			description:
				"Exact current knowledge references for this routine's runs only. Omit for none; never copy fact text. A watch runs no worker and takes none.",
		}),
	),
};
const noteText = Type.String({ minLength: 1, maxLength: MAX_PROGRESS_LINE_CHARS });
const revisionFields = {
	routineId: routineAuthoringSchema.properties.routineId,
	expectedRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
};
const commandSchema = Type.Union([
	Type.Object(
		{ action: Type.Literal("list"), after: Type.Optional(routineAuthoringSchema.properties.routineId) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("get"), routineId: routineAuthoringSchema.properties.routineId },
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("create"), ...authoringFields }, { additionalProperties: false }),
	Type.Object(
		{ action: Type.Literal("update"), ...authoringFields, expectedRevision: revisionFields.expectedRevision },
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: StringEnum(["pause", "resume", "delete", "run"] as const), ...revisionFields },
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("note"), routineId: revisionFields.routineId, text: noteText },
		{ additionalProperties: false },
	),
	Type.Object(
		{ action: Type.Literal("reset_progress"), routineId: revisionFields.routineId },
		{ additionalProperties: false },
	),
]);

// Provider function declarations require an object root. The private command schema
// validates required and forbidden fields per action before any port call.
const parameters = Type.Object(
	{
		action: StringEnum([
			"list",
			"get",
			"create",
			"update",
			"pause",
			"resume",
			"delete",
			"run",
			"note",
			"reset_progress",
		] as const),
		routineId: Type.Optional(revisionFields.routineId),
		prompt: Type.Optional(authoringFields.prompt),
		schedule: Type.Optional(authoringFields.schedule),
		profileId: authoringFields.profileId,
		knowledge: authoringFields.knowledge,
		expectedRevision: Type.Optional(revisionFields.expectedRevision),
		after: Type.Optional(revisionFields.routineId),
		text: Type.Optional(noteText),
	},
	{ additionalProperties: false },
);

const ROUTINE_ACTION_FIELDS: Readonly<
	Record<string, { readonly required: readonly string[]; readonly optional: readonly string[] }>
> = {
	list: { required: [], optional: ["after"] },
	get: { required: ["routineId"], optional: [] },
	create: { required: ["routineId", "prompt", "schedule"], optional: ["profileId", "knowledge"] },
	update: {
		required: ["routineId", "prompt", "schedule", "expectedRevision"],
		optional: ["profileId", "knowledge"],
	},
	pause: { required: ["routineId", "expectedRevision"], optional: [] },
	resume: { required: ["routineId", "expectedRevision"], optional: [] },
	delete: { required: ["routineId", "expectedRevision"], optional: [] },
	run: { required: ["routineId", "expectedRevision"], optional: [] },
	note: { required: ["routineId", "text"], optional: [] },
	reset_progress: { required: ["routineId"], optional: [] },
};

/**
 * What is wrong with a routine call, by field name: the action's required fields that are absent and the supplied fields
 * it does not take. The private command schema decides validity; this only names what it found, so a model that left
 * out `routineId` is told so instead of being sent to guess.
 */
function describeRoutineActionProblem(params: unknown): string {
	const generic = "Routine action has missing, invalid or forbidden fields";
	if (typeof params !== "object" || params === null) return generic;
	const given = params as Record<string, unknown>;
	const fields = typeof given.action === "string" ? ROUTINE_ACTION_FIELDS[given.action] : undefined;
	if (!fields) return `${generic}: action must be one of ${Object.keys(ROUTINE_ACTION_FIELDS).join(", ")}`;
	const present = (key: string) => given[key] !== undefined;
	const missing = fields.required.filter((key) => !present(key));
	const allowed = new Set(["action", ...fields.required, ...fields.optional]);
	const forbidden = Object.keys(given).filter((key) => given[key] !== undefined && !allowed.has(key));
	const parts = [
		...(missing.length > 0 ? [`${given.action} needs ${missing.join(", ")}`] : []),
		...(forbidden.length > 0 ? [`${given.action} does not take ${forbidden.join(", ")}`] : []),
	];
	return parts.length > 0
		? `${generic}: ${parts.join("; ")}`
		: `${generic}: a supplied value is not valid for its field`;
}

/** The authored routine fields as a caller holds them before validation. */
export interface RoutineToolFields {
	readonly routineId: unknown;
	readonly prompt: unknown;
	readonly schedule: unknown;
	readonly profileId?: string;
	readonly knowledge?: unknown;
}

/**
 * The one validation of authored routine fields, shared by the model tool and host callers. A watch runs no worker, so a
 * worker profile or knowledge named for one is refused rather than dropped unsaid.
 */
export function parseRoutineToolInput(value: RoutineToolFields): RoutineToolInput {
	const authored = parseRoutineAuthoringInput({
		routineId: value.routineId,
		prompt: value.prompt,
		schedule: value.schedule,
	});
	const knowledge = parseKnowledgeGrantReferences(value.knowledge ?? []);
	if (isWatchSchedule(authored.schedule)) {
		const named = [
			...(value.profileId === undefined ? [] : ["profileId"]),
			...(knowledge.length > 0 ? ["knowledge"] : []),
		];
		if (named.length > 0)
			throw new Error(
				`A watch runs no worker, so it takes no ${named.join(" or ")}: save it without ${named.join(" or ")}.`,
			);
	}
	return { ...authored, ...(value.profileId === undefined ? {} : { profileId: value.profileId }), knowledge };
}

function result(value: object) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

export function createRoutineToolDefinition(getPort: () => RoutineToolPort | undefined): ToolDefinition {
	return defineTool({
		name: ROUTINE_TOOL_NAME,
		label: "Routine",
		description:
			"Manage saved prompts scheduled for this main session. Use create for an owner-requested interval, one-time or calendar routine. create, update, resume and run need a turn the owner spoke in, never one a routine result or host event started; the one exception is a watch you arm for your own work (below). A calendar schedule is a five-field cron rule evaluated in an IANA time zone (when omitted: the host zone on create, the saved zone on update); missed slots coalesce into one run. once.notAfter and calendar maxLatenessMs bound how late a run may start. For 'have it ready by 9', set readyBy: true on an interval, one-time or calendar schedule: its run may start before the slot, by readyLeadMs or a lead derived from the routine's measured runs, still belongs to its slot and never starts early while an earlier run of it is unfinished; get and list show that earliest start as startsFrom. An event schedule {kind:'event', source:'ci'} runs once per new matching CI attempt, with its facts appended as data; use it for 'tell me when CI fails', with stopAfterFirstRun when the owner wants to hear only the next time. {kind:'event', source:'github', kinds} runs once per batch of new matching pull request or issue occurrences of this checkout's repository (at most 25 carried per run, oldest first), each third party's text appended as fenced data; a kind that fires on every thread needs pullRequest, branch, ownPullRequests (pull requests the signed-in login opened) or authors (who wrote the occurrence). expiresAt ends an interval, calendar or event routine the owner wants only for a while: no new slot or attempt is taken after it, and once admitted work is delivered the routine is removed and the owner told once; a later expiresAt extends it. {kind:'event', source:'watch', condition} waits on a path, a process, a port, a command result or a page without polling the model: the host evaluates the condition in code at no model cost and wakes you with the event only when it becomes true, once per rise (a condition that already holds when it is armed is the starting state, not a firing), only while this session is open; condition is {type:'file', path (a file, a folder or a glob), on:'changed'|'created'|'deleted'}, {type:'process', processId, on:'exited'} (a harness-managed process), {type:'pid', pid, on:'exited', everyMs?}, {type:'port', host, port, on:'open'|'closed', everyMs?}, {type:'command', command, everyMs?, timeoutMs?, expect?:{exitCode?, outputContains?}} (admitted like the owner's own shell calls) or {type:'http', url, statusIs?, bodyContains?, everyMs?} (GET only); timed checks run every 30 s unless everyMs (at least 1 s) says otherwise. Use it, not a polling routine, for 'tell me when this file changes, this port opens, this command succeeds or this page says X'. No worker runs for a watch (it takes no profileId or knowledge, and a save that names either is refused): when it fires you are woken directly, as a turn of this session, with the event's facts, your saved prompt and the routine id, so write the prompt as your own plan for that moment (what you will check or do next). A one-shot watch that reaches its expiresAt wakes you the same way, with what it last saw. Arm it, keep working or talk to the owner, and continue what waits on it when it comes back; never poll or look for logs. When your own work waits on an external job (a CI run, a release or deploy workflow, a long process, a port, a file), arm a watch for it with stopAfterFirstRun: true and expiresAt (UTC epoch ms, at most 24 hours ahead): that works in any turn, including one a result, CI event or goal continuation started, for up to 8 such watches at a time, and its wake may arm the next. Do not block a turn polling the job (gh run watch, sleep loops). A routine that finished, ended or was deleted stays readable: get returns its record marked retired, and list names the latest after the live ones. For other 'tell me when X', save a routine whose prompt checks X and reports ownerUpdate none when nothing changed: such a run is recorded and carried with the owner's next turn without starting a parent turn; failures and other results start one. list returns bounded metadata; get returns the complete saved prompt and worker preferences. Read get before updating: update replaces all authored fields, so preserve unchanged prompt, schedule, profileId and knowledge. update, pause, resume, delete and run require the exact revision from get. run queues one durable manual occurrence of a clock or event routine; it does not change the schedule, and a watch has no run to start. Each run is told where the task stood after the last one; get shows it as progress. note sets the owner's own line every later run reads, and reset_progress forgets it all so the next run starts fresh; both need a turn the owner spoke in, take no revision and never change the routine. Selected knowledge must name exact current records; omission grants none. No external recipient is supported here.",
		promptGuidelines: [
			"When work waits on an external job (a CI run, a release or deploy workflow, a long process, a port, a file), arm a one-shot routine watch with an end time and keep working or end the turn; you are woken with the event. Never block a turn polling (gh run watch, sleep loops).",
		],
		parameters,
		executionMode: "sequential",
		async execute(invocationId, input, signal) {
			const params: unknown = input;
			try {
				signal?.throwIfAborted();
				if (!Value.Check(commandSchema, params)) throw new Error(describeRoutineActionProblem(params));
				const port = getPort();
				if (!port) throw new Error("Routine management is unavailable in this session.");
				switch (params.action) {
					case "list":
						return result(await port.list(params.after, ROUTINE_LIST_PAGE_SIZE, signal));
					case "get": {
						const routine = await port.get(params.routineId, signal);
						if (!routine) throw new Error("Routine is absent from this session.");
						return result({ routine });
					}
					case "create":
					case "update": {
						const input = parseRoutineToolInput(params);
						return result({
							routine:
								params.action === "create"
									? await port.create(input, invocationId, signal)
									: await port.update(input, params.expectedRevision, invocationId, signal),
						});
					}
					case "pause":
					case "resume":
						return result({
							routine: await port.setEnabled(
								params.routineId,
								params.expectedRevision,
								params.action === "resume",
								signal,
							),
						});
					case "delete":
						await port.delete(params.routineId, params.expectedRevision, signal);
						return result({ routineId: params.routineId, deleted: true });
					case "run":
						return result(await port.run(params.routineId, params.expectedRevision, invocationId, signal));
					case "note":
						return result({ routine: await port.note(params.routineId, params.text, signal) });
					case "reset_progress":
						return result({ routine: await port.resetProgress(params.routineId, signal) });
				}
			} catch (error) {
				// A policy refusal (a watch's refused check) is this call's own, read as a standalone call's would be.
				if (readAgentToolPolicyDeniedError(error)) throw error;
				const diagnostic = boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error));
				// The reasons are sentences of their own; one without an end gets its period here.
				const reason =
					diagnostic === undefined ? "unavailable." : /[.!?]$/u.test(diagnostic) ? diagnostic : `${diagnostic}.`;
				return {
					content: [
						{
							type: "text",
							text: `Routine operation failed: ${reason} Read current state before retrying.`,
						},
					],
					details: undefined,
					isError: true,
					errorKind: "operation_outcome",
				};
			}
		},
	}) as ToolDefinition;
}
