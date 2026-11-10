/**
 * The badge a chat title or switch chip shows for the chat target it names: the root chat, a bot with the state it is
 * in, or a team with how many bots it holds. The words come from the catalogue at draw time.
 */

import type {
	ActiveChatTarget,
	PersistentBotView,
	PersistentTeamRecord,
} from "../../core/delegation/persistent-bot-team-store.ts";
import { interfaceText } from "../../core/language/interface-text.ts";

export function formatActiveChatTargetBadge(
	target: ActiveChatTarget,
	bots?: readonly PersistentBotView[],
	teams?: readonly PersistentTeamRecord[],
): string {
	const text = interfaceText();
	switch (target.kind) {
		case "root":
			return text.chat.rootBadge;
		case "bot": {
			const bot = bots?.find((candidate) => candidate.agentId === target.agentId);
			if (bot) {
				return text.chat.botBadge(target.agentId, text.common.botState(bot.state));
			}
			return text.chat.botBadgeOnly(target.agentId);
		}
		case "team": {
			const team = teams?.find((candidate) => candidate.teamId === target.teamId);
			if (team) {
				return text.chat.teamBadge(target.teamId, team.memberAgentIds.length);
			}
			return text.chat.teamBadgeOnly(target.teamId);
		}
		default: {
			const _exhaustive: never = target;
			return text.chat.rootBadge;
		}
	}
}
