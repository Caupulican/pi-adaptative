/**
 * The origin of every message that can open or steer a turn, and the authority of the run that carries it. One owner:
 * every gate that scopes authority by origin reads it here.
 *
 * Origins are recorded at ingestion, never classified afterwards by a model or by text. A message names its origin by
 * the identity it already carries: the owner-input id an accepted submission is minted under, the custom type of a host
 * or extension message, or, for a third party's words an extension delivers (`SendUserMessageOrigin`), the stamp written
 * where the message is created and persisted on its entry (`kernel/turn-origin-stamp.ts`).
 */

import { isDeepStrictEqual } from "node:util";
import { ownerInputIdOf } from "../kernel/owner-input-stamp.ts";
import {
	PARENT_INPUT_CONSUMED_CUSTOM_TYPE,
	PARENT_INPUT_SETTLED_CUSTOM_TYPE,
	PARENT_INPUT_SKIPPED_CUSTOM_TYPE,
	PARENT_INPUT_WAKE_CUSTOM_TYPE,
	PARENT_INPUT_WAKE_REQUEST_CUSTOM_TYPE,
	PARENT_NOTE_REQUEST_CUSTOM_TYPE,
} from "../kernel/session/parent-input-ledger.ts";
import type { SessionEntry } from "../kernel/session/session-entries.ts";
import { WORKER_PROJECT_ENROLLMENT_CUSTOM_TYPE } from "../kernel/session/worker-project-enrollment.ts";
import type { TurnOriginRecord } from "../kernel/turn-origin-stamp.ts";
import {
	MAX_TURN_ORIGIN_REF_CHARS,
	MAX_TURN_ORIGIN_SHOWN_CHARS,
	parseTurnOriginRecord,
	turnOriginStampOf,
	UNREADABLE_TURN_ORIGIN,
} from "../kernel/turn-origin-stamp.ts";
import type { AgentMessage } from "../kernel/types.ts";
import { VERIFICATION_DISMISSAL_CUSTOM_TYPE } from "../kernel/verification-obligations.ts";
import { parseWorkerControlRecord, type WorkerControlRecord, workerControlOf } from "../kernel/worker-control-stamp.ts";
import { OUTWARD_DRAFT_CUSTOM_TYPE, OUTWARD_DRAFT_STATE_CUSTOM_TYPE } from "./agent-session-edge.ts";
import { TASK_AUTOMATION_CONTEXT_CUSTOM_TYPE } from "./automation/task-automation-runtime-adapter.ts";
import { EDGE_GRANT_CUSTOM_TYPE, EDGE_REVOKE_CUSTOM_TYPE } from "./autonomy/edge-policy.ts";
import { LANE_RECORD_CUSTOM_TYPE } from "./autonomy/session-lane-record.ts";
import {
	BACKGROUND_TOOL_TASK_CUSTOM_TYPE,
	BACKGROUND_TOOL_TASK_DELIVERY_CUSTOM_TYPE,
} from "./background-tool-task-controller.ts";
import type { OwnerChannelOrigin } from "./channels/owner-channel-types.ts";
import { CHAT_EXTENSION_NAME } from "./chat/constants.ts";
import { RETENTION_AUDIT_CUSTOM_TYPE } from "./compaction/evidence-retention-projection.ts";
import {
	SELF_COMPACTION_ABANDONED_CUSTOM_TYPE,
	SELF_COMPACTION_GUIDANCE_CUSTOM_TYPE,
	SELF_COMPACTION_HANDOFF_CUSTOM_TYPE,
	SELF_COMPACTION_OWNER_REQUEST_CUSTOM_TYPE,
	SELF_COMPACTION_RELEASED_CUSTOM_TYPE,
	SELF_COMPACTION_REQUEST_CUSTOM_TYPE,
} from "./compaction/self-compaction.ts";
import { COMPACTION_PREPARED_CUSTOM_TYPE } from "./compaction-controller.ts";
import { CONTEXT_VISIBILITY_PROJECTION_CUSTOM_TYPE } from "./context/context-prompt-enforcement.ts";
import { PATH_ALIAS_LEGEND_CUSTOM_TYPE } from "./context/path-alias-table.ts";
import { SEMANTIC_USAGE_CUSTOM_TYPE, SPAWNED_USAGE_CUSTOM_TYPE } from "./cost/usage-records.ts";
import { BOT_RUNTIME_BINDINGS_CUSTOM_TYPE } from "./delegation/bot-runtime-bindings.ts";
import { LEADER_OUTCOME_CUSTOM_TYPE, LEADER_QUESTION_CUSTOM_TYPE } from "./delegation/leader-controller.ts";
import { WORKER_CLAIM_CUSTOM_TYPE } from "./delegation/session-worker-claim.ts";
import {
	WORKER_ATTEMPT_USAGE_BOUNDARY_CUSTOM_TYPE,
	WORKER_CHANGED_FILE_CUSTOM_TYPE,
} from "./delegation/worker-conversation-store.ts";
import { WORKER_RECEIPT_ORIGIN_CUSTOM_TYPE } from "./delegation/worker-receipt-origin.ts";
import { HOST_EVENT_CUSTOM_TYPE } from "./events/host-event-delivery.ts";
import type { SendUserMessageOrigin } from "./extensions/types.ts";
import { ACTIVE_GOAL_CONTEXT_CUSTOM_TYPE } from "./goals/compact-goal-context.ts";
import { GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE } from "./goals/goal-continuation-prompt.ts";
import { GOAL_STATE_CUSTOM_TYPE } from "./goals/session-goal-state.ts";
import { HARNESS_NOTICE_CUSTOM_TYPE } from "./harness-notice.ts";
import { HOST_TURN_CUSTOM_TYPES } from "./host-turn-reasoning.ts";
import { HUMAN_INPUT_CUSTOM_TYPE, HUMAN_INPUT_WORKER_RESPONSE_CUSTOM_TYPE } from "./human-input.ts";
import { LEARNING_AUDIT_CUSTOM_TYPE } from "./learning/learning-audit.ts";
import { OWNER_EVIDENCE_CUSTOM_TYPE } from "./learning/owner-evidence-ledger.ts";
import { CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE } from "./memory/continuous-chat-ingest.ts";
import {
	CONTINUOUS_CHAT_STATE_CUSTOM_TYPE,
	CONTINUOUS_CHAT_VIEW_CUSTOM_TYPE,
} from "./memory/continuous-chat-projection.ts";
import { KNOWLEDGE_CONTEXT_CUSTOM_TYPE } from "./memory/knowledge-projection.ts";
import { TRANSCRIPT_FRONTIER_CUSTOM_TYPE } from "./memory/transcript-memory-contracts.ts";
import { MEMORY_EVIDENCE_CUSTOM_TYPE } from "./memory-controller.ts";
import { MODEL_POOL_POLICY_CUSTOM_TYPE } from "./model-router/owner-model-policy.ts";
import { SIDE_TRIP_CONTEXT_CUSTOM_TYPE } from "./model-router/side-trip-brief.ts";
import { SESSION_TASK_PROFILE_CUSTOM_TYPE } from "./orchestration/session-task-profile-store.ts";
import { OWNER_RETURN_BRIEF_CUSTOM_TYPE } from "./owner-decisions/return-brief.ts";
import { isHostInputId, isOwnerChannelInputId, isOwnerSpokenInputId } from "./owner-input-ledger.ts";
import { PIPELINE_RUN_CUSTOM_TYPE } from "./pipelines/types.ts";
import { ACT_AHEAD_CUSTOM_TYPE } from "./proactivity/act-ahead-record.ts";
import { PROACTIVITY_FEEDBACK_CUSTOM_TYPE } from "./proactivity/proactivity-feedback.ts";
import { PROACTIVE_NOTE_CUSTOM_TYPE } from "./proactivity/proactivity-review.ts";
import {
	BACKGROUND_WORKER_COMPLETION_CUSTOM_TYPE,
	PLAN_UPDATE_CUSTOM_TYPE,
	PROOF_SHEET_TOOL_NAMES,
} from "./proof/proof-sheet.ts";
import {
	ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE,
	ACTIVE_SKILL_EXCLUSIONS_CUSTOM_TYPE,
	ACTIVE_SKILL_RECORD_KIND_PREFIX,
	AUTHORITY_CONTEXT_CUSTOM_TYPE,
} from "./provider-request-context-controller.ts";
import { QUEUED_INPUT_CUSTOM_TYPE } from "./queued-input-record.ts";
import { CONVERSATION_TALKER_CUSTOM_TYPE, REPLY_ROUTE_CUSTOM_TYPE } from "./reply-route.ts";
import { ROUTINE_COMPLETION_TYPE, ROUTINE_INTAKE_NOTICE_TYPE } from "./routines/routine-parent-input.ts";
import { SESSION_SKILL_POLICY_CUSTOM_TYPE } from "./session-skill-policy.ts";
import { SESSION_SYSTEM_PROMPT_CUSTOM_TYPE } from "./session-system-prompt-override.ts";
import { WORK_EVIDENCE_CUSTOM_TYPE } from "./system-one/session-work-diff.ts";
import { VERIFICATION_OBLIGATIONS_CUSTOM_TYPE } from "./system-one/verification-obligations.ts";
import { TASK_DIRECTORY_STATE_CUSTOM_TYPE } from "./tasks/session-task-directory-store.ts";
import { TASK_STEPS_STATE_CUSTOM_TYPE } from "./tasks/session-task-state.ts";
import { TASK_DIRECTORY_CONTEXT_CUSTOM_TYPE } from "./tasks/task-directory-context.ts";
import { OPTIONAL_TOOL_INTENT_CUSTOM_TYPE } from "./tool-applicability-gate.ts";
import { isPlainRecord } from "./util/value-guards.ts";
import { WORK_UNIT_CUSTOM_TYPE, WORKER_RECEIPTS_CUSTOM_TYPE } from "./work-units.ts";

export type { TurnOriginKind, TurnOriginRecord } from "../kernel/turn-origin-stamp.ts";

/**
 * Who the run answers: the owner at their own terminal (their words or their own automation), the owner on a phone
 * (`remote-owner`: a verified message from an identity the owner lists for a channel), or a third party whose words it
 * carries. A remote owner holds the owner's tools and memory but not the owner's standing authority: what only the
 * terminal may do stays refused and outward actions wait for the owner's approval.
 */
export type TurnAuthority = "owner" | "remote-owner" | "third-party";

/**
 * The origin of a third party's words an extension delivers: a peer agent on the chat mesh, or another channel. A
 * channel that cannot name a record (one restored from a record written before the boundary checked it) is unreadable,
 * and an unreadable origin is third-party like any other.
 */
export function channelTurnOrigin(
	origin: Pick<SendUserMessageOrigin, "channel" | "verified" | "ref"> & Partial<Pick<SendUserMessageOrigin, "text">>,
): TurnOriginRecord {
	return (
		parseTurnOriginRecord({
			v: 1,
			k: origin.channel === CHAT_EXTENSION_NAME ? "peer-agent" : "inbound-channel",
			channel: origin.channel,
			...(origin.verified === true ? { verified: true as const } : {}),
			thirdParty: true,
			...(origin.ref !== undefined ? { ref: origin.ref } : {}),
			...(origin.text !== undefined && origin.text.trim().length > 0
				? { shown: origin.text.slice(0, MAX_TURN_ORIGIN_SHOWN_CHARS) }
				: {}),
		}) ?? UNREADABLE_TURN_ORIGIN
	);
}

/**
 * The origin of the owner's words delivered from a verified owner channel. Only the channels core mints it (through
 * `OwnerChannelDelivery`); an extension's message shape cannot express it. A record that does not parse is unreadable,
 * and an unreadable origin is third-party, so a mistake here never gains authority.
 */
export function ownerChannelTurnOrigin(origin: Pick<OwnerChannelOrigin, "channel" | "ref">): TurnOriginRecord {
	return (
		parseTurnOriginRecord({ v: 1, k: "owner-channel", channel: origin.channel, verified: true, ref: origin.ref }) ??
		UNREADABLE_TURN_ORIGIN
	);
}

/**
 * Why `origin` is not a `SendUserMessageOrigin` the session can carry, or undefined when it is one. Checked where an
 * extension hands a message in (`PromptSubmissionController.prompt`), so the message is refused there and never queued.
 */
export function sendUserMessageOriginError(origin: unknown): string | undefined {
	if (typeof origin !== "object" || origin === null || Array.isArray(origin)) return "origin must be an object";
	const record = origin as Record<string, unknown>;
	if (
		typeof record.channel !== "string" ||
		parseTurnOriginRecord({ v: 1, k: "inbound-channel", channel: record.channel }) === undefined
	)
		return "origin.channel must be a non-empty string of at most 128 characters";
	if (typeof record.sender !== "string") return "origin.sender must be a string";
	if (typeof record.verified !== "boolean") return "origin.verified must be a boolean";
	if (typeof record.text !== "string") return "origin.text must be a string";
	if (record.ref !== undefined && parseTurnOriginRecord({ v: 1, k: "inbound-channel", ref: record.ref }) === undefined)
		return `origin.ref must be a non-empty string of at most ${MAX_TURN_ORIGIN_REF_CHARS} characters`;
	return undefined;
}

/**
 * The origin a custom message names, read from its own details: a delivered parent input keeps them under the ledger's
 * wrapper (`{ parentInput, originalDetails }`, `parentInputMessage`), on the live message and its entry alike, so the
 * wrapper is opened first. Its type names it, and three delivered
 * kinds also say when a third party's words decided them: a host event whose delivery marks who wrote the content
 * (`details.hostEvent.authorship`, written by `hostEventParentInput` for a third-party-authored kind; any mark counts as
 * another's), a routine's result from a run a third party's words decided (`details.thirdParty: true`, written by
 * `routineParentInput` when `routineTurnOrigin` names one), and a background completion that reports work a third
 * party's words reached (`details.thirdParty: true`, written by the terminal handoff for a tainted worker attempt). A
 * type nobody registered here is the owner's installed code.
 */
function customTurnOrigin(customType: string, wrapped: unknown): TurnOriginRecord {
	const details = isPlainRecord(wrapped) && "parentInput" in wrapped ? wrapped.originalDetails : wrapped;
	switch (customType) {
		case HOST_EVENT_CUSTOM_TYPE: {
			const hostEvent = details && typeof details === "object" ? Reflect.get(details, "hostEvent") : undefined;
			const authorship =
				hostEvent && typeof hostEvent === "object" ? Reflect.get(hostEvent, "authorship") : undefined;
			return authorship === undefined ? { v: 1, k: "host-event" } : { v: 1, k: "host-event", thirdParty: true };
		}
		case HARNESS_NOTICE_CUSTOM_TYPE:
			return { v: 1, k: "harness" };
		case ROUTINE_COMPLETION_TYPE:
			return details && typeof details === "object" && Reflect.get(details, "thirdParty") === true
				? { v: 1, k: "host-event", thirdParty: true }
				: { v: 1, k: "routine" };
		case ROUTINE_INTAKE_NOTICE_TYPE:
			return { v: 1, k: "routine" };
		case PROACTIVE_NOTE_CUSTOM_TYPE:
			return { v: 1, k: "proactive-review" };
		case GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE:
			return { v: 1, k: "goal-continuation" };
		case HUMAN_INPUT_WORKER_RESPONSE_CUSTOM_TYPE:
			return { v: 1, k: "worker-result" };
		default:
			if (!(HOST_TURN_CUSTOM_TYPES as readonly string[]).includes(customType))
				return { v: 1, k: "extension-message" };
			return details && typeof details === "object" && Reflect.get(details, "thirdParty") === true
				? { v: 1, k: "worker-result", thirdParty: true }
				: { v: 1, k: "worker-result" };
	}
}

/**
 * The origin a user message's identities name, the one rule for a live message and a persisted entry alike: its origin
 * stamp, else its worker-control identity, else the owner input it delivers. A user message with none of them (a hidden
 * internal turn, or an entry written before inputs carried an identity) names nobody: `undefined`, never the owner's
 * typed words.
 */
function userTurnOrigin(
	stamped: TurnOriginRecord | undefined,
	control: WorkerControlRecord | undefined,
	inputId: string | undefined,
): TurnOriginRecord | undefined {
	if (stamped) return stamped;
	if (control) return { v: 1, k: control.k === "host_event" ? "host-event" : "harness" };
	if (inputId === undefined) return undefined;
	// Owner-channel words carry their verified origin's stamp; without it their authority is unreadable, never the owner's.
	if (isOwnerChannelInputId(inputId)) return UNREADABLE_TURN_ORIGIN;
	// A turn the host runs for itself (a queued internal steer) is the harness's, never the owner's words.
	if (isHostInputId(inputId)) return { v: 1, k: "harness" };
	return { v: 1, k: isOwnerSpokenInputId(inputId) ? "owner-typed" : "extension-message" };
}

/** The origin of a message that can open or steer a turn; `undefined` for an answer, a tool result or a summary. */
export function turnOriginOf(message: AgentMessage): TurnOriginRecord | undefined {
	if (message.role === "custom") return customTurnOrigin(message.customType, message.details);
	if (message.role !== "user") return undefined;
	return userTurnOrigin(turnOriginStampOf(message), workerControlOf(message), ownerInputIdOf(message));
}

/**
 * The origin of a persisted entry, read from the fields it was written with (the same rule as `turnOriginOf`, which
 * reads the stamps a rebuilt context restores from those fields). A record that does not parse is third-party.
 */
export function entryTurnOrigin(entry: SessionEntry): TurnOriginRecord | undefined {
	if (entry.type === "custom_message") return customTurnOrigin(entry.customType, entry.details);
	if (entry.type !== "message") return undefined;
	if (entry.message.role === "custom") return customTurnOrigin(entry.message.customType, entry.message.details);
	if (entry.message.role !== "user") return undefined;
	return userTurnOrigin(
		entry.turnOrigin === undefined ? undefined : (parseTurnOriginRecord(entry.turnOrigin) ?? UNREADABLE_TURN_ORIGIN),
		entry.workerControl === undefined ? undefined : parseWorkerControlRecord(entry.workerControl),
		entry.ownerInputId,
	);
}

let hostReservedTypes: ReadonlySet<string> | undefined;

/**
 * The custom types the host writes itself and a reader trusts for a decision: authority and owner decisions (edge grants and
 * revokes, owner evidence, model and skill policies, outward drafts, reply routes, bot bindings, verification dismissals and
 * obligations, worker enrollment), goal, worker, lane, task and leader state and receipts, parent inputs and wakes, spend, the
 * human-input exchange, the proof sheets with their carriers, the compaction records (prepared, self-compaction and its
 * handoffs, retention audit), the learning audit, the memory projections (knowledge context, continuous-chat view and state,
 * transcript frontier, memory evidence) and the context records a model request carries (active skill records, one type per skill, and their exclusions; active goal context; task
 * directory and automation context, side-trip brief, path alias legend, context visibility projection). Not reserved: display,
 * telemetry and analytics records, and the types a built-in extension writes (`pi-chat`, `collaboration-control-failure`).
 * Built from the constants their producers export, never retyped, and on first use, so the import order of those producers
 * cannot leave one unset.
 */
function hostReservedCustomTypes(): ReadonlySet<string> {
	hostReservedTypes ??= new Set<string>([
		...HOST_TURN_CUSTOM_TYPES,
		BACKGROUND_WORKER_COMPLETION_CUSTOM_TYPE,
		PLAN_UPDATE_CUSTOM_TYPE,
		HOST_EVENT_CUSTOM_TYPE,
		HARNESS_NOTICE_CUSTOM_TYPE,
		PROACTIVE_NOTE_CUSTOM_TYPE,
		PROACTIVITY_FEEDBACK_CUSTOM_TYPE,
		ACT_AHEAD_CUSTOM_TYPE,
		GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE,
		HUMAN_INPUT_CUSTOM_TYPE,
		HUMAN_INPUT_WORKER_RESPONSE_CUSTOM_TYPE,
		ROUTINE_COMPLETION_TYPE,
		ROUTINE_INTAKE_NOTICE_TYPE,
		OPTIONAL_TOOL_INTENT_CUSTOM_TYPE,
		QUEUED_INPUT_CUSTOM_TYPE,
		VERIFICATION_OBLIGATIONS_CUSTOM_TYPE,
		VERIFICATION_DISMISSAL_CUSTOM_TYPE,
		OWNER_EVIDENCE_CUSTOM_TYPE,
		EDGE_GRANT_CUSTOM_TYPE,
		EDGE_REVOKE_CUSTOM_TYPE,
		OUTWARD_DRAFT_CUSTOM_TYPE,
		OUTWARD_DRAFT_STATE_CUSTOM_TYPE,
		REPLY_ROUTE_CUSTOM_TYPE,
		CONVERSATION_TALKER_CUSTOM_TYPE,
		BOT_RUNTIME_BINDINGS_CUSTOM_TYPE,
		MODEL_POOL_POLICY_CUSTOM_TYPE,
		SESSION_SKILL_POLICY_CUSTOM_TYPE,
		SESSION_SYSTEM_PROMPT_CUSTOM_TYPE,
		AUTHORITY_CONTEXT_CUSTOM_TYPE,
		WORKER_PROJECT_ENROLLMENT_CUSTOM_TYPE,
		PARENT_INPUT_SETTLED_CUSTOM_TYPE,
		PARENT_INPUT_CONSUMED_CUSTOM_TYPE,
		PARENT_INPUT_WAKE_CUSTOM_TYPE,
		PARENT_INPUT_WAKE_REQUEST_CUSTOM_TYPE,
		PARENT_INPUT_SKIPPED_CUSTOM_TYPE,
		PARENT_NOTE_REQUEST_CUSTOM_TYPE,
		GOAL_STATE_CUSTOM_TYPE,
		WORKER_RECEIPTS_CUSTOM_TYPE,
		WORKER_RECEIPT_ORIGIN_CUSTOM_TYPE,
		WORKER_CHANGED_FILE_CUSTOM_TYPE,
		WORKER_CLAIM_CUSTOM_TYPE,
		WORKER_ATTEMPT_USAGE_BOUNDARY_CUSTOM_TYPE,
		WORK_UNIT_CUSTOM_TYPE,
		WORK_EVIDENCE_CUSTOM_TYPE,
		LANE_RECORD_CUSTOM_TYPE,
		LEADER_OUTCOME_CUSTOM_TYPE,
		LEADER_QUESTION_CUSTOM_TYPE,
		BACKGROUND_TOOL_TASK_CUSTOM_TYPE,
		BACKGROUND_TOOL_TASK_DELIVERY_CUSTOM_TYPE,
		CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE,
		TASK_STEPS_STATE_CUSTOM_TYPE,
		TASK_DIRECTORY_STATE_CUSTOM_TYPE,
		SESSION_TASK_PROFILE_CUSTOM_TYPE,
		PIPELINE_RUN_CUSTOM_TYPE,
		SPAWNED_USAGE_CUSTOM_TYPE,
		SEMANTIC_USAGE_CUSTOM_TYPE,
		COMPACTION_PREPARED_CUSTOM_TYPE,
		RETENTION_AUDIT_CUSTOM_TYPE,
		SELF_COMPACTION_GUIDANCE_CUSTOM_TYPE,
		SELF_COMPACTION_REQUEST_CUSTOM_TYPE,
		SELF_COMPACTION_HANDOFF_CUSTOM_TYPE,
		SELF_COMPACTION_ABANDONED_CUSTOM_TYPE,
		SELF_COMPACTION_OWNER_REQUEST_CUSTOM_TYPE,
		SELF_COMPACTION_RELEASED_CUSTOM_TYPE,
		LEARNING_AUDIT_CUSTOM_TYPE,
		KNOWLEDGE_CONTEXT_CUSTOM_TYPE,
		CONTINUOUS_CHAT_VIEW_CUSTOM_TYPE,
		CONTINUOUS_CHAT_STATE_CUSTOM_TYPE,
		TRANSCRIPT_FRONTIER_CUSTOM_TYPE,
		MEMORY_EVIDENCE_CUSTOM_TYPE,
		ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE,
		ACTIVE_SKILL_EXCLUSIONS_CUSTOM_TYPE,
		ACTIVE_GOAL_CONTEXT_CUSTOM_TYPE,
		TASK_DIRECTORY_CONTEXT_CUSTOM_TYPE,
		TASK_AUTOMATION_CONTEXT_CUSTOM_TYPE,
		SIDE_TRIP_CONTEXT_CUSTOM_TYPE,
		PATH_ALIAS_LEGEND_CUSTOM_TYPE,
		CONTEXT_VISIBILITY_PROJECTION_CUSTOM_TYPE,
		OWNER_RETURN_BRIEF_CUSTOM_TYPE,
	]);
	return hostReservedTypes;
}

/**
 * Refuses an extension's record under a host-reserved custom type with a plain error that names the type. Nothing is written
 * when it throws. The extension API's write paths call it (`sendMessage`, `appendEntry`, a handler's replacement message), and so
 * does the session manager an extension's `newSession` setup receives (`extensionSetupSessionManager`).
 */
export function assertExtensionCustomType(customType: string): void {
	if (isHostReservedCustomType(customType))
		throw new Error(`Custom type "${customType}" is reserved by the host; an extension cannot send or record it.`);
}

/**
 * Whether the host reserves a custom type: one of the listed types, or one of a family the host names by prefix (each loaded
 * skill's record is its own type, `active_skill_context:<name>`).
 */
export function isHostReservedCustomType(customType: string): boolean {
	return hostReservedCustomTypes().has(customType) || customType.startsWith(ACTIVE_SKILL_RECORD_KIND_PREFIX);
}

/**
 * The refusal of an extension's tool under a host proof tool's name (the goal tools), or undefined when the name is free. The
 * proof sheet a tool result carries is read by its tool name, so the name is the host's; the same refusal covers a registered
 * tool and a manifest's lazy tool, since each takes the registry slot of the name it carries.
 */
export function extensionToolNameError(name: string): string | undefined {
	return PROOF_SHEET_TOOL_NAMES.has(name)
		? `Tool name "${name}" is reserved by the host; an extension cannot register a tool under it.`
		: undefined;
}

/** Refuses an extension's tool under a host-reserved name with the plain error of {@link extensionToolNameError}. */
export function assertExtensionToolName(name: string): void {
	const error = extensionToolNameError(name);
	if (error !== undefined) throw new Error(error);
}

/**
 * Whether a handler's replacement returns a custom message unchanged: the same custom type, content, display and details. A host
 * message returned that way is still the host's; any other change to a reserved message is refused.
 */
export function isUnchangedCustomMessage(original: AgentMessage, replacement: AgentMessage): boolean {
	return (
		original.role === "custom" &&
		replacement.role === "custom" &&
		original.customType === replacement.customType &&
		original.display === replacement.display &&
		isDeepStrictEqual(original.content, replacement.content) &&
		isDeepStrictEqual(original.details, replacement.details)
	);
}

/**
 * Where the stamped part of a branch begins: the index of its first entry that carries an owner input id, an origin stamp or a
 * worker-control stamp, or the branch length when none does. An entry before it was written before inputs carried identities.
 */
export function stampedHistoryStart(branch: readonly SessionEntry[]): number {
	const index = branch.findIndex(
		(entry) =>
			entry.type === "message" &&
			(entry.ownerInputId !== undefined || entry.turnOrigin !== undefined || entry.workerControl !== undefined),
	);
	return index < 0 ? branch.length : index;
}

/**
 * The owner's own words at `index` of a branch whose stamped part starts at `stampedStart` (see {@link stampedHistoryStart}): a
 * user message whose origin is owner-typed or owner-channel. A user message that carries no identity at all counts as the owner's
 * typed words only in the legacy prefix, before the stamped part, where the owner typed it before inputs carried an identity; after
 * that point it is no one's words. Every other entry yields undefined. Shared by every reader of owner evidence on a branch.
 */
export function ownerOriginKind(
	entry: SessionEntry,
	index: number,
	stampedStart: number,
): "owner-typed" | "owner-channel" | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") return undefined;
	const origin = entryTurnOrigin(entry);
	if (origin === undefined) return index < stampedStart ? "owner-typed" : undefined;
	return origin.k === "owner-typed" || origin.k === "owner-channel" ? origin.k : undefined;
}

/** The extension's message once its custom type is checked (see {@link assertExtensionCustomType}). */
export function checkedExtensionMessage<T extends { readonly customType: string }>(message: T): T {
	assertExtensionCustomType(message.customType);
	return message;
}

export function isThirdPartyOrigin(origin: TurnOriginRecord | undefined): boolean {
	return origin?.thirdParty === true;
}

/** The owner's words from a verified owner channel (a phone), which are not a third party's and not typed at the terminal. */
export function isRemoteOwnerOrigin(origin: TurnOriginRecord | undefined): boolean {
	return origin?.k === "owner-channel";
}

/**
 * The owner's typed words, the owner's words from a verified owner channel, and a third party's words decide a run's
 * authority; the owner's automation does not.
 */
export function isDecisiveOrigin(origin: TurnOriginRecord): boolean {
	return origin.thirdParty === true || origin.k === "owner-typed" || origin.k === "owner-channel";
}

/** The latest entry of `branch` (root to leaf) whose origin decides a run's authority, with that origin. */
export function latestDecisiveEntry(
	branch: readonly SessionEntry[],
	before = branch.length,
): { readonly index: number; readonly entry: SessionEntry; readonly origin: TurnOriginRecord } | undefined {
	for (let index = Math.min(before, branch.length) - 1; index >= 0; index--) {
		const entry = branch[index];
		const origin = entry === undefined ? undefined : entryTurnOrigin(entry);
		if (entry && origin && isDecisiveOrigin(origin)) return { index, entry, origin };
	}
	return undefined;
}

/**
 * The run in progress as an owner's approval reads it: its decisive origin, and whether a message the run itself took in
 * set it (`decidedInRun`), rather than the branch it extends (a continuation, a wake, a routine delivery inherits it).
 */
export interface LiveRunOrigin {
	readonly origin: TurnOriginRecord;
	readonly decidedInRun: boolean;
}

/**
 * The authority of the foreground run in progress. The owner's typed words, the owner's words from a verified owner
 * channel and a third party's words decide it, the latest of them on the session branch wins: a peer's message makes the
 * run third-party, the owner's words after it give it back (typed words as the owner, a phone message as the remote
 * owner). The owner's own automation (routines, CI, workers, goal continuations, notices, extensions) never decides: a
 * run it opens or continues answers whoever the branch last answered, so a goal continuation or a wake after a peer's
 * run stays third-party until the owner types. Outside a run, and on a branch nobody decisive wrote, the authority is
 * the owner's.
 */
export class RunTurnOrigin {
	private active = false;
	private latest: TurnOriginRecord | undefined;
	/** Whether `latest` was set by a message this run took in, not read from the branch at `begin`. */
	private decidedInRun = false;

	/**
	 * A run starts from the session branch it extends (every entry mode alike: a prompt, a committed turn, a
	 * continuation), read back to its latest decisive entry. Entries keep their identities through compaction, so a
	 * summarized history still names who it last answered. The messages that open the run are then noted in order.
	 */
	begin(opening: readonly AgentMessage[], branch: readonly SessionEntry[]): void {
		this.active = true;
		this.latest = latestDecisiveEntry(branch)?.origin;
		this.decidedInRun = false;
		for (const message of opening) this.note(message);
	}

	/** A message the running agent took into its context (a steer, a follow-up, a delivered next-turn message). */
	note(message: AgentMessage): void {
		if (!this.active) return;
		const origin = turnOriginOf(message);
		if (origin && isDecisiveOrigin(origin)) {
			this.latest = origin;
			this.decidedInRun = true;
		}
	}

	end(): void {
		this.active = false;
		this.latest = undefined;
		this.decidedInRun = false;
	}

	/** The run in progress with its decisive origin and whether the run decided it; undefined when there is none. */
	live(): LiveRunOrigin | undefined {
		return this.latest === undefined ? undefined : { origin: this.latest, decidedInRun: this.decidedInRun };
	}

	/** True while a run is in progress (between `begin` and `end`). */
	isActive(): boolean {
		return this.active;
	}

	/** The decisive origin of the run in progress, if any. */
	origin(): TurnOriginRecord | undefined {
		return this.latest;
	}

	authority(): TurnAuthority {
		if (isThirdPartyOrigin(this.latest)) return "third-party";
		return isRemoteOwnerOrigin(this.latest) ? "remote-owner" : "owner";
	}
}
