import { Container, type SelectItem, SelectList, type SelectListLayoutOptions, Text } from "@caupulican/pi-tui";
import type {
	ActiveChatTarget,
	PersistentBotView,
	PersistentTeamRecord,
} from "../../../core/delegation/persistent-bot-team-store.ts";
import { interfaceText } from "../../../core/language/interface-text.ts";
import { getSelectListTheme, theme } from "../../../presentation/theme-model.ts";
import { botStateMark } from "./bot-state-mark.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const BOT_TEAM_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 16,
	maxPrimaryColumnWidth: 36,
};

export interface BotTeamSelectorOptions {
	readonly activeTarget: ActiveChatTarget;
	readonly rootModelLabel: string;
	readonly rootStatusLabel: string;
	readonly bots: readonly PersistentBotView[];
	readonly teams: readonly PersistentTeamRecord[];
	readonly onSelectTarget: (target: ActiveChatTarget) => void;
	readonly onCancel: () => void;
}

function formatActiveTargetLabel(target: ActiveChatTarget): string {
	const text = interfaceText().selectors.botTeam;
	switch (target.kind) {
		case "root":
			return text.activeRoot;
		case "bot":
			return text.activeBot(target.agentId);
		case "team":
			return text.activeTeam(target.teamId);
		default: {
			const _exhaustive: never = target;
			return _exhaustive;
		}
	}
}

function formatActiveTargetValue(target: ActiveChatTarget): string {
	switch (target.kind) {
		case "root":
			return "root";
		case "bot":
			return `bot:${target.agentId}`;
		case "team":
			return `team:${target.teamId}`;
		default: {
			const _exhaustive: never = target;
			return _exhaustive;
		}
	}
}

function parseTargetValue(value: string): ActiveChatTarget | undefined {
	if (value === "root") {
		return { kind: "root" };
	}
	if (value.startsWith("bot:")) {
		const agentId = value.slice("bot:".length).trim();
		return agentId.length > 0 ? { kind: "bot", agentId } : undefined;
	}
	if (value.startsWith("team:")) {
		const teamId = value.slice("team:".length).trim();
		return teamId.length > 0 ? { kind: "team", teamId } : undefined;
	}
	return undefined;
}

export class BotTeamSelectorComponent extends Container {
	private readonly selectList: SelectList;

	constructor(options: BotTeamSelectorOptions) {
		super();

		const activeValue = formatActiveTargetValue(options.activeTarget);
		const text = interfaceText().selectors.botTeam;
		const subtitleText = text.subtitle(formatActiveTargetLabel(options.activeTarget));

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold(text.title)), 1, 0));
		this.addChild(new Text(theme.fg("muted", subtitleText), 1, 0));

		const isRootCurrent = options.activeTarget.kind === "root";
		const items: SelectItem[] = [
			{
				value: "root",
				label: text.rootItem(isRootCurrent ? "✓" : "●"),
				description: text.rootDescription(options.rootModelLabel, options.rootStatusLabel),
			},
			...options.teams.map((team): SelectItem => {
				const isCurrent = options.activeTarget.kind === "team" && options.activeTarget.teamId === team.teamId;
				const unread = (team.unreadCount ?? 0) > 0 ? text.unread(team.unreadCount ?? 0) : "";
				const members = team.memberAgentIds.length > 0 ? text.memberList(team.memberAgentIds) : text.noMembers;
				return {
					value: `team:${team.teamId}`,
					label: text.teamItem(isCurrent ? "✓ " : "◆ ", team.name || team.teamId),
					description: text.teamDescription(
						members,
						unread,
						team.description ? text.descriptionSuffix(team.description) : "",
					),
				};
			}),
			...options.bots.map((bot): SelectItem => {
				const isCurrent = options.activeTarget.kind === "bot" && options.activeTarget.agentId === bot.agentId;
				// Plain: the list colours a selected row whole, and a toned glyph would cut that colour.
				const glyph = botStateMark(bot.state).glyph;
				const unread = (bot.unreadCount ?? 0) > 0 ? text.unread(bot.unreadCount ?? 0) : "";
				const schedules = (bot.routineCount ?? 0) > 0 ? ` · ⏱${bot.routineCount}` : "";
				const summaryOrDesc = bot.currentSummary
					? text.descriptionSuffix(bot.currentSummary)
					: bot.description
						? text.descriptionSuffix(bot.description)
						: "";
				return {
					value: `bot:${bot.agentId}`,
					label: text.botItem(isCurrent ? "✓ " : `${glyph} `, bot.agentId),
					description: `${bot.modelRef}${bot.thinkingLevel ? ` (${bot.thinkingLevel})` : ""} · ${text.state(bot.state)}${unread}${schedules}${bot.teamIds.length ? text.botTeams(bot.teamIds.join(",")) : ""}${summaryOrDesc}`,
				};
			}),
		];

		this.selectList = new SelectList(items, 12, getSelectListTheme(), BOT_TEAM_SELECT_LIST_LAYOUT);
		const selectedIndex = items.findIndex((item) => item.value === activeValue);
		if (selectedIndex >= 0) {
			this.selectList.setSelectedIndex(selectedIndex);
		} else if (items.length > 0) {
			this.selectList.setSelectedIndex(0);
		}

		this.selectList.onSelect = (item) => {
			if (!item.value) return;
			const target = parseTargetValue(item.value);
			if (!target) return;
			options.onSelectTarget(target);
		};
		this.selectList.onCancel = options.onCancel;

		this.addChild(this.selectList);
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
