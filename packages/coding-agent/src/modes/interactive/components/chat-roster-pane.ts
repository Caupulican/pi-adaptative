/**
 * The Chats & Teams roster pane: the root chat, the teams and the bots, each row naming the chat target it selects,
 * with the pane title, its meta line and the buttons that step beside it. Rows are drawn at the graph pane's origin,
 * so hit-testing the pane finds the same rows.
 */

import type { ManagedLaneView } from "../../../core/delegation/managed-lane-views.ts";
import type {
	ActiveChatTarget,
	PersistentBotView,
	PersistentTeamRecord,
} from "../../../core/delegation/persistent-bot-team-store.ts";
import { interfaceText } from "../../../core/language/interface-text.ts";
import type { WorkbenchGraphView } from "../../../core/settings/settings-schema.ts";
import { theme } from "../../../presentation/theme-model.ts";
import { botStateGlyph, REMOTE_MARK } from "./bot-state-mark.ts";
import type { WorkbenchPane, WorkbenchPaneTitleButton } from "./workbench-pane.ts";

/** The live facts behind the Chats & Teams roster: the active target, the Brain's state, every bot and team. */
export interface WorkbenchChatRosterSnapshot {
	readonly activeTarget: ActiveChatTarget;
	readonly rootModelLabel: string;
	readonly rootRunning: boolean;
	readonly bots: readonly PersistentBotView[];
	/** Live managed lanes: listed read-only, never a chat target. */
	readonly lanes: readonly ManagedLaneView[];
	readonly teams: readonly PersistentTeamRecord[];
}

/**
 * The roster's bot order: each bot a listed leader owns follows that leader, marked owned; every other bot keeps its
 * place. A bot whose leader is not listed stands on its own.
 */
function rosterBotOrder(
	bots: readonly PersistentBotView[],
): { readonly bot: PersistentBotView; readonly owned: boolean }[] {
	const leaders = new Set(bots.filter((bot) => bot.leader === true).map((bot) => bot.agentId));
	const isOwned = (bot: PersistentBotView) =>
		bot.createdBy !== undefined && bot.createdBy !== bot.agentId && leaders.has(bot.createdBy);
	const order: { bot: PersistentBotView; owned: boolean }[] = [];
	for (const bot of bots) {
		if (isOwned(bot)) continue;
		order.push({ bot, owned: false });
		if (bot.leader === true)
			for (const child of bots)
				if (isOwned(child) && child.createdBy === bot.agentId) order.push({ bot: child, owned: true });
	}
	return order;
}

/** What the roster pane draws: its rows, each with the chat target its click selects. */
export interface ChatRosterPaneDrawing {
	readonly lines: string[];
	readonly targets: (ActiveChatTarget | undefined)[];
}

export interface ChatRosterPaneInput {
	readonly pane: WorkbenchPane;
	readonly roster: WorkbenchChatRosterSnapshot;
	readonly originX: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
	/** Whether the chip that opens the graph fits beside the roster at the left pane's width. */
	readonly graphReachable: boolean;
	readonly graphView: WorkbenchGraphView;
	readonly mouseMode: boolean;
}

/** The roster: the root chat, the teams, then the bots. */
export function drawChatRosterPane(input: ChatRosterPaneInput): ChatRosterPaneDrawing {
	const { pane, roster, originX, top, width, height, graphReachable, graphView, mouseMode } = input;
	const text = interfaceText();
	const active = roster.activeTarget;
	const rows: string[] = [];
	const targets: (ActiveChatTarget | undefined)[] = [];
	const add = (row: string, target?: ActiveChatTarget): void => {
		rows.push(row);
		targets.push(target);
	};
	const isRoot = active.kind === "root";
	// The roster is the directory of chats: the root chat is the first of them, by name only. Its model and state are the
	// Orchestration panel's business, so they are not repeated here.
	const root = text.panes.roster.root;
	add(
		`${isRoot ? theme.fg("accent", "▸ ") : "  "}${roster.rootRunning ? theme.fg("accent", "●") : theme.fg("success", "●")} ${isRoot ? theme.bold(theme.fg("accent", root)) : theme.fg("text", root)}`,
		{ kind: "root" },
	);
	// An empty group is its header with the way to fill it, not a header and a row saying it is empty.
	add(theme.fg("muted", text.panes.roster.teams(roster.teams.length)));
	for (const team of roster.teams) {
		const isSelected = active.kind === "team" && active.teamId === team.teamId;
		const target: ActiveChatTarget = { kind: "team", teamId: team.teamId };
		const name = team.name || team.teamId;
		const unreadBadge = (team.unreadCount ?? 0) > 0 ? ` ${theme.fg("warning", `●${team.unreadCount}`)}` : "";
		add(
			`${isSelected ? theme.fg("accent", "▸ ") : "  "}${theme.fg("accent", "◆")} ${isSelected ? theme.bold(theme.fg("accent", name)) : theme.fg("text", name)} ${theme.fg("muted", `[${team.memberAgentIds.length}]`)}${unreadBadge}`,
			target,
		);
		const detail = team.description || team.memberAgentIds.join(", ") || text.common.noMembers;
		add(`    ${theme.fg("muted", detail)}`, target);
	}
	add(theme.fg("muted", text.panes.roster.bots(roster.bots.length)));
	for (const { bot, owned } of rosterBotOrder(roster.bots)) {
		const isSelected = active.kind === "bot" && active.agentId === bot.agentId;
		// A bot a leader owns sits under that leader; its detail line keeps the same indent.
		const pad = owned ? `  ${theme.fg("dim", "└")} ` : "";
		const detailPad = owned ? "      " : "    ";
		const target: ActiveChatTarget = { kind: "bot", agentId: bot.agentId };
		const name = bot.displayName || bot.agentId;
		const glyph = botStateGlyph(bot.state);
		const unreadBadge = (bot.unreadCount ?? 0) > 0 ? ` ${theme.fg("warning", `●${bot.unreadCount}`)}` : "";
		const scheduleBadge = (bot.routineCount ?? 0) > 0 ? ` ${theme.fg("accent", `⏱${bot.routineCount}`)}` : "";
		// Watches are passive state, drawn quiet with the operator bar's dotted ring.
		const watchBadge = (bot.watchCount ?? 0) > 0 ? ` ${theme.fg("muted", `◌${bot.watchCount}`)}` : "";
		const leaderBadge = `${bot.leader ? ` ${theme.fg("warning", text.panes.roster.leader)}` : ""}${bot.remote ? ` ${theme.fg("accent", `${REMOTE_MARK} ${text.panes.roster.remote}`)}` : ""}`;
		add(
			`${isSelected ? theme.fg("accent", "▸ ") : "  "}${pad}${glyph} ${isSelected ? theme.bold(theme.fg("accent", name)) : theme.fg("text", name)}${leaderBadge}${unreadBadge}${scheduleBadge}${watchBadge}`,
			target,
		);
		// The row is the bot's name. Its model is a hint on the line below, shown only for the selected bot; the idle state is
		// the glyph's business, so only a difference earns a word.
		const detail = [
			isSelected ? `@${bot.agentId}` : undefined,
			isSelected && !bot.remote ? bot.modelId || bot.modelRef : undefined,
			bot.state === "idle" ? undefined : text.common.botState(bot.state),
			bot.teamIds.length > 0 ? `[${bot.teamIds.join(",")}]` : undefined,
			bot.currentSummary,
		]
			.filter(Boolean)
			.join(" · ");
		if (detail) add(`${detailPad}${theme.fg("muted", detail)}`, target);
	}
	if (roster.lanes.length > 0) {
		const running = roster.lanes.filter((lane) => lane.state === "running").length;
		const waiting = roster.lanes.filter((lane) => lane.state === "queued").length;
		add(theme.fg("muted", text.panes.roster.workers(running, waiting, roster.lanes.length)));
		for (const lane of roster.lanes) {
			add(
				`  ${botStateGlyph(lane.state)} ${theme.fg("text", lane.label)}${lane.modelRef ? ` ${theme.fg("muted", lane.modelRef)}` : ""}`,
			);
		}
	}
	add(`  ${theme.fg("dim", text.panes.roster.hint)}`);
	const meta = text.panes.roster.meta(roster.bots.length, roster.teams.length);
	const actions: WorkbenchPaneTitleButton[] = [
		{ action: "hideLeftPane", label: "▾", leading: true },
		...(graphReachable
			? [
					{
						action: "toggleLeftPaneMode" as const,
						label: text.panes.graphChip(text.panes.graphView(graphView)),
						raised: true,
					},
				]
			: []),
		{ action: "switchChat", label: text.panes.modal, raised: true },
	];
	return {
		lines: pane.render(text.panes.chats, meta, rows, originX, top, width, height, false, actions, mouseMode),
		targets,
	};
}
