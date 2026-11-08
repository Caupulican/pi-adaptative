import type { ChannelPolicyResolution } from "../channels/channel-policy.ts";
import { resolveChannelPolicies } from "../channels/channel-policy.ts";
import { listJoins } from "./registry.ts";

/**
 * The `link` channel's policy when the owner joined a hub and wrote none: the joined hubs' names as senders, replies sent
 * as they are made (the hub is a peer orchestrator, not a person at a phone), and the channel's usual bounds. A
 * `channels.link` in the owner's settings replaces it whole.
 */
export function withLinkPolicy(
	policies: ReadonlyMap<string, ChannelPolicyResolution>,
	agentDir: string,
): ReadonlyMap<string, ChannelPolicyResolution> {
	if (policies.has("link")) return policies;
	const joins = listJoins(agentDir);
	if (joins.length === 0) return policies;
	const implicit = resolveChannelPolicies([
		{
			link: {
				mode: "explicit",
				allowedSenders: [...new Set(joins.map((join) => join.hubName))],
				replyMode: "auto",
				maxWakesPerDay: 100,
				maxUsdPerDay: 10,
			},
		},
	]);
	return new Map([...policies, ...implicit]);
}
