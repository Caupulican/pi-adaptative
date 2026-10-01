import type { ExtensionAPI, ExtensionCommandContext } from "../extensions/types.ts";
import { CHAT_CUSTOM_MESSAGE_TYPE, CHAT_EXTENSION_NAME } from "./constants.ts";
import { createFilesystemIdentity, resolveIdentity } from "./identity.ts";
import { getChatPlatformInfo } from "./platform.ts";
import {
	chatStateSummary,
	createDefaultChatConfig,
	getChatStatePaths,
	type PeerRecord,
	readChatConfig,
	readChatIdentity,
	readChatPeers,
	writeChatConfig,
	writeChatIdentity,
	writeChatPeers,
} from "./state.ts";
import { type ChatRuntime, currentChatIdentity } from "./tools.ts";

const SUBCOMMANDS = ["status", "setup", "peers", "help"];

function sendCommandMessage(pi: ExtensionAPI, content: string, details: Record<string, unknown>): void {
	pi.sendMessage(
		{ customType: CHAT_CUSTOM_MESSAGE_TYPE, content, display: true, details },
		{ triggerTurn: false, deliverAs: "nextTurn" },
	);
}

function showHelp(pi: ExtensionAPI, prefix?: string): void {
	const lines = [
		...(prefix ? [prefix, ""] : []),
		`/${CHAT_EXTENSION_NAME} status - show mesh, identity and tool state`,
		`/${CHAT_EXTENSION_NAME} setup  - create local state and a persistent identity after confirmation`,
		`/${CHAT_EXTENSION_NAME} peers  - list live and known peers`,
		`/${CHAT_EXTENSION_NAME} help   - show this help`,
		"Tools: list_peers and agent_send. Payloads are not end-to-end encrypted; never send secrets.",
	];
	sendCommandMessage(pi, lines.join("\n"), { command: "help" });
}

function showStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext, runtime: ChatRuntime): void {
	const state = chatStateSummary(runtime.stateRoot);
	const stored = readChatIdentity(runtime.stateRoot);
	const self = resolveIdentity(runtime.identity, stored);
	const platform = getChatPlatformInfo(runtime.stateRoot);
	const mesh = runtime.mesh.status();
	const lines = [
		`${CHAT_EXTENSION_NAME}`,
		`state root: ${state.root}`,
		"state scope: user-global transport endpoint (config, identity and known peers only; message bodies are not persisted)",
		`configured: ${state.configured ? "yes" : "no"}`,
		`identity: ${state.identityAvailable ? `${self.name} (${self.id})` : `ephemeral ${self.name} (${self.id})`}`,
		`mesh: ${mesh.supported ? (mesh.brokerActive ? "unix broker" : mesh.connected ? "unix client" : "not connected") : "unsupported"}`,
		`endpoint: ${mesh.endpoint ?? platform.socketPath ?? "not available"}`,
		`known peers: ${state.peerCount}`,
		`audit log: ${getChatStatePaths(runtime.stateRoot).audit}`,
	];
	if (platform.note) lines.push(`platform note: ${platform.note}`);
	ctx.ui.setStatus(CHAT_EXTENSION_NAME, state.configured ? "pi-chat: ready" : "pi-chat: setup needed");
	sendCommandMessage(pi, lines.join("\n"), { command: "status", state, platform, mesh });
}

async function setup(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: ChatRuntime,
	requestedName: string,
): Promise<void> {
	const existing = readChatConfig(runtime.stateRoot);
	const message = [
		"Create pi-chat user-global transport state and a persistent identity?",
		`State root: ${runtime.stateRoot}`,
		"This writes config.json, identity.json and peers.json with best-effort private permissions.",
		"It does not persist message bodies, send secrets, or run commands.",
		existing ? "Existing pi-chat config is updated in place." : "No existing pi-chat config was found.",
	].join("\n");
	if (!ctx.hasUI) {
		sendCommandMessage(
			pi,
			`${message}\n\nSetup was not run because this mode cannot ask for confirmation. Run /${CHAT_EXTENSION_NAME} setup interactively.`,
			{ command: "setup", changed: false },
		);
		return;
	}
	if (!(await ctx.ui.confirm("pi-chat setup", message, { timeout: 30_000 }))) {
		sendCommandMessage(pi, "pi-chat setup cancelled; no files were written.", { command: "setup", changed: false });
		return;
	}
	const now = new Date();
	const config = existing ?? createDefaultChatConfig(now);
	config.updatedAt = now.toISOString();
	writeChatConfig(runtime.stateRoot, config);
	if (!readChatIdentity(runtime.stateRoot)) {
		writeChatIdentity(runtime.stateRoot, createFilesystemIdentity(requestedName || runtime.identity.name, now));
	}
	const stored = readChatIdentity(runtime.stateRoot);
	if (stored) {
		const resolved = resolveIdentity(runtime.identity, stored);
		runtime.identity.id = resolved.id;
		runtime.identity.name = resolved.name;
		runtime.identity.pcLabel = resolved.pcLabel;
		runtime.identity.persistent = resolved.persistent;
		runtime.mesh.updateSelf(runtime.identity);
	}
	if (readChatPeers(runtime.stateRoot).length === 0) writeChatPeers(runtime.stateRoot, []);
	ctx.ui.setStatus(CHAT_EXTENSION_NAME, "pi-chat: ready");
	sendCommandMessage(pi, `pi-chat setup complete. State root: ${runtime.stateRoot}`, {
		command: "setup",
		changed: true,
		stateRoot: runtime.stateRoot,
	});
}

function showPeers(pi: ExtensionAPI, runtime: ChatRuntime): void {
	const self = currentChatIdentity(runtime);
	const byId = new Map<string, PeerRecord>(readChatPeers(runtime.stateRoot).map((peer) => [peer.id, peer]));
	for (const peer of runtime.mesh.listPeers(false)) byId.set(peer.id, peer);
	const peers = [...byId.values()];
	const mesh = runtime.mesh.status();
	const lines = [
		`self: ${self.name} (${self.id})`,
		`mesh: ${mesh.supported ? (mesh.brokerActive ? "unix broker" : mesh.connected ? "unix client" : "not connected") : "unsupported"}`,
		`known/live peers: ${peers.length}`,
	];
	if (peers.length > 0) {
		for (const peer of peers) {
			lines.push(
				`- ${peer.id} | ${peer.name} | ${peer.busy ? "busy" : "idle/unknown"} | ${peer.lastSeen ?? "unknown last seen"}`,
			);
		}
	} else {
		lines.push("No peers are known yet. Keep another pi session with pi-chat running.");
	}
	sendCommandMessage(pi, lines.join("\n"), { command: "peers", self, mesh, peers });
}

export function registerChatCommand(pi: ExtensionAPI, runtime: ChatRuntime): void {
	pi.registerCommand(CHAT_EXTENSION_NAME, {
		description: "Manage pi-chat, the local peer-agent message mesh",
		getArgumentCompletions: (prefix) => {
			const filtered = SUBCOMMANDS.filter((item) => item.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered.map((item) => ({ value: item, label: item })) : null;
		},
		handler: async (args, ctx) => {
			const [subcommand = "help", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (subcommand === "status") return showStatus(pi, ctx, runtime);
			if (subcommand === "setup") return setup(pi, ctx, runtime, rest.join(" "));
			if (subcommand === "peers") return showPeers(pi, runtime);
			return showHelp(
				pi,
				subcommand === "help" ? undefined : `Unknown /${CHAT_EXTENSION_NAME} subcommand: ${subcommand}`,
			);
		},
	});
}
