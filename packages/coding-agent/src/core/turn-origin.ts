/**
 * The origin of every message that can open or steer a turn, and the authority of the run that carries it. One owner:
 * every gate that scopes authority by origin reads it here.
 *
 * Origins are recorded at ingestion, never classified afterwards by a model or by text. A message names its origin by
 * the identity it already carries: the owner-input id an accepted submission is minted under, the custom type of a host
 * or extension message, or, for a third party's words an extension delivers (`SendUserMessageOrigin`), the stamp written
 * where the message is created and persisted on its entry (`kernel/turn-origin-stamp.ts`).
 */

import { ownerInputIdOf } from "../kernel/owner-input-stamp.ts";
import type { SessionEntry } from "../kernel/session/session-entries.ts";
import type { TurnOriginRecord } from "../kernel/turn-origin-stamp.ts";
import {
	MAX_TURN_ORIGIN_REF_CHARS,
	parseTurnOriginRecord,
	turnOriginStampOf,
	UNREADABLE_TURN_ORIGIN,
} from "../kernel/turn-origin-stamp.ts";
import type { AgentMessage } from "../kernel/types.ts";
import { parseWorkerControlRecord, type WorkerControlRecord, workerControlOf } from "../kernel/worker-control-stamp.ts";
import type { OwnerChannelOrigin } from "./channels/owner-channel-types.ts";
import { CHAT_EXTENSION_NAME } from "./chat/constants.ts";
import { HOST_EVENT_CUSTOM_TYPE } from "./events/host-event-delivery.ts";
import type { SendUserMessageOrigin } from "./extensions/types.ts";
import { GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE } from "./goals/goal-continuation-prompt.ts";
import { HARNESS_NOTICE_CUSTOM_TYPE } from "./harness-notice.ts";
import { HOST_TURN_CUSTOM_TYPES } from "./host-turn-reasoning.ts";
import { HUMAN_INPUT_WORKER_RESPONSE_CUSTOM_TYPE } from "./human-input.ts";
import { isOwnerChannelInputId, isOwnerSpokenInputId } from "./owner-input-ledger.ts";
import { PROACTIVE_NOTE_CUSTOM_TYPE } from "./proactivity/proactivity-review.ts";
import { ROUTINE_COMPLETION_TYPE, ROUTINE_INTAKE_NOTICE_TYPE } from "./routines/routine-parent-input.ts";
import { isPlainRecord } from "./util/value-guards.ts";

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
	origin: Pick<SendUserMessageOrigin, "channel" | "verified" | "ref">,
): TurnOriginRecord {
	return (
		parseTurnOriginRecord({
			v: 1,
			k: origin.channel === CHAT_EXTENSION_NAME ? "peer-agent" : "inbound-channel",
			channel: origin.channel,
			...(origin.verified === true ? { verified: true as const } : {}),
			thirdParty: true,
			...(origin.ref !== undefined ? { ref: origin.ref } : {}),
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
