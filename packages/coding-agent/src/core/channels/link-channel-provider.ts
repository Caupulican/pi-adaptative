/**
 * The `link` channel: this machine's connections to the hubs it joined. A hub's message is a peer's words (the secret
 * proves which hub wrote it, not that its words are the owner's): it starts a turn under the channel's bounds, and the
 * answer goes back to that hub. The owner adds a hub with `/remote join`; nothing here names a machine or a path.
 * A conversation is keyed by the hub's install id, proven at the welcome, so two hubs that share a name (a WSL
 * instance and its Windows host) never share a conversation; the hub's name stays the sender label the policy reads.
 */

import type {
	ChannelCapabilities,
	ChannelInboundHandler,
	ChannelMessage,
	ChannelProvider,
	ChannelSenderIds,
	ChannelStatusReporter,
} from "../gateways/channel-provider.ts";
import { LinkClient, type LinkState } from "../remote/link-client.ts";
import { linkContextFor, reportJoinState } from "../remote/link-context.ts";
import { MAX_MESSAGE_CHARS } from "../remote/protocol.ts";
import { listJoins, loadIdentity, loadLinkSettings } from "../remote/registry.ts";

export const LINK_CHANNEL = "link";

export class LinkChannelProvider implements ChannelProvider {
	readonly name = LINK_CHANNEL;
	readonly capabilities: ChannelCapabilities = { maxMessageChars: MAX_MESSAGE_CHARS, markdown: true };
	readonly senderIds: ChannelSenderIds = { assignedBy: "platform" };
	private readonly agentDir: string;
	private readonly clients = new Map<string, LinkClient>();
	private readonly states = new Map<string, LinkState>();
	private report: ChannelStatusReporter | undefined;

	constructor(options: { agentDir: string }) {
		this.agentDir = options.agentDir;
	}

	start(onInbound: ChannelInboundHandler, report?: ChannelStatusReporter): void {
		this.report = report;
		const identity = loadIdentity(this.agentDir);
		const context = linkContextFor(this.agentDir);
		const joins = listJoins(this.agentDir);
		if (joins.length === 0) throw new Error("no hub is joined: use /remote join <host:port> <token>");
		for (const join of joins) {
			const client = new LinkClient({
				join,
				identity,
				subtree: context.subtree,
				depth: context.depth,
				requireSealed: () => loadLinkSettings(this.agentDir).requireSealed,
				events: {
					state: (state) => {
						this.states.set(join.address, state);
						reportJoinState(
							this.agentDir,
							join.address,
							state.state === "connected"
								? { state: "connected", hubName: state.hubName, hubId: state.hubId, features: state.features }
								: { state: state.reason, hubName: join.hubName },
						);
						this.publish();
					},
					message: (hubId, _hubName, id, text) => {
						void onInbound({
							conversationKey: `link:${hubId}`,
							text,
							eventId: id,
							sender: { id: join.hubName, label: join.hubName, verified: true },
							address: `${join.address}|${id}`,
							kind: "message",
						});
					},
				},
			});
			this.clients.set(join.address, client);
			client.start();
		}
	}

	send(message: ChannelMessage): void {
		const [address, id] = (message.address ?? "").split("|");
		const client = address === undefined ? undefined : this.clients.get(address);
		if (!client || !id) throw new Error("the answer has no hub to go to");
		if (!client.reply(id, message.text)) throw new Error("the hub is not connected");
	}

	stop(): void {
		for (const client of this.clients.values()) client.stop();
		this.clients.clear();
		this.states.clear();
	}

	/** Connected while any hub is; otherwise suspended, saying why in this provider's own words. */
	private publish(): void {
		const states = [...this.states.values()];
		if (states.some((state) => state.state === "connected")) this.report?.({ state: "connected" });
		else {
			const waiting = states.find((state) => state.state === "waiting");
			if (waiting && waiting.state === "waiting") this.report?.({ state: "suspended", reason: waiting.reason });
		}
	}
}
