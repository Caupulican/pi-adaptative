import { join } from "node:path";
import { getBundledResourcesDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionUIContext } from "../extensions/types.ts";
import { registerChatCommand } from "./commands.ts";
import {
	CHAT_CUSTOM_MESSAGE_TYPE,
	CHAT_EXTENSION_NAME,
	defaultChatStateRoot,
	MAX_PENDING_VISIBLE_CARDS,
} from "./constants.ts";
import { createRuntimeIdentity, resolveIdentity } from "./identity.ts";
import { incomingPrompt, incomingSummary, lineCount } from "./incoming.ts";
import { ChatMesh, type IncomingPeerMessage } from "./mesh.ts";
import { getChatPlatformInfo } from "./platform.ts";
import { appendChatAudit, type ChatIdentity, readChatIdentity } from "./state.ts";
import { type ChatRuntime, registerChatTools } from "./tools.ts";

export type ChatExtensionOptions = {
	/** Defaults to `~/.pi/pi-chat`, or `PI_CHAT_STATE_ROOT`. */
	stateRoot?: string;
};

type VisibleCard = { customType: string; content: string; display: boolean; details: Record<string, unknown> };

function readStoredIdentity(stateRoot: string): ChatIdentity | undefined {
	try {
		return readChatIdentity(stateRoot);
	} catch {
		// A malformed identity file must not stop the mesh; the runtime identity is used instead.
		return undefined;
	}
}

export function piChatExtension(pi: ExtensionAPI, options: ChatExtensionOptions = {}): void {
	const stateRoot = options.stateRoot ?? defaultChatStateRoot();
	const platform = getChatPlatformInfo(stateRoot);
	const identity = resolveIdentity(createRuntimeIdentity(), readStoredIdentity(stateRoot));
	const pendingCards: VisibleCard[] = [];
	let activeUi: ExtensionUIContext | undefined;
	let agentActive = false;

	const flushPendingCards = () => {
		if (agentActive) return;
		for (const card of pendingCards.splice(0)) pi.sendMessage(card);
	};
	const sendVisibleCard = (card: VisibleCard) => {
		if (!agentActive) {
			pi.sendMessage(card);
			return;
		}
		pendingCards.push(card);
		while (pendingCards.length > MAX_PENDING_VISIBLE_CARDS) pendingCards.shift();
	};

	const handleIncoming = async (message: IncomingPeerMessage): Promise<string> => {
		appendChatAudit(stateRoot, {
			kind: "agent_receive",
			id: message.id,
			from: message.from.id,
			expectReply: message.expectReply,
		});
		const bytes = Buffer.byteLength(message.message, "utf8");
		const lines = lineCount(message.message);
		const summary = incomingSummary(message, bytes, lines);
		activeUi?.notify(`pi-chat: ${summary}; Ctrl+O expands it`, "info");
		sendVisibleCard({
			customType: CHAT_CUSTOM_MESSAGE_TYPE,
			content: `[pi-chat] ${summary}`,
			display: true,
			details: {
				kind: "incoming",
				id: message.id,
				from: message.from,
				to: message.to,
				expectReply: message.expectReply,
				metadata: message.metadata,
				message: message.message,
				messageBytes: bytes,
				messageLines: lines,
				receivedAt: new Date().toISOString(),
				summary,
			},
		});
		pi.sendUserMessage(incomingPrompt(message), { deliverAs: "steer", processSlashCommands: false });
		return "ACK: delivered; queued for immediate Pi turn.";
	};

	const runtime: ChatRuntime = {
		stateRoot,
		identity,
		mesh: new ChatMesh({ self: identity, stateRoot, onIncoming: handleIncoming }),
	};

	registerChatCommand(pi, runtime);
	if (platform.localMeshSupported) registerChatTools(pi, runtime);

	pi.on("resources_discover", () => ({
		skillPaths: [join(getBundledResourcesDir(), "extensions", CHAT_EXTENSION_NAME, "skills", CHAT_EXTENSION_NAME)],
	}));

	pi.on("session_start", async (_event, ctx) => {
		activeUi = ctx.ui;
		await runtime.mesh.start();
		ctx.ui.setStatus(CHAT_EXTENSION_NAME, CHAT_EXTENSION_NAME);
	});
	pi.on("agent_start", async () => {
		agentActive = true;
	});
	pi.on("agent_end", async () => {
		agentActive = false;
		setTimeout(flushPendingCards, 0);
	});
	pi.on("session_shutdown", async (event, ctx) => {
		activeUi = undefined;
		agentActive = false;
		pendingCards.length = 0;
		await runtime.mesh.stop();
		if (event.reason === "reload") return;
		ctx.ui.setStatus(CHAT_EXTENSION_NAME, undefined);
	});
}
