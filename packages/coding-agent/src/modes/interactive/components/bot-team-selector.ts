import { Container, type SelectItem, SelectList, type SelectListLayoutOptions, Text } from "@caupulican/pi-tui";
import type {
	ActiveChatTarget,
	PersistentBotView,
	PersistentTeamRecord,
} from "../../../core/delegation/persistent-bot-team-store.ts";
import { getSelectListTheme, theme } from "../../../presentation/theme-model.ts";
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
	switch (target.kind) {
		case "root":
			return "Brain (root)";
		case "bot":
			return `Bot: ${target.agentId}`;
		case "team":
			return `Team: ${target.teamId}`;
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

function botStatusGlyph(state: PersistentBotView["state"]): string {
	switch (state) {
		case "running":
		case "queued":
			return "●";
		case "awaiting_parent":
			return "◐";
		case "failed":
			return "✗";
		case "idle":
		case "retired":
			return "○";
		default: {
			const _exhaustive: never = state;
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
		const subtitleText = `Active: ${formatActiveTargetLabel(options.activeTarget)}  ·  /bot new <id> [--write] [model] [role] · /team create <id> <bot1,bot2> · @<bot> <msg> · Esc close`;

		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.fg("accent", theme.bold("Live Chats · Bots & Teams")), 1, 0));
		this.addChild(new Text(theme.fg("muted", subtitleText), 1, 0));

		const isRootCurrent = options.activeTarget.kind === "root";
		const items: SelectItem[] = [
			{
				value: "root",
				label: `${isRootCurrent ? "✓" : "●"} Brain (root)`,
				description: `${options.rootModelLabel} · ${options.rootStatusLabel} · Primary orchestrator chat`,
			},
			...options.teams.map((team): SelectItem => {
				const isCurrent = options.activeTarget.kind === "team" && options.activeTarget.teamId === team.teamId;
				return {
					value: `team:${team.teamId}`,
					label: `${isCurrent ? "✓ " : "◆ "}Team: ${team.name || team.teamId}`,
					description: `[${team.memberAgentIds.join(", ") || "no members"}]${team.description ? ` · ${team.description}` : ""}`,
				};
			}),
			...options.bots.map((bot): SelectItem => {
				const isCurrent = options.activeTarget.kind === "bot" && options.activeTarget.agentId === bot.agentId;
				const glyph = botStatusGlyph(bot.state);
				const summaryOrDesc = bot.currentSummary
					? ` · ${bot.currentSummary}`
					: bot.description
						? ` · ${bot.description}`
						: "";
				return {
					value: `bot:${bot.agentId}`,
					label: `${isCurrent ? "✓ " : `${glyph} `}Bot: ${bot.agentId}`,
					description: `${bot.modelRef}${bot.thinkingLevel ? ` (${bot.thinkingLevel})` : ""} · ${bot.state}${bot.teamIds.length ? ` · teams: ${bot.teamIds.join(",")}` : ""}${summaryOrDesc}`,
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
