/**
 * A message to a bot whose session another process hosts: it goes to the bot's inbox (`bot-inbox.ts`), which that host
 * takes and answers in the bot's chat. A host that let the bot go between the refused lock and the write would leave it
 * to no one, so the bot is then opened here, which takes the inbox first (this message included); a refusal of that open
 * takes the message back and is the send's own, unless the host opens the session again later (`openLater`: a cause that
 * passes on its own, not past its cap): the message then waits, and the owner is told why (`waitsFor`).
 */

import type {
	BotOperatorMessageDispatchResult,
	BotOperatorMessageOptions,
} from "../delegation/bot-operator-message-options.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { interfaceText } from "../language/interface-text.ts";
import { botFailureText } from "./bot-failure-words.ts";
import { readRemoteBotHost } from "./bot-host-state.ts";
import { enqueueBotInbox, takeBotInboxMessage } from "./bot-inbox.ts";
import { BotOwnerError } from "./bot-owner-error.ts";

/** Another host holds the bot's lock: a message goes to the bot's inbox for it instead (`sendToBotHost`). */
export class BotSessionHeldError extends BotOwnerError {
	override readonly name = "BotSessionHeldError";
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
	/** The open failed with `error`: whether the host opens it again after a backoff (`BotOwedWork.openLater`). */
	openLater(agentId: string, error: unknown): boolean;
}

/**
 * The owner's words to a bot this host runs, while a stop of it waits that could not be taken: no turn starts on them
 * before the stop is applied, so they wait in the bot's inbox, which the host takes only behind its waiting stops (taken
 * again on the stop's retry), and the owner is told why (`waitsFor`).
 */
export function queueBehindBotStop(
	agentDir: string,
	agentId: string,
	message: string,
	mode: BotOperatorMessageOptions["mode"],
	from: { readonly sessionId: string; readonly cwd: string },
	modelRef: string,
): BotOperatorMessageDispatchResult {
	const item = enqueueOwnerWords(agentDir, agentId, message, mode, from);
	return {
		agentId,
		mode: "queued",
		messageId: item.message.id,
		modelRef,
		waitsFor: interfaceText().botTeam.botWordsWaitBehindStop(agentId),
	};
}

/** Writes the owner's words, sent from `from` in this process, to the bot's inbox. */
function enqueueOwnerWords(
	agentDir: string,
	agentId: string,
	message: string,
	mode: BotOperatorMessageOptions["mode"],
	from: { readonly sessionId: string; readonly cwd: string },
): ReturnType<typeof enqueueBotInbox> {
	return enqueueBotInbox(agentDir, {
		agentId,
		text: message,
		...(mode !== undefined ? { mode } : {}),
		from: { pid: process.pid, sessionId: from.sessionId, cwd: from.cwd },
		at: Date.now(),
	});
}

/** Sends the owner's words to the bot's inbox for the host that runs its session (see the module comment). */
export async function sendToBotHost(
	ports: BotInboxSendPorts,
	agentId: string,
	message: string,
	mode: BotOperatorMessageOptions["mode"],
	from: { readonly sessionId: string; readonly cwd: string },
): Promise<BotOperatorMessageDispatchResult> {
	const { agentDir, holder } = ports;
	const record = ports.store().getBot(agentId);
	const modelRef = record ? `${record.provider}/${record.modelId}` : "";
	const item = enqueueOwnerWords(agentDir, agentId, message, mode, from);
	ports.changed(agentId);
	let host = readRemoteBotHost(agentDir, agentId, holder);
	let waitsFor: string | undefined;
	if (!host) {
		try {
			await ports.open(agentId);
			return { agentId, mode: "queued", messageId: item.message.id, modelRef };
		} catch (error) {
			// A session that opens later keeps the words waiting, and the owner is told why; any other failure takes them back.
			if (ports.openLater(agentId, error)) waitsFor = botFailureText(agentId, error);
			else if (!(error instanceof BotSessionHeldError)) {
				takeBotInboxMessage(item);
				ports.changed(agentId);
				throw error;
			}
			host = readRemoteBotHost(agentDir, agentId, holder);
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
