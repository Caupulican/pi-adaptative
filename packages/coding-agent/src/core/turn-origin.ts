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
import type { TurnOriginRecord } from "../kernel/turn-origin-stamp.ts";
import { turnOriginStampOf } from "../kernel/turn-origin-stamp.ts";
import type { AgentMessage } from "../kernel/types.ts";
import { workerControlOf } from "../kernel/worker-control-stamp.ts";
import { CHAT_EXTENSION_NAME } from "./chat/constants.ts";
import { HOST_EVENT_CUSTOM_TYPE } from "./events/host-event-delivery.ts";
import type { SendUserMessageOrigin } from "./extensions/types.ts";
import { GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE } from "./goals/goal-continuation-prompt.ts";
import { HARNESS_NOTICE_CUSTOM_TYPE } from "./harness-notice.ts";
import { HOST_TURN_CUSTOM_TYPES } from "./host-turn-reasoning.ts";
import { HUMAN_INPUT_WORKER_RESPONSE_CUSTOM_TYPE } from "./human-input.ts";
import { isOwnerSpokenInputId } from "./owner-input-ledger.ts";
import { PROACTIVE_NOTE_CUSTOM_TYPE } from "./proactivity/proactivity-review.ts";
import { ROUTINE_COMPLETION_TYPE, ROUTINE_INTAKE_NOTICE_TYPE } from "./routines/routine-parent-input.ts";

export type { TurnOriginKind, TurnOriginRecord } from "../kernel/turn-origin-stamp.ts";

/** Who the run answers: the owner (their words or their own automation), or a third party whose words it carries. */
export type TurnAuthority = "owner" | "third-party";

/** The origin of a third party's words an extension delivers: a peer agent on the chat mesh, or another channel. */
export function channelTurnOrigin(origin: SendUserMessageOrigin): TurnOriginRecord {
	return {
		v: 1,
		k: origin.channel === CHAT_EXTENSION_NAME ? "peer-agent" : "inbound-channel",
		channel: origin.channel,
		...(origin.verified ? { verified: true as const } : {}),
		thirdParty: true,
	};
}

/** The owner's own words: typed, or holding text they pasted (which never grants standing authority). */
export function ownerWordsOrigin(pasted: readonly unknown[] | undefined): TurnOriginRecord {
	return { v: 1, k: pasted && pasted.length > 0 ? "owner-paste" : "owner-typed" };
}

/** The origin a custom message's type names. A type nobody registered here is the owner's installed code. */
function customTurnOrigin(customType: string): TurnOriginRecord {
	switch (customType) {
		case HOST_EVENT_CUSTOM_TYPE:
			return { v: 1, k: "host-event" };
		case HARNESS_NOTICE_CUSTOM_TYPE:
			return { v: 1, k: "harness" };
		case ROUTINE_COMPLETION_TYPE:
		case ROUTINE_INTAKE_NOTICE_TYPE:
			return { v: 1, k: "routine" };
		case PROACTIVE_NOTE_CUSTOM_TYPE:
			return { v: 1, k: "proactive-review" };
		case GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE:
			return { v: 1, k: "goal-continuation" };
		case HUMAN_INPUT_WORKER_RESPONSE_CUSTOM_TYPE:
			return { v: 1, k: "worker-result" };
		default:
			return (HOST_TURN_CUSTOM_TYPES as readonly string[]).includes(customType)
				? { v: 1, k: "worker-result" }
				: { v: 1, k: "extension-message" };
	}
}

/**
 * The origin of a message that can open or steer a turn; `undefined` for an answer, a tool result or a summary. A user
 * message with no stamp (one rebuilt from history, whose entry names a third party's words otherwise) is the owner's.
 */
export function turnOriginOf(message: AgentMessage): TurnOriginRecord | undefined {
	const stamped = turnOriginStampOf(message);
	if (stamped) return stamped;
	if (message.role === "custom") return customTurnOrigin(message.customType);
	if (message.role !== "user") return undefined;
	const control = workerControlOf(message);
	if (control) return { v: 1, k: control.k === "host_event" ? "host-event" : "harness" };
	const inputId = ownerInputIdOf(message);
	return { v: 1, k: inputId === undefined || isOwnerSpokenInputId(inputId) ? "owner-typed" : "extension-message" };
}

export function isThirdPartyOrigin(origin: TurnOriginRecord | undefined): boolean {
	return origin?.thirdParty === true;
}

/** The owner's typed words and a third party's words decide a run's authority; the owner's automation does not. */
function isDecisive(origin: TurnOriginRecord): boolean {
	return origin.thirdParty === true || origin.k === "owner-typed";
}

/**
 * The authority of the foreground run in progress. The owner's typed words and a third party's words decide it, the
 * latest of them wins: a peer's message makes the run third-party, the owner's steer after it gives it back. The
 * owner's own automation (routines, CI, workers, goals, notices, extensions) runs under the authority the run already
 * has. Outside a run, and in a run nobody decisive opened, the authority is the owner's.
 */
export class RunTurnOrigin {
	private active = false;
	private latest: TurnOriginRecord | undefined;

	/**
	 * A run starts with the messages that open it. A continuation opens with none: it answers the latest decisive message
	 * in its history, wherever the run it continues stopped (after a tool result, an answer or the owner's automation).
	 */
	begin(opening: readonly AgentMessage[], history?: readonly AgentMessage[]): void {
		this.active = true;
		this.latest = undefined;
		const past = history ?? [];
		for (let index = past.length - 1; index >= 0; index--) {
			const message = past[index];
			const origin = message === undefined ? undefined : turnOriginOf(message);
			if (origin && isDecisive(origin)) {
				this.latest = origin;
				break;
			}
		}
		for (const message of opening) this.note(message);
	}

	/** A message the running agent took into its context (a steer, a follow-up, a delivered next-turn message). */
	note(message: AgentMessage): void {
		if (!this.active) return;
		const origin = turnOriginOf(message);
		if (origin && isDecisive(origin)) this.latest = origin;
	}

	end(): void {
		this.active = false;
		this.latest = undefined;
	}

	/** The decisive origin of the run in progress, if any. */
	origin(): TurnOriginRecord | undefined {
		return this.latest;
	}

	authority(): TurnAuthority {
		return isThirdPartyOrigin(this.latest) ? "third-party" : "owner";
	}
}
