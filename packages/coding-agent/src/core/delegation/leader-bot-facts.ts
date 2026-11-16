/**
 * What the leader controller reads of the bots from the bot store: each bot as a leader view, whether a subscription
 * login the given bots run on has no allowance left, whether a bot answers in a session of its own, so a goal waits
 * for its replies, and whether it still holds a goal's mail (its inbox keeps the mail, or this session's replies keep the
 * reply unread). Read on each call; nothing here decides.
 */

import { botInboxHoldsMail } from "../bots/bot-inbox.ts";
import { botMailRef } from "../bots/bot-mail.ts";
import { rootBotReplyWaiting } from "../bots/root-bot-replies.ts";
import { DEFAULT_OWNER_QUOTA_MAX_USED_PERCENT } from "../channels/channel-policy.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { SubscriptionAllowancePort } from "../provider-admission/subscription-allowance.ts";
import type { TimerSource } from "../util/timer-port.ts";
import type { LeaderControllerDeps } from "./leader-controller-ports.ts";
import { leaderBotViewOf } from "./leader-delegation.ts";
import type { PersistentBotRecord, PersistentBotTeamStore } from "./persistent-bot-team-store.ts";

/** What of the session's host the facts read: the model registry, the subscription allowance, and where replies are. */
export interface LeaderBotFactHost {
	getModelRegistry(): Pick<ModelRegistry, "find">;
	readonly subscriptionAllowance: SubscriptionAllowancePort;
	getAgentDir(): string;
	/** The session the goals' workers mail from: the replies are written for it. */
	getSessionManager(): { getSessionId(): string };
	/** Its `bot-replies` port is the clock the replies are stamped and expire on. */
	getTimers(): Pick<TimerSource, "port">;
}

export interface LeaderBotFactPorts {
	store(): Pick<PersistentBotTeamStore, "getBot" | "listBots">;
	readonly host: LeaderBotFactHost;
	/** Whether the bot answers in a session of its own (`BotSessionHost.runsAsSession`). */
	runsAsSession(record: PersistentBotRecord): boolean;
}

export function leaderBotFacts(
	ports: LeaderBotFactPorts,
): Pick<LeaderControllerDeps, "bots" | "subscriptionExhausted" | "botAnswersInSession" | "botHoldsMail"> {
	const { host } = ports;
	const replyClock = () => host.getTimers().port("bot-replies").now();
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
			return bot !== undefined && bot.remote !== true && ports.runsAsSession(bot);
		},
		// The inbox first: its record is kept until the reply is written, so a reply is read after the record it follows.
		botHoldsMail: (alias, mailId) =>
			botInboxHoldsMail(host.getAgentDir(), alias, botMailRef(mailId)) ||
			rootBotReplyWaiting(
				host.getAgentDir(),
				replyClock,
				host.getSessionManager().getSessionId(),
				`reply:${mailId}`,
			),
	};
}
