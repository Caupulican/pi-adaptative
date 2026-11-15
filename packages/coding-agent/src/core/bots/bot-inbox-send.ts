/**
 * A message to a bot whose session another process hosts: it goes to the bot's inbox (`bot-inbox.ts`), which that host
 * takes and answers in the bot's chat. A host that let the bot go between the refused lock and the write would leave it
 * to no one, so the bot is then opened here, which takes the inbox first (this message included); a refusal of that open
 * takes the message back and is the send's own.
 */

import type {
	BotOperatorMessageDispatchResult,
	BotOperatorMessageOptions,
} from "../delegation/bot-operator-message-options.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { readRemoteBotHost } from "./bot-host-state.ts";
import { enqueueBotInbox, takeBotInboxMessage } from "./bot-inbox.ts";

/** Another host holds the bot's lock: a message goes to the bot's inbox for it instead (`sendToBotHost`). */
export class BotSessionHeldError extends Error {
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
	const item = enqueueBotInbox(agentDir, {
		agentId,
		text: message,
		...(mode !== undefined ? { mode } : {}),
		from: { pid: process.pid, sessionId: from.sessionId, cwd: from.cwd },
		at: Date.now(),
	});
	ports.changed(agentId);
	let host = readRemoteBotHost(agentDir, agentId, holder);
	if (!host) {
		try {
			await ports.open(agentId);
			return { agentId, mode: "queued", messageId: item.message.id, modelRef };
		} catch (error) {
			if (!(error instanceof BotSessionHeldError)) {
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
			: {}),
	};
}
