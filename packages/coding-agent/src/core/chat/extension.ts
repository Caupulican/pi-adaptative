import { join } from "node:path";
import { getBundledResourcesDir } from "../../config.ts";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { ExtensionAPI, ExtensionUIContext } from "../extensions/types.ts";
import type { InboxExpiredUnread } from "../messaging/inbox.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { isWorkerSession } from "../session-role.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { registerChatCommand } from "./commands.ts";
import {
	CHAT_CUSTOM_MESSAGE_TYPE,
	CHAT_EXTENSION_NAME,
	defaultChatStateRoot,
	MAX_PENDING_VISIBLE_CARDS,
	MAX_REPLY_HOPS,
} from "./constants.ts";
import { bindSessionIdentity, createRuntimeIdentity, resolveIdentity } from "./identity.ts";
import { incomingPeerRecord, incomingPrompt, incomingSummary, lineCount } from "./incoming.ts";
import { ChatMesh, type IncomingPeerMessage } from "./mesh.ts";
import { getChatPlatformInfo } from "./platform.ts";
import { appendChatAudit, type ChatIdentity, readChatIdentity } from "./state.ts";
import { type ChatRuntime, currentChatIdentity, registerChatTools } from "./tools.ts";

export type ChatExtensionOptions = {
	/** Defaults to `~/.pi/pi-chat`, or `PI_CHAT_STATE_ROOT`. */
	stateRoot?: string;
};

/** Peers whose reply chain is remembered at once; the oldest is forgotten first. */
const MAX_TRACKED_REPLY_CHAINS = 64;

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
	// `list_peers`/`agent_send` are already outside a worker's tool ceiling; joining the mesh would still make
	// the worker an addressable peer whose transcript any local process can steer. Workers report to their
	// parent only, so a worker session registers nothing and opens no socket.
	if (isWorkerSession()) return;
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
			verified: message.from.verified === true,
			expectReply: message.expectReply,
			queued: message.queuedAt !== undefined,
		});
		const sentHops = message.metadata?.hops;
		const hops = typeof sentHops === "number" && Number.isInteger(sentHops) && sentHops > 0 ? sentHops : 1;
		runtime.inboundHops.delete(message.from.id);
		runtime.inboundHops.set(message.from.id, { hops, at: Date.now() });
		while (runtime.inboundHops.size > MAX_TRACKED_REPLY_CHAINS) {
			const oldest = runtime.inboundHops.keys().next().value;
			if (oldest === undefined) break;
			runtime.inboundHops.delete(oldest);
		}
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
				replyAllowed: incomingPeerRecord(message, hops, MAX_REPLY_HOPS).replyAllowed,
				hops,
				maxHops: MAX_REPLY_HOPS,
				metadata: message.metadata,
				queuedAt: message.queuedAt,
				message: message.message,
				messageBytes: bytes,
				messageLines: lines,
				receivedAt: new Date().toISOString(),
				summary,
			},
		});
		// The sender is acknowledged only once the session holds the message: queued behind the running turn
		// in its recoverable pending queue, or starting as its own turn. A message the session refused or
		// that was taken back before that is reported as undelivered, never acknowledged.
		const accepted = await new Promise<boolean>((resolve) => {
			pi.sendUserMessage(incomingPrompt(message, hops, MAX_REPLY_HOPS), {
				deliverAs: "steer",
				processSlashCommands: false,
				// The queue, the durable record and the editor show the peer's words under their sender, not the frame.
				origin: {
					channel: CHAT_EXTENSION_NAME,
					sender: message.from.name,
					verified: message.from.verified === true,
					text: message.message,
				},
				onAccepted: resolve,
			});
		});
		if (!accepted) throw new Error("NOT DELIVERED: the session did not accept the message.");
		return "ACK: delivered; queued for immediate Pi turn.";
	};

	// Expired mail is acknowledged in the inbox only once this session's branch holds the card that names it.
	let sessionBranch: (() => readonly SessionEntry[]) | undefined;
	const toldExpired = new Set<string>();
	const expiredKey = (item: InboxExpiredUnread) => `${item.sender}\0${item.id}`;
	const handleExpired = (expired: readonly InboxExpiredUnread[]): boolean => {
		const recorded = new Set(
			(sessionBranch?.() ?? []).flatMap((entry) =>
				entry.type === "custom_message" &&
				entry.customType === CHAT_CUSTOM_MESSAGE_TYPE &&
				isPlainRecord(entry.details) &&
				entry.details.kind === "expired" &&
				Array.isArray(entry.details.keys)
					? entry.details.keys
					: [],
			),
		);
		if (expired.every((item) => recorded.has(expiredKey(item)))) return true;
		const untold = expired.filter((item) => !toldExpired.has(expiredKey(item)));
		if (!sessionBranch || untold.length === 0) return false;
		for (const item of untold) toldExpired.add(expiredKey(item));
		const senders = [...new Set(untold.map((item) => item.sender))];
		sendVisibleCard({
			customType: CHAT_CUSTOM_MESSAGE_TYPE,
			// Sender ids come from the inbox file, unverified for expired mail: they reach the model only fenced.
			content: `[pi-chat] ${untold.length} held ${untold.length === 1 ? "message" : "messages"} expired before this session collected ${untold.length === 1 ? "it" : "them"}; the oldest was sent ${untold[0]!.createdAt}. The bodies are gone: ask the sender to resend if it still matters. Sender ids as the inbox recorded them:\n${wrapUntrustedText(`${senders.slice(0, 8).join("\n")}${senders.length > 8 ? `\n(${senders.length - 8} more)` : ""}`, "pi-chat:expired-senders")}`,
			display: true,
			details: { kind: "expired", keys: untold.map(expiredKey) },
		});
		return false;
	};

	const runtime: ChatRuntime = {
		stateRoot,
		identity,
		mesh: new ChatMesh({ self: identity, stateRoot, onIncoming: handleIncoming, onExpired: handleExpired }),
		inboundHops: new Map(),
	};

	registerChatCommand(pi, runtime);
	if (platform.localMeshSupported) registerChatTools(pi, runtime);

	pi.on("resources_discover", () => ({
		skillPaths: [join(getBundledResourcesDir(), "extensions", CHAT_EXTENSION_NAME, "skills", CHAT_EXTENSION_NAME)],
	}));

	pi.on("session_start", async (_event, ctx) => {
		activeUi = ctx.ui;
		sessionBranch = () => ctx.sessionManager.getBranch();
		toldExpired.clear();
		// The mesh id is the session's: it names this peer again after a resume or a restart.
		const bound = bindSessionIdentity(runtime.identity, ctx.sessionManager.getSessionId());
		// Another session taking over this process leaves the mesh under its old id first.
		if (bound.id !== runtime.identity.id) await runtime.mesh.stop();
		runtime.identity = bound;
		runtime.mesh.updateSelf(currentChatIdentity(runtime));
		await runtime.mesh.start();
		ctx.ui.setStatus(CHAT_EXTENSION_NAME, CHAT_EXTENSION_NAME);
	});
	pi.on("agent_start", async () => {
		agentActive = true;
		runtime.mesh.setBusy(true);
	});
	pi.on("agent_end", async () => {
		agentActive = false;
		runtime.mesh.setBusy(false);
		setTimeout(flushPendingCards, 0);
	});
	pi.on("session_shutdown", async (event, ctx) => {
		activeUi = undefined;
		sessionBranch = undefined;
		agentActive = false;
		pendingCards.length = 0;
		await runtime.mesh.stop();
		if (event.reason === "reload") return;
		ctx.ui.setStatus(CHAT_EXTENSION_NAME, undefined);
	});
}
