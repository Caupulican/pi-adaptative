/**
 * What the leader controller reads of the bots from the bot store: each bot as a leader view, whether a subscription
 * login the given bots run on has no allowance left, whether a bot answers in a session of its own, so a goal waits
 * for its replies, whether it still holds a goal's mail (its inbox keeps the mail, or this session's replies keep the
 * reply unread), and the session's record of its workers' mail (`RootBots.workerMail`). Read on each call; nothing here
 * decides.
 */

import { botInboxHoldsMail } from "../bots/bot-inbox.ts";
import { botMailRef } from "../bots/bot-mail.ts";
import type { BotSessionHost } from "../bots/bot-session-host.ts";
import type { RootBots } from "../bots/root-bots.ts";
import { DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT } from "../channels/channel-policy.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { SubscriptionAllowancePort } from "../provider-admission/subscription-allowance.ts";
import type { LeaderControllerDeps } from "./leader-controller-ports.ts";
import { leaderBotViewOf } from "./leader-delegation.ts";
import type { PersistentBotTeamStore } from "./persistent-bot-team-store.ts";

/** What of the session's host the facts read: the model registry, the subscription allowance, and where bots' inboxes are. */
export interface LeaderBotFactHost {
	getModelRegistry(): Pick<ModelRegistry, "find">;
	readonly subscriptionAllowance: SubscriptionAllowancePort;
	getAgentDir(): string;
}

export interface LeaderBotFactPorts {
	store(): Pick<PersistentBotTeamStore, "getBot" | "listBots">;
	readonly host: LeaderBotFactHost;
	/** The bot session host, which says whether a bot answers in a session of its own. */
	readonly botSessions: Pick<BotSessionHost, "runsAsSession">;
	/** The session's side of the bots: the replies its workers' mail waits for, and its record of that mail. */
	readonly rootBots: Pick<RootBots, "replies" | "workerMail">;
}

export function leaderBotFacts(
	ports: LeaderBotFactPorts,
): Pick<LeaderControllerDeps, "bots" | "subscriptionExhausted" | "botAnswersInSession" | "botHoldsMail" | "mail"> {
	const { host, rootBots } = ports;
	return {
		bots: () => ports.store().listBots({ includeRetired: true }).map(leaderBotViewOf),
		// The same reading the owner channel and the cost guard use, taken on each bot's own model.
		subscriptionExhausted: (aliases) =>
			aliases.some((alias) => {
				const bot = ports.store().getBot(alias);
				const model = bot ? host.getModelRegistry().find(bot.provider, bot.modelId) : undefined;
				return (
					model !== undefined &&
					host.subscriptionAllowance.read(DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT, model).kind === "exhausted"
				);
			}),
		// A machine joined over the link takes no mail, as the bot messaging directory reads it.
		botAnswersInSession: (alias) => {
			const bot = ports.store().getBot(alias);
			return bot !== undefined && bot.remote !== true && ports.botSessions.runsAsSession(bot);
		},
		// The inbox first: its record is kept until the reply is written, so a reply is read after the record it follows.
		botHoldsMail: (alias, mailId) =>
			botInboxHoldsMail(host.getAgentDir(), alias, botMailRef(mailId)) ||
			rootBots.replies.waiting(`reply:${mailId}`),
		mail: rootBots.workerMail,
	};
}
