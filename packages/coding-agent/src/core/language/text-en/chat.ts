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
	/** `failed` counts the members a delivery did not reach; they are never counted as delivered. */
	sentToTeam: (teamId: string, delivered: number, failed: number) =>
		`Sent to team ${teamId} (${delivered} member deliveries${failed === 0 ? "" : `, ${failed} failed`}).`,
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
	/** A routine's progress line, part by part: a list, a status report and the routine tool's view say it the same way. */
	routineProgress: {
		position: (text: string) => `at: ${text}`,
		next: (text: string) => `next: ${text}`,
		ownerNote: (text: string) => `your note: ${text}`,
		recurringSnag: (seenCount: number, what: string, remedy: string | undefined) =>
			`keeps stumbling (${seenCount === 1 ? "once" : `${seenCount} times`}): ${what}${remedy === undefined ? "" : `; remedy tried: ${remedy}`}`,
		untrusted: "partly written by a run that read a third party's words",
	},
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
	/** A watch a routine waits on, in the owner's words; the model reads its own spelling of the same facts. */
	watch: {
		globChanged: (name: string) => `watching files matching ${name} for changes`,
		globCreated: (name: string) => `waiting for a file matching ${name} to appear`,
		globRemoved: (name: string) => `waiting for the files matching ${name} to be removed`,
		fileChanged: (name: string) => `watching ${name} for changes`,
		fileCreated: (name: string) => `waiting for ${name} to appear`,
		fileRemoved: (name: string) => `waiting for ${name} to be removed`,
		processExit: "waiting for a managed process to exit",
		pidExit: (every: string, pid: number) => `checking every ${every} for process ${pid} to exit`,
		/** `host` is absent for a port of this machine. */
		port: (port: number, host: string | undefined, every: string, opens: boolean) =>
			`checking port ${port}${host === undefined ? "" : ` on ${host}`} every ${every} for it to ${opens ? "open" : "close"}`,
		commandCheck: (every: string) => `running a command check every ${every}`,
		http: (host: string, every: string) => `checking ${host} every ${every}`,
	},
	/** The daemon's build beside the session's: what runs, and what this session runs. */
	daemonBuildRunning: (build: string | undefined) =>
		build === undefined ? "build unstamped (an earlier build)" : `build ${build}`,
	daemonBuildSession: (running: string, session: string | undefined) =>
		`${running}; this session runs ${session ?? "an unknown build"}`,
	/** The always-on service the away daemon can install, as `/bot daemon status` describes it. */
	alwaysOnMode: (autostart: string) => `routines.away.autostart is ${autostart}`,
	alwaysOnMissing: (mode: string, unavailable: string | undefined) =>
		unavailable === undefined
			? `Always-on: not installed (${mode}); \`/bot daemon service install\` installs it.`
			: `Always-on: not installed (${mode}); it cannot be installed here: ${unavailable}`,
	alwaysOnInstalled: (path: string, current: boolean, mode: string, lingerOff: boolean) =>
		`Always-on: installed at ${path}${current ? "" : " (an older definition; the next install replaces it)"} (${mode}).${lingerOff ? " Lingering is off: the service runs from login to logout." : ""}`,
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
