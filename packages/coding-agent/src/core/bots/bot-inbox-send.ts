/**
 * A message to a bot whose session another process hosts: it goes to the bot's inbox (`bot-inbox.ts`), which that host
 * takes and answers in the bot's chat. A host that let the bot go between the refused lock and the write would leave it
 * to no one, so the bot is then opened here, which takes the inbox first (this message included); a refusal of that open
 * takes the message back and is the send's own, unless the host opens the session again later (`openLater`: a cause that
 * passes on its own, not past its cap): the message then waits, and unless another host took the bot meanwhile the owner
 * is told why, by the sender when it shows the result's `waitsFor` (`showsWaits`), else by the host (`sentWaits`).
 */

import type {
	BotDeliveryOptions,
	BotDeliveryOrigin,
	BotOperatorMessageDispatchResult,
	BotOperatorMessageOptions,
} from "../delegation/bot-operator-message-options.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { interfaceText } from "../language/interface-text.ts";
import { OWNER_STOP_CLOCK } from "../util/timer-port.ts";
import { readRemoteBotHost } from "./bot-host-state.ts";
import { enqueueBotInbox, takeBotInboxMessage } from "./bot-inbox.ts";
import { BotOwnerError } from "./bot-owner-error.ts";
import type { BotOwedWork } from "./bot-session-owed-work.ts";

/** Another host holds the bot's lock: a message goes to the bot's inbox for it instead (`sendToBotHost`). */
export class BotSessionHeldError extends BotOwnerError {
	override readonly name = "BotSessionHeldError";
}

/** Where the owner's words were sent from: the sender's directory, and its pi session when it has one (none in the daemon). */
export interface BotInboxFrom {
	readonly sessionId?: string;
	readonly cwd: string;
}

/** What a send to another host reads and asks of the sending host. */
export interface BotInboxSendPorts {
	readonly agentDir: string;
	/** The sending host among any other in its process (`HostLockRecord.holder`). */
	readonly holder: string;
	store(): PersistentBotTeamStore;
	/** The bot's state changed (its inbox): the roster and an open chat follow it. */
	changed(agentId: string): void;
	/** Opens the bot's session here; throws `BotSessionHeldError` while another host holds it. */
	open(agentId: string): Promise<unknown>;
	/**
	 * The host's owed work: whether a failed open is asked again after a backoff (`openLater`), and why the message waits
	 * when it is, told to the owner by the sender or the host (`sentWaits`).
	 */
	readonly owed: Pick<BotOwedWork, "openLater" | "sentWaits">;
}

/**
 * The owner's words to a bot this host runs, left in its inbox instead of given, which the host takes in order and only
 * behind the stops waiting for the bot (taken again on a stop's retry): behind a stop that waits and could not be taken
 * (`behindStop`: no turn starts on them before it is applied, and the owner is told why, `waitsFor`), or behind words
 * the inbox still holds, which go first.
 */
export function queueInBotInbox(
	agentDir: string,
	agentId: string,
	message: string,
	mode: BotOperatorMessageOptions["mode"],
	from: BotInboxFrom,
	modelRef: string,
	behindStop: boolean,
	origin: BotDeliveryOrigin,
): BotOperatorMessageDispatchResult {
	const item = enqueueWords(agentDir, agentId, message, mode, from, origin);
	return {
		agentId,
		mode: "queued",
		messageId: item.message.id,
		modelRef,
		...(behindStop ? { waitsFor: interfaceText().botTeam.botWordsWaitBehindStop(agentId) } : {}),
	};
}

/** Writes the words, sent from `from` in this process, to the bot's inbox: the owner's, or a mail record under their origin. */
function enqueueWords(
	agentDir: string,
	agentId: string,
	message: string,
	mode: BotOperatorMessageOptions["mode"],
	from: BotInboxFrom,
	origin: BotDeliveryOrigin,
): ReturnType<typeof enqueueBotInbox> {
	return enqueueBotInbox(agentDir, {
		agentId,
		text: message,
		...(mode !== undefined ? { mode } : {}),
		from: { pid: process.pid, ...(from.sessionId !== undefined ? { sessionId: from.sessionId } : {}), cwd: from.cwd },
		// The clock a stop of the bot is dated on, which decides whether these words came before it.
		at: OWNER_STOP_CLOCK.now(),
		...(origin !== "owner" ? { origin } : {}),
	});
}

/** Sends the owner's words to the bot's inbox for the host that runs its session (see the module comment). */
export async function sendToBotHost(
	ports: BotInboxSendPorts,
	agentId: string,
	message: string,
	{ mode, showsWaits = false }: BotDeliveryOptions,
	from: BotInboxFrom,
	origin: BotDeliveryOrigin,
): Promise<BotOperatorMessageDispatchResult> {
	const { agentDir, holder } = ports;
	const record = ports.store().getBot(agentId);
	const modelRef = record ? `${record.provider}/${record.modelId}` : "";
	const item = enqueueWords(agentDir, agentId, message, mode, from, origin);
	ports.changed(agentId);
	let host = readRemoteBotHost(agentDir, agentId, holder);
	let waitsFor: string | undefined;
	if (!host) {
		try {
			await ports.open(agentId);
			return { agentId, mode: "queued", messageId: item.message.id, modelRef };
		} catch (error) {
			// A session that opens later keeps the words waiting, and the owner is told why unless another host took the bot
			// meanwhile; any other failure takes them back.
			const later = ports.owed.openLater(agentId, error);
			if (!later && !(error instanceof BotSessionHeldError)) {
				takeBotInboxMessage(item);
				ports.changed(agentId);
				throw error;
			}
			host = readRemoteBotHost(agentDir, agentId, holder);
			if (later && !host)
				waitsFor = interfaceText().botTeam.botWordsWaitForOpen(
					agentId,
					ports.owed.sentWaits(agentId, error, showsWaits),
				);
		}
	}
	return {
		agentId,
		mode: "queued",
		messageId: item.message.id,
		modelRef,
		...(host
			? { deliveredTo: { pid: host.pid, ...(host.hostSessionId ? { sessionId: host.hostSessionId } : {}) } }
			: waitsFor !== undefined
				? { waitsFor }
				: {}),
	};
}
