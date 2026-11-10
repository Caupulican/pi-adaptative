/**
 * The words of the conversation that is not the root chat: the title beside the target it names, the chip that switches
 * back, the status lines and hints under the input, and the header, memory line and empty-chat hint of a bot chat and a
 * team chat.
 */

import { COMMON } from "./common.ts";
import { PANES } from "./panes.ts";

export const CHAT = {
	conversation: "Conversation",
	conversationRoot: "Conversation · Brain",
	conversationOf: (badge: string) => `Conversation · ${badge}`,
	/** The root chat's badge, for a title or a chip that names it. */
	rootBadge: "Brain (root)",
	botBadge: (agentId: string, state: string) => `Bot: ${agentId} · ${state}`,
	botBadgeOnly: (agentId: string) => `Bot: ${agentId}`,
	teamBadge: (teamId: string, bots: number) => `Team: ${teamId} (${bots} bots)`,
	teamBadgeOnly: (teamId: string) => `Team: ${teamId}`,
	switchBack: "Chats · Brain ↩",
	switchCount: (count: number) => `Chats (${count})`,
	switchChip: "Chats",
	switchedToRoot: "Switched live chat to Brain (root).",
	/** What happened to the message an operator sent a bot. */
	sentRemote: (agentId: string) => `Sent to ${agentId}; its answer comes back here.`,
	sentStarted: "it started on it",
	sentFollowedUp: "added to its conversation",
	sentSteered: "sent while it works",
	sentQueued: "queued for it",
	sentToBot: (agentId: string, how: string, modelRef: string) => `Sent to ${agentId}: ${how} (${modelRef}).`,
	sentToTeam: (teamId: string, delivered: number) => `Sent to team ${teamId} (${delivered} member deliveries).`,
	/** What a bot is doing now, said in a few words from its own transcript. */
	writingAnswer: "writing its answer",
	messagesTo: (target: string) => `messages ${target}`,
	messagesPeer: "messages a peer",
	liveBotChat: (agentId: string) => `● LIVE BOT CHAT · ${agentId}`,
	remote: PANES.roster.remote,
	/** The model, the thinking level and the state, after the bot chat's name. */
	botFacts: (model: string, thinking: string, state: string) => ` · ${model} · thinking ${thinking} · ${state}`,
	unknownModel: "unknown model",
	defaultThinking: "default",
	unknownState: "unknown",
	teams: (ids: string) => `Teams: ${ids}`,
	routines: (list: string) => `Routines: ${list}`,
	/** A routine's schedule in a few words, as a chat row and a status line name it. */
	routine: {
		every: (interval: string) => `every ${interval}`,
		onceAt: (instant: string) => `once at ${instant}`,
		calendar: (cron: string, timeZone: string) => `"${cron}" in ${timeZone}`,
		branch: (name: string) => `branch ${name}`,
		ownPullRequests: "own pull requests",
		by: (authors: string) => `by ${authors}`,
		github: (kinds: string, scope: string) => `on GitHub ${kinds}${scope ? ` (${scope})` : ""}`,
		ci: (conclusions: string, workflowPath: string | undefined) =>
			`on CI ${conclusions}${workflowPath === undefined ? "" : ` of ${workflowPath}`}`,
		mainSessionOnly: "Manage a main-session routine through its owner's routine tool.",
	},
	memory: (path: string) => `Memory: ${path}`,
	resumedVia: (reference: string) => `Resumed via ${reference}`,
	directChatHint: (agentId: string) =>
		`Direct chat active: messages you submit here go directly to ${agentId} · /chat root or Alt+A to return to Brain · /bot stop ${agentId} to halt`,
	noMessagesWith: (agentId: string) =>
		`  No messages with ${agentId} yet. Type below and press Enter to message ${agentId} directly.`,
	waitingToStart: "waiting to start",
	starting: "starting",
	noMembers: COMMON.noMembers,
	teamHint: "Type to message everyone · @bot for one · /chat root returns to Brain",
	noTeamMessages: (teamId: string) =>
		`  No messages in team ${teamId} yet. Type below and press Enter to message the team.`,
};
