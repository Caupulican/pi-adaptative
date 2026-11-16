/**
 * What the leader controller reads of the bots from the bot store: each bot as a leader view, whether a subscription
 * login the given bots run on has no allowance left, and whether a bot answers in a session of its own, so a goal waits
 * for its replies. Read on each call; nothing here decides.
 */

import { DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT } from "../channels/channel-policy.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { SubscriptionAllowancePort } from "../provider-admission/subscription-allowance.ts";
import type { LeaderControllerDeps } from "./leader-controller-ports.ts";
import { leaderBotViewOf } from "./leader-delegation.ts";
import type { PersistentBotRecord, PersistentBotTeamStore } from "./persistent-bot-team-store.ts";

export interface LeaderBotFactPorts {
	store(): Pick<PersistentBotTeamStore, "getBot" | "listBots">;
	registry(): Pick<ModelRegistry, "find">;
	readonly allowance: SubscriptionAllowancePort;
	/** Whether the bot answers in a session of its own (`BotSessionHost.runsAsSession`). */
	runsAsSession(record: PersistentBotRecord): boolean;
}

export function leaderBotFacts(
	ports: LeaderBotFactPorts,
): Pick<LeaderControllerDeps, "bots" | "subscriptionExhausted" | "botAnswersInSession"> {
	return {
		bots: () => ports.store().listBots({ includeRetired: true }).map(leaderBotViewOf),
		// The same reading the owner channel and the cost guard use, taken on each bot's own model.
		subscriptionExhausted: (aliases) =>
			aliases.some((alias) => {
				const bot = ports.store().getBot(alias);
				const model = bot ? ports.registry().find(bot.provider, bot.modelId) : undefined;
				return (
					model !== undefined &&
					ports.allowance.read(DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT, model).kind === "exhausted"
				);
			}),
		// A machine joined over the link takes no mail, as the bot messaging directory reads it.
		botAnswersInSession: (alias) => {
			const bot = ports.store().getBot(alias);
			return bot !== undefined && bot.remote !== true && ports.runsAsSession(bot);
		},
	};
}
