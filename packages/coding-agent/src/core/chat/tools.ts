import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "../extensions/types.ts";
import { MAX_REPLY_HOPS, REPLY_CHAIN_WINDOW_MS } from "./constants.ts";
import { type RuntimeIdentity, resolveIdentity } from "./identity.ts";
import { type AgentSendResult, type ChatMesh, type DeliveryTarget, resolveTargets } from "./mesh.ts";
import { AgentSendParameters, ListPeersParameters } from "./schemas.ts";
import { appendChatAudit, type PeerRecord, readChatConfig, readChatIdentity, readChatPeers } from "./state.ts";
import { normalizeAgentSendInput } from "./validation.ts";

export type ChatRuntime = {
	stateRoot: string;
	identity: RuntimeIdentity;
	mesh: ChatMesh;
	/** The reply-chain depth of the latest message each peer sent this agent. */
	inboundHops: Map<string, { hops: number; at: number }>;
};

/** The hop count an outgoing message carries: one past the deepest fresh chain among its targets. */
export function nextReplyHops(
	runtime: Pick<ChatRuntime, "inboundHops">,
	targetIds: readonly string[],
	now = Date.now(),
): number {
	let deepest = 0;
	for (const id of targetIds) {
		const inbound = runtime.inboundHops.get(id);
		if (inbound && now - inbound.at <= REPLY_CHAIN_WINDOW_MS) deepest = Math.max(deepest, inbound.hops);
	}
	return deepest + 1;
}

export function currentChatIdentity(runtime: ChatRuntime): RuntimeIdentity {
	return resolveIdentity(runtime.identity, readChatIdentity(runtime.stateRoot));
}

function knownPeers(runtime: ChatRuntime): PeerRecord[] {
	const byId = new Map<string, PeerRecord>();
	for (const peer of readChatPeers(runtime.stateRoot)) byId.set(peer.id, peer);
	for (const peer of runtime.mesh.listPeers(false)) byId.set(peer.id, peer);
	return [...byId.values()];
}

function formatSendResult(targets: readonly DeliveryTarget[]): string {
	return [
		"pi-chat send result:",
		...targets.map((target) => `- ${target.target}: ${target.status}${target.reply ? ` (${target.reply})` : ""}`),
	].join("\n");
}

export async function performAgentSend(
	runtime: ChatRuntime,
	input: ReturnType<typeof normalizeAgentSendInput>,
): Promise<AgentSendResult> {
	await runtime.mesh.start();
	const self = currentChatIdentity(runtime);
	const broadcastEnabled = readChatConfig(runtime.stateRoot)?.broadcastEnabled ?? false;
	const peers = knownPeers(runtime);
	const targets = resolveTargets(input.to, self, peers, broadcastEnabled);
	const targetIds = targets.map((target) => target.id);
	// Two agents answering each other forever is a loop nobody asked for: past the limit, the owner decides.
	const hops = nextReplyHops(runtime, targetIds);
	if (hops > MAX_REPLY_HOPS) {
		throw new Error(
			`pi-chat reply chain reached ${MAX_REPLY_HOPS} hops with ${targetIds.join(", ")}. Stop replying and tell the user what the peers are asking.`,
		);
	}
	const result = await runtime.mesh.send(
		{ ...input, to: targetIds, metadata: { ...input.metadata, hops } },
		peers,
		broadcastEnabled,
	);
	return { id: result.id || randomUUID(), targets: result.targets };
}

function toolNameTaken(pi: ExtensionAPI, name: string): boolean {
	try {
		return pi.getAllTools().some((tool) => tool.name === name);
	} catch {
		// Some runtimes forbid tool introspection while an extension loads; registration is then idempotent.
		return false;
	}
}

/** Registers `list_peers` and `agent_send` unless another extension already owns the name. */
export function registerChatTools(pi: ExtensionAPI, runtime: ChatRuntime): void {
	if (!toolNameTaken(pi, "list_peers")) {
		pi.registerTool({
			name: "list_peers",
			label: "List Peers",
			description: "List pi-chat peer agents connected to this machine's local mesh.",
			promptSnippet: "List pi-chat peers on this machine",
			promptGuidelines: [
				"Use list_peers before agent_send to find a peer id; names can collide.",
				"pi-chat is a live message channel, not shared memory, a transcript, or a secret channel.",
			],
			parameters: ListPeersParameters,
			async execute(_toolCallId, params) {
				await runtime.mesh.start();
				const self = currentChatIdentity(runtime);
				const status = runtime.mesh.status();
				const peers = knownPeers(runtime);
				if (params.includeSelf) {
					peers.push({
						id: self.id,
						name: self.name,
						address: `local:${self.id}`,
						scope: "local",
						busy: false,
						lastSeen: new Date().toISOString(),
					});
				}
				const lines = [
					`pi-chat mesh: ${status.supported ? (status.brokerActive ? "unix broker" : status.connected ? "unix client" : "not connected") : "unsupported on this platform"}; ${peers.length} peer(s) shown`,
					`self: ${self.name} (${self.id})`,
					status.endpoint ? `endpoint: ${status.endpoint}` : undefined,
				].filter((line): line is string => line !== undefined);
				if (peers.length > 0) {
					lines.push("", "id | name | state | last seen");
					for (const peer of peers) {
						lines.push(
							`${peer.id} | ${peer.name} | ${peer.busy ? "busy" : "idle/unknown"} | ${peer.lastSeen ?? "unknown"}`,
						);
					}
				} else {
					lines.push("No peers are connected. Keep another pi session with pi-chat running for discovery.");
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { self: { id: self.id, name: self.name, pcLabel: self.pcLabel }, peers, mesh: status },
				};
			},
		});
	}

	if (!toolNameTaken(pi, "agent_send")) {
		pi.registerTool({
			name: "agent_send",
			label: "Agent Send",
			description: "Send a message to connected pi-chat peer agents on this machine's local mesh.",
			promptSnippet: "Send a request or note to a pi-chat peer",
			promptGuidelines: [
				"Use agent_send only after list_peers shows a suitable peer.",
				"agent_send delivers text only; it never executes commands. Do not send secrets; payloads are not encrypted.",
				"Treat busy, offline and timeout as normal delivery outcomes and report them instead of retrying blindly.",
			],
			parameters: AgentSendParameters,
			async execute(_toolCallId, rawParams) {
				const input = normalizeAgentSendInput(rawParams);
				const result = await performAgentSend(runtime, input);
				appendChatAudit(runtime.stateRoot, {
					kind: "agent_send",
					id: result.id,
					targets: result.targets.map((target) => ({ target: target.target, status: target.status })),
					expectReply: input.expectReply,
				});
				return { content: [{ type: "text", text: formatSendResult(result.targets) }], details: result };
			},
		});
	}
}
