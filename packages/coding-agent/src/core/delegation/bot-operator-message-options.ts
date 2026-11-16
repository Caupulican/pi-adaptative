/** The options one operator-to-bot message carries: its turn kind, who asked, the delegation it is filed under and its replay identity. */

import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";

/** How the orchestrator's or a leader's words reach a bot: the kind of turn, who asked, and the delegation it is filed under. */
export interface BotOperatorMessageOptions {
	mode?: "follow_up" | "queue" | "start";
	/** The orchestrator asked: the bot's answer is for the orchestrator, not an owner-direct chat. */
	fromRoot?: boolean;
	/**
	 * A scheduled routine sent it, under this origin (`routineBotMessageOrigin`): a bot that answers in a session of its own
	 * takes the prompt there as its turn (as a mail from the group, for a group's routine), any other bot as a worker.
	 */
	fromRoutine?: TurnOriginRecord;
	/**
	 * The owner sent it from the orchestrator's own conversation: a joined machine's answer comes into that
	 * conversation, since nobody has the machine's chat open to see it arrive.
	 */
	answerInSession?: boolean;
	/**
	 * The orchestrator's words are for this delegation to a leader (its brief, update, resume or answer). Set only by the
	 * leader controller and the orchestrator's `bot ask`; an owner's chat leaves it out, so that turn is session work.
	 */
	delegationObjectiveId?: string;
	/** The replay identity of this send: a repeated send with the same key is one message (the Outcome of a nested goal). */
	idempotencyKey?: string;
	/** The alias of the leader whose words these are (a nested goal's outcome or question, a parent's update); absent for the orchestrator. */
	fromLeader?: string;
	/**
	 * The sender shows the owner why the message waits (the result's `waitsFor`): that counts as telling them. Without it
	 * the bot's host tells the owner itself.
	 */
	showsWaits?: boolean;
}

/** What the bot's own session host reads of a send: the kind of turn, and whether the sender shows why it waits. */
export type BotDeliveryOptions = Pick<BotOperatorMessageOptions, "mode" | "showsWaits">;

/**
 * Whose words a bot's own session is given: the owner's (`owner`), or words whose origin the host records itself (an
 * agent's mail, a routine's prompt): the turn is stamped with that record (`recordedMessageOrigin`) and the words never
 * count as the owner's.
 */
export type BotDeliveryOrigin = "owner" | TurnOriginRecord;

/** What one operator-to-bot message became: the turn kind it took, and where it went. */
export interface BotOperatorMessageDispatchResult {
	readonly agentId: string;
	readonly mode: "started" | "followed_up" | "steered" | "queued";
	readonly messageId?: string;
	readonly laneId?: string;
	readonly modelRef: string;
	/** Another process hosts the bot's session: the message waits in the bot's inbox for that host (`bots/bot-inbox.ts`). */
	readonly deliveredTo?: { readonly pid: number; readonly sessionId?: string };
	/** The message waits in the bot's inbox (its session opens later, or a stop of it waits): the owner's whole sentence saying so and why. */
	readonly waitsFor?: string;
}
