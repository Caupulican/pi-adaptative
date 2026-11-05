import { StringEnum } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
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
	readonly nextRunAt?: number;
	readonly lastRunAt?: number;
	readonly lastStatus?: string;
	/** Why this runtime cannot place the routine's slots; it has no `nextRunAt` while set. */
	readonly unschedulable?: string;
}

/** Complete authored values for read-before-edit, without compiled authority or parent identity. */
export interface RoutineToolView extends RoutineToolSummary {
	readonly prompt: string;
	/** The last finished run's worker summary, inside an untrusted-content boundary. */
	readonly lastSummary?: string;
	readonly profileId?: string;
	readonly knowledge: readonly KnowledgeGrantReference[];
}

/** The owning session supplies scope, admission, persistence and occurrence deduplication. */
export interface RoutineToolPort {
	list(
		after: string | undefined,
		limit: number,
		signal?: AbortSignal,
	): Promise<{ routines: readonly RoutineToolSummary[]; next?: string }>;
	get(routineId: string, signal?: AbortSignal): Promise<RoutineToolView | undefined>;
	create(input: RoutineToolInput, signal?: AbortSignal): Promise<RoutineToolView>;
	update(input: RoutineToolInput, expectedRevision: number, signal?: AbortSignal): Promise<RoutineToolView>;
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
	profileId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ORCHESTRATION_IDENTIFIER_LENGTH })),
	knowledge: Type.Optional(
		Type.Array(referenceSchema, {
			maxItems: MAX_KNOWLEDGE_GRANT_REFERENCES,
			description: "Exact current knowledge references for this routine only. Omit for none; never copy fact text.",
		}),
	),
};
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
]);

// Provider function declarations require an object root. The private command schema
// validates required and forbidden fields per action before any port call.
const parameters = Type.Object(
	{
		action: StringEnum(["list", "get", "create", "update", "pause", "resume", "delete", "run"] as const),
		routineId: Type.Optional(revisionFields.routineId),
		prompt: Type.Optional(authoringFields.prompt),
		schedule: Type.Optional(authoringFields.schedule),
		profileId: authoringFields.profileId,
		knowledge: authoringFields.knowledge,
		expectedRevision: Type.Optional(revisionFields.expectedRevision),
		after: Type.Optional(revisionFields.routineId),
	},
	{ additionalProperties: false },
);

/** The one validation of authored routine fields, shared by the model tool and host callers. */
export function parseRoutineToolInput(value: {
	readonly routineId: unknown;
	readonly prompt: unknown;
	readonly schedule: unknown;
	readonly profileId?: string;
	readonly knowledge?: unknown;
}): RoutineToolInput {
	return {
		...parseRoutineAuthoringInput({ routineId: value.routineId, prompt: value.prompt, schedule: value.schedule }),
		...(value.profileId === undefined ? {} : { profileId: value.profileId }),
		knowledge: parseKnowledgeGrantReferences(value.knowledge ?? []),
	};
}

function result(value: object) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

export function createRoutineToolDefinition(getPort: () => RoutineToolPort | undefined): ToolDefinition {
	return defineTool({
		name: ROUTINE_TOOL_NAME,
		label: "Routine",
		description:
			"Manage saved prompts scheduled for this main session. Use create for an owner-requested interval, one-time or calendar routine. create, update and resume need a turn the owner spoke in, never one a routine result or CI event started. A calendar schedule is a five-field cron rule evaluated in an IANA time zone (when omitted: the host zone on create, the saved zone on update); missed slots coalesce into one run. once.notAfter and calendar maxLatenessMs bound how late a run may start. An event schedule {kind:'event', source:'ci'} runs once per new matching CI attempt, with its facts appended as data; use it for 'tell me when CI fails', with stopAfterFirstRun when the owner wants to hear only the next time. expiresAt ends an interval, calendar or event routine the owner wants only for a while: no new slot or attempt is taken after it, and once admitted work is delivered the routine is removed and the owner told once; a later expiresAt extends it. For other 'tell me when X', save a routine whose prompt checks X and reports ownerUpdate none when nothing changed: such a run is recorded and carried with the owner's next turn without starting a parent turn; failures and other results start one. list returns bounded metadata; get returns the complete saved prompt and worker preferences. Read get before updating: update replaces all authored fields, so preserve unchanged prompt, schedule, profileId and knowledge. update, pause, resume, delete and run require the exact revision from get. run queues one durable manual occurrence; it does not change the schedule. Selected knowledge must name exact current records; omission grants none. No external recipient is supported here.",
		parameters,
		executionMode: "sequential",
		async execute(invocationId, input, signal) {
			const params: unknown = input;
			try {
				signal?.throwIfAborted();
				if (!Value.Check(commandSchema, params))
					throw new Error("Routine action has missing, invalid or forbidden fields.");
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
									? await port.create(input, signal)
									: await port.update(input, params.expectedRevision, signal),
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
				}
			} catch (error) {
				const diagnostic = boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error));
				return {
					content: [
						{
							type: "text",
							text: `Routine operation failed: ${diagnostic ?? "unavailable"}. Read current state before retrying.`,
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
