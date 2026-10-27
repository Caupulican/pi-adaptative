import { type Container, Spacer, Text, type TUI } from "@caupulican/pi-tui";
import {
	type ActiveChatTarget,
	type BotOperatorMessageDispatchResult,
	type BotTeamChange,
	formatActiveChatTargetBadge,
	normalizeBotOrTeamId,
	type PersistentBotRecord,
	type PersistentBotView,
	type PersistentTeamRecord,
	parseDirectChatAddress,
	type TeamOperatorMessageDispatchResult,
	type UpsertPersistentBotInput,
	type UpsertPersistentTeamInput,
} from "../../core/delegation/persistent-bot-team-store.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { isModelReference } from "../../core/model-resolver.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { theme } from "../../presentation/theme-model.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";

export interface BotTeamChatSessionPort {
	listPersistentBots(): PersistentBotView[];
	listPersistentTeams(): PersistentTeamRecord[];
	getPersistentTeam(teamId: string): PersistentTeamRecord | undefined;
	upsertPersistentBot(input: UpsertPersistentBotInput): PersistentBotRecord;
	retirePersistentBot(agentId: string): { retired: boolean; detail: string };
	stopPersistentBot(agentId: string): { stopped: boolean; detail: string };
	upsertPersistentTeam(input: UpsertPersistentTeamInput): PersistentTeamRecord;
	setPersistentTeamMembers(teamId: string, memberAgentIds: readonly string[]): PersistentTeamRecord;
	deletePersistentTeam(teamId: string): boolean;
	sendOperatorMessageToBot(
		agentId: string,
		message: string,
		options?: { mode?: "follow_up" | "queue" | "start" },
	): Promise<BotOperatorMessageDispatchResult>;
	sendOperatorMessageToTeam(teamId: string, message: string): Promise<TeamOperatorMessageDispatchResult>;
	readBotChatMessages(agentId: string): AgentMessage[];
	readTeamChatMessages(teamId: string): AgentMessage[];
	subscribeBotTeamUpdates(listener: (change: BotTeamChange) => void): () => void;
	resolveModelSpec(rawModel?: string): { provider: string; modelId: string; thinkingLevel?: string };
	readonly modelRegistry: Pick<ModelRegistry, "getAll">;
	getRootModelLabel(): string;
	getRootStatusLabel(): string;
}

export interface BotTeamChatHost {
	readonly chatContainer: Container;
	readonly ui: TUI;
	getSessionPort(): BotTeamChatSessionPort;
	renderRootConversation(): Promise<void>;
	appendRenderedMessageToChat(message: AgentMessage): void;
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
	openSelectorModal(): void;
	onActiveTargetChanged?(target: ActiveChatTarget): void;
}

const ROOT_TARGET: ActiveChatTarget = { kind: "root" };

/** Split off the first whitespace-delimited token; the remainder keeps its interior spacing. */
function splitHead(text: string): [string, string] {
	const trimmed = text.trimStart();
	const index = trimmed.search(/\s/);
	if (index === -1) {
		return [trimmed, ""];
	}
	return [trimmed.slice(0, index), trimmed.slice(index).trimStart()];
}

/** Split a comma-separated id list, dropping blanks and normalizing each id. */
function parseIdList(raw: string): string[] {
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.map((part) => normalizeBotOrTeamId(part, "agentId"));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * What a rendered chat shows: its header facts plus the message count and the last message's time. A transcript only
 * grows, so these change whenever a message is added; hashing every message on each event would cost more than it saves.
 */
function chatSignature(header: object, messages: readonly AgentMessage[]): string {
	return JSON.stringify({ header, count: messages.length, last: messages.at(-1)?.timestamp ?? null });
}

export class BotTeamChatController {
	private activeTarget: ActiveChatTarget = { kind: "root" };
	private unsubscribeUpdates?: () => void;
	private refreshQueued = false;
	private readonly host: BotTeamChatHost;
	/** What the chat container shows for the open bot or team chat. An unchanged one skips the rebuild. */
	private lastRenderedChatSignature: string | undefined;

	constructor(host: BotTeamChatHost) {
		this.host = host;
	}

	/** Subscribe to bot and team updates. Re-binding replaces the previous subscription. */
	bindSession(): void {
		this.lastRenderedChatSignature = undefined;
		this.unsubscribeUpdates?.();
		this.unsubscribeUpdates = this.host.getSessionPort().subscribeBotTeamUpdates((change) => {
			if (!this.isRootChatActive()) {
				if (this.changeTouchesActiveChat(change)) this.scheduleRefresh();
			} else {
				this.host.ui.requestRender();
			}
		});
	}

	/** Whether `change` can alter what the open bot or team chat shows: a store change, its bot, or a member of its team. */
	private changeTouchesActiveChat(change: BotTeamChange): boolean {
		if (change === "all") return true;
		const target = this.activeTarget;
		if (target.kind === "bot") return change.includes(target.agentId);
		if (target.kind !== "team") return false;
		const members = this.host.getSessionPort().getPersistentTeam(target.teamId)?.memberAgentIds ?? [];
		return change.some((agentId) => members.includes(agentId));
	}

	dispose(): void {
		this.unsubscribeUpdates?.();
		this.unsubscribeUpdates = undefined;
		this.refreshQueued = false;
		this.lastRenderedChatSignature = undefined;
	}

	getActiveTarget(): ActiveChatTarget {
		return this.activeTarget;
	}

	isRootChatActive(): boolean {
		return this.activeTarget.kind === "root";
	}

	getActiveTargetBadge(): string {
		const port = this.host.getSessionPort();
		return formatActiveChatTargetBadge(this.activeTarget, port.listPersistentBots(), port.listPersistentTeams());
	}

	getConversationTitleLabel(): string {
		const target = this.activeTarget;
		switch (target.kind) {
			case "root": {
				const port = this.host.getSessionPort();
				const hasPeers = port.listPersistentBots().length > 0 || port.listPersistentTeams().length > 0;
				return hasPeers ? "Conversation · Brain" : "Conversation";
			}
			case "bot":
				return `Conversation · ${this.getActiveTargetBadge()}`;
			case "team":
				return `Conversation · ${this.getActiveTargetBadge()}`;
			default: {
				const _exhaustive: never = target;
				return "Conversation";
			}
		}
	}

	getSwitchChipLabel(): string | undefined {
		const port = this.host.getSessionPort();
		const bots = port.listPersistentBots();
		const teams = port.listPersistentTeams();
		if (!this.isRootChatActive()) {
			return "Chats · Brain ↩";
		}
		if (bots.length > 0 || teams.length > 0) {
			return `Chats (${bots.length + teams.length})`;
		}
		return "Chats";
	}

	async switchTarget(target: ActiveChatTarget): Promise<void> {
		this.activeTarget = target;
		this.lastRenderedChatSignature = undefined;
		this.host.onActiveTargetChanged?.(target);
		await this.refreshActiveChatView();
	}

	async refreshActiveChatView(): Promise<void> {
		const target = this.activeTarget;
		switch (target.kind) {
			case "root":
				this.lastRenderedChatSignature = undefined;
				await this.host.renderRootConversation();
				return;
			case "bot":
				this.renderBotChat(target.agentId);
				return;
			case "team":
				this.renderTeamChat(target.teamId);
				return;
			default: {
				const _exhaustive: never = target;
				return;
			}
		}
	}

	/**
	 * Route a submitted prompt. Returns true when the controller consumed it. Returns false when the
	 * caller should submit normally; for an `@root` address the caller submits `stripLeadingRootAddress(rawText)`.
	 */
	async tryInterceptSubmission(rawText: string): Promise<boolean> {
		const port = this.host.getSessionPort();
		const knownBotIds = new Set(port.listPersistentBots().map((b) => b.agentId));
		const knownTeamIds = new Set(port.listPersistentTeams().map((t) => t.teamId));
		const addressed = parseDirectChatAddress(rawText, knownBotIds, knownTeamIds);

		if (addressed) {
			const target = addressed.target;
			switch (target.kind) {
				case "root":
					if (!this.isRootChatActive()) {
						await this.switchTarget(ROOT_TARGET);
						this.host.showStatus("Switched live chat to Brain (root).");
					}
					return false;
				case "bot":
					return this.dispatchToBot(target.agentId, addressed.body);
				case "team":
					return this.dispatchToTeam(target.teamId, addressed.body);
				default: {
					const _exhaustive: never = target;
					return false;
				}
			}
		}

		const active = this.activeTarget;
		switch (active.kind) {
			case "root":
				return false;
			case "bot":
				return this.dispatchToBot(active.agentId, rawText, { refreshOnly: true });
			case "team":
				return this.dispatchToTeam(active.teamId, rawText, { refreshOnly: true });
			default: {
				const _exhaustive: never = active;
				return false;
			}
		}
	}

	/** Remove a leading `@root` or `@brain` address so the remaining text submits to root. */
	stripLeadingRootAddress(rawText: string): string {
		const match = rawText.trimStart().match(/^@(?:root|brain)\s+([\s\S]+)$/);
		return match?.[1]?.trim() ?? rawText;
	}

	async handleChatCommand(rawText: string): Promise<void> {
		const [, rest] = splitHead(rawText);
		const [arg] = splitHead(rest);
		const port = this.host.getSessionPort();

		if (arg.length === 0) {
			this.host.openSelectorModal();
			return;
		}
		if (arg === "root" || arg === "brain") {
			await this.switchTarget(ROOT_TARGET);
			return;
		}
		if (arg.startsWith("team:")) {
			await this.openTeam(arg.slice(5), port);
			return;
		}
		if (!arg.startsWith("bot:") && port.getPersistentTeam(arg)) {
			await this.openTeam(arg, port);
			return;
		}
		const botId = arg.startsWith("bot:") ? arg.slice(4) : arg;
		await this.openBot(botId, port);
	}

	async handleBotCommand(rawText: string): Promise<void> {
		const port = this.host.getSessionPort();
		const [, afterCommand] = splitHead(rawText);
		const [sub, rest] = splitHead(afterCommand);

		try {
			switch (sub) {
				case "":
					this.host.openSelectorModal();
					return;
				case "list":
					this.host.showStatus(this.formatBotList(port.listPersistentBots()));
					return;
				case "new":
				case "create":
				case "spawn":
					await this.createBot(rest, port);
					return;
				case "open":
				case "chat": {
					const [id] = splitHead(rest);
					await this.openBot(id, port);
					return;
				}
				case "msg":
				case "send":
					await this.sendToBotFromCommand(rest, port, undefined);
					return;
				case "steer":
					await this.sendToBotFromCommand(rest, port, "follow_up");
					return;
				case "queue":
					await this.sendToBotFromCommand(rest, port, "queue");
					return;
				case "stop": {
					const [id] = splitHead(rest);
					const normId = normalizeBotOrTeamId(id, "agentId");
					const result = port.stopPersistentBot(normId);
					if (result.stopped) {
						this.host.showStatus(result.detail);
					} else {
						this.host.showWarning(result.detail);
					}
					if (!this.isRootChatActive()) {
						await this.refreshActiveChatView();
					}
					return;
				}
				case "retire": {
					const [id] = splitHead(rest);
					const normId = normalizeBotOrTeamId(id, "agentId");
					const result = port.retirePersistentBot(normId);
					if (result.retired) {
						this.host.showStatus(result.detail);
						if (this.activeTarget.kind === "bot" && this.activeTarget.agentId === normId) {
							await this.switchTarget(ROOT_TARGET);
						} else if (!this.isRootChatActive()) {
							await this.refreshActiveChatView();
						}
					} else {
						this.host.showWarning(result.detail);
					}
					return;
				}
				default:
					this.host.showWarning(
						"Usage: /bot [list] | /bot new <id> [--write] [model] [instructions...] | /bot open <id> | /bot msg|send|steer|queue <id> <text...> | /bot stop <id> | /bot retire <id>",
					);
			}
		} catch (error) {
			this.host.showError(errorMessage(error));
		}
	}

	async handleTeamCommand(rawText: string): Promise<void> {
		const port = this.host.getSessionPort();
		const [, afterCommand] = splitHead(rawText);
		const [sub, rest] = splitHead(afterCommand);

		try {
			switch (sub) {
				case "":
					if (port.listPersistentTeams().length > 0 || port.listPersistentBots().length > 0) {
						this.host.openSelectorModal();
					} else {
						this.host.showStatus(this.formatTeamList(port));
					}
					return;
				case "list":
					this.host.showStatus(this.formatTeamList(port));
					return;
				case "create":
				case "new":
					await this.createTeam(rest, port);
					return;
				case "members":
					await this.setTeamMembersFromCommand(rest, port);
					return;
				case "open":
				case "chat": {
					const [id] = splitHead(rest);
					await this.openTeam(id, port);
					return;
				}
				case "msg":
				case "send":
				case "broadcast": {
					const [id, body] = splitHead(rest);
					const teamId = normalizeBotOrTeamId(id, "teamId");
					if (body.length === 0) {
						this.host.showWarning("Usage: /team msg <teamId> <text...>");
						return;
					}
					await this.dispatchToTeam(teamId, body);
					return;
				}
				case "delete":
				case "rm": {
					const [id] = splitHead(rest);
					const teamId = normalizeBotOrTeamId(id, "teamId");
					if (port.deletePersistentTeam(teamId)) {
						this.host.showStatus(`Deleted team ${teamId}.`);
						if (this.activeTarget.kind === "team" && this.activeTarget.teamId === teamId) {
							await this.switchTarget(ROOT_TARGET);
						}
					} else {
						this.host.showWarning(`Team not found: ${teamId}.`);
					}
					return;
				}
				default:
					this.host.showWarning(
						"Usage: /team [list] | /team create <teamId> <bot1,bot2,...> [description...] | /team members <teamId> <bot1,bot2,...> | /team open <teamId> | /team msg <teamId> <text...> | /team delete <teamId>",
					);
			}
		} catch (error) {
			this.host.showError(errorMessage(error));
		}
	}

	private scheduleRefresh(): void {
		if (this.refreshQueued) {
			return;
		}
		this.refreshQueued = true;
		queueMicrotask(() => {
			this.refreshQueued = false;
			this.refreshActiveChatView().catch((error: unknown) => {
				this.host.showError(errorMessage(error));
			});
		});
	}

	private renderBotChat(agentId: string): void {
		const port = this.host.getSessionPort();
		const bot = port.listPersistentBots().find((b) => b.agentId === agentId);
		const messages = port.readBotChatMessages(agentId);
		if (!this.beginChatRender(chatSignature({ kind: "bot", agentId, bot: bot ?? null }, messages))) return;

		const modelLabel = bot?.modelRef ?? "unknown model";
		const thinking = bot?.thinkingLevel ?? "default";
		const state = bot?.state ?? "unknown";
		const teams = bot && bot.teamIds.length > 0 ? `Teams: ${bot.teamIds.join(", ")}` : undefined;
		const detail = [bot?.description, bot?.currentSummary].filter((part): part is string => !!part).join(" · ");

		const lines = [
			theme.fg("accent", theme.bold(`● LIVE BOT CHAT · ${agentId}`)) +
				theme.fg("muted", ` · ${modelLabel} · thinking ${thinking} · ${state}`),
		];
		const secondLine = [teams, detail].filter((part): part is string => !!part).join("  ");
		if (secondLine.length > 0) {
			lines.push(theme.fg("text", secondLine));
		}
		const memoryPath = bot?.memoryFilePath ?? `~/.pi/agent/memory/bots/${agentId}.md`;
		const continuity = bot?.lastTranscriptRef ? `Resumed via ${bot.lastTranscriptRef.slice(0, 22)}…` : undefined;
		const memoryParts = [`Memory: ${memoryPath}`, continuity].filter((part): part is string => Boolean(part));
		lines.push(theme.fg("muted", memoryParts.join(" · ")));
		lines.push(
			theme.fg(
				"muted",
				`Direct chat active: messages you submit here go directly to ${agentId} · /chat root or Alt+A to return to Brain · /bot stop ${agentId} to halt`,
			),
		);
		this.finishChatRender(
			lines,
			messages,
			`  No messages with ${agentId} yet. Type below and press Enter to message ${agentId} directly.`,
		);
	}

	/** Starts rebuilding the chat container for `signature`. False when it already shows exactly that. */
	private beginChatRender(signature: string): boolean {
		if (signature === this.lastRenderedChatSignature) {
			this.host.ui.requestRender();
			return false;
		}
		this.lastRenderedChatSignature = signature;
		this.host.chatContainer.clear();
		this.host.chatContainer.addChild(new DynamicBorder());
		return true;
	}

	/** Adds the header lines and the messages, or the empty-chat hint, to the chat `beginChatRender` opened. */
	private finishChatRender(header: readonly string[], messages: readonly AgentMessage[], emptyHint: string): void {
		const chat = this.host.chatContainer;
		chat.addChild(new Text(header.join("\n"), 1, 0));
		chat.addChild(new DynamicBorder());
		chat.addChild(new Spacer(1));
		if (messages.length === 0) {
			chat.addChild(new Text(theme.fg("muted", emptyHint), 1, 0));
		} else {
			for (const message of messages) this.host.appendRenderedMessageToChat(message);
		}
		this.host.ui.requestRender();
	}

	private renderTeamChat(teamId: string): void {
		const port = this.host.getSessionPort();
		const team = port.getPersistentTeam(teamId);
		const members = team?.memberAgentIds ?? [];
		const liveBots = port.listPersistentBots();
		const memberStatus = members
			.map((memberId) => {
				const bot = liveBots.find((b) => b.agentId === memberId);
				return `${memberId} (${bot?.state ?? "unknown"})`;
			})
			.join(" · ");
		const messages = port.readTeamChatMessages(teamId);
		if (!this.beginChatRender(chatSignature({ kind: "team", teamId, team: team ?? null, memberStatus }, messages)))
			return;

		const memoryPath = team?.memoryFilePath ?? `~/.pi/agent/memory/teams/${teamId}.md`;
		const lines = [
			theme.fg("accent", theme.bold(`◆ LIVE TEAM CHAT · ${team?.name ?? teamId}`)) +
				theme.fg("muted", ` [${members.join(", ")}]`),
			theme.fg("text", memberStatus.length > 0 ? memberStatus : "No members"),
			theme.fg("muted", `Memory: ${memoryPath}`),
			theme.fg(
				"muted",
				"Direct team chat active: messages you submit here dispatch to all team members (or prefix @<botId> for one member) · /chat root or Alt+A to return to Brain",
			),
		];
		this.finishChatRender(
			lines,
			messages,
			`  No messages in team ${teamId} yet. Type below and press Enter to message the team.`,
		);
	}

	/**
	 * Send a prompt to one bot. With `refreshOnly`, the prompt came from an open bot chat, so the view
	 * refreshes instead of posting a status line.
	 */
	private async dispatchToBot(
		agentId: string,
		body: string,
		options: { refreshOnly?: boolean } = {},
	): Promise<boolean> {
		try {
			const result = await this.host.getSessionPort().sendOperatorMessageToBot(agentId, body);
			if (options.refreshOnly || !this.isRootChatActive()) {
				await this.refreshActiveChatView();
			}
			if (!options.refreshOnly) {
				this.host.showStatus(`Sent to ${agentId} (${result.mode}, ${result.modelRef}).`);
			}
		} catch (error) {
			this.host.showError(errorMessage(error));
		}
		return true;
	}

	private async dispatchToTeam(
		teamId: string,
		body: string,
		options: { refreshOnly?: boolean } = {},
	): Promise<boolean> {
		try {
			const result = await this.host.getSessionPort().sendOperatorMessageToTeam(teamId, body);
			const delivered = result.deliveries.length;
			if (options.refreshOnly || !this.isRootChatActive()) {
				await this.refreshActiveChatView();
			}
			if (!options.refreshOnly) {
				this.host.showStatus(`Sent to team ${teamId} (${delivered} member deliveries).`);
			}
		} catch (error) {
			this.host.showError(errorMessage(error));
		}
		return true;
	}

	private async openBot(rawId: string, port: BotTeamChatSessionPort): Promise<void> {
		const agentId = normalizeBotOrTeamId(rawId, "agentId");
		const known = port.listPersistentBots().some((b) => b.agentId === agentId);
		if (!known) {
			this.host.showWarning(`No bot named ${agentId}. Create it with /bot new ${agentId} <model>.`);
			return;
		}
		await this.switchTarget({ kind: "bot", agentId });
	}

	private async openTeam(rawId: string, port: BotTeamChatSessionPort): Promise<void> {
		const teamId = normalizeBotOrTeamId(rawId, "teamId");
		if (!port.getPersistentTeam(teamId)) {
			this.host.showWarning(`No team named ${teamId}. Create it with /team create ${teamId} <bot1,bot2>.`);
			return;
		}
		await this.switchTarget({ kind: "team", teamId });
	}

	private async createBot(rest: string, port: BotTeamChatSessionPort): Promise<void> {
		const [rawId, afterIdRaw] = splitHead(rest);
		const agentId = normalizeBotOrTeamId(rawId, "agentId");
		// --write lets the bot edit files; its replies are then structured reports rather than chat.
		const [maybeFlag, afterFlag] = splitHead(afterIdRaw);
		const canWrite = maybeFlag === "--write";
		const afterId = canWrite ? afterFlag : afterIdRaw;
		const [maybeModel, afterModel] = splitHead(afterId);
		// A token that names a registry model is the model; anything else begins the instructions.
		const hasModel = isModelReference(maybeModel, port.modelRegistry.getAll());
		const modelSpec = port.resolveModelSpec(hasModel ? maybeModel : undefined);
		const instructions = (hasModel ? afterModel : afterId).trim();
		const bot = port.upsertPersistentBot({
			agentId,
			provider: modelSpec.provider,
			modelId: modelSpec.modelId,
			thinkingLevel: modelSpec.thinkingLevel,
			instructions: instructions.length > 0 ? instructions : undefined,
			...(canWrite ? { canWrite } : {}),
		});
		await this.switchTarget({ kind: "bot", agentId: bot.agentId });
		this.host.showStatus(
			`Created bot ${bot.agentId} on ${bot.provider}/${bot.modelId} and switched to its live chat.`,
		);
	}

	private async sendToBotFromCommand(
		rest: string,
		port: BotTeamChatSessionPort,
		mode: "follow_up" | "queue" | undefined,
	): Promise<void> {
		const [rawId, body] = splitHead(rest);
		const agentId = normalizeBotOrTeamId(rawId, "agentId");
		if (body.length === 0) {
			this.host.showWarning("Usage: /bot msg|send|steer|queue <id> <text...>");
			return;
		}
		const result = await port.sendOperatorMessageToBot(agentId, body, mode ? { mode } : undefined);
		if (!this.isRootChatActive()) {
			await this.refreshActiveChatView();
		}
		this.host.showStatus(`Sent to ${agentId} (${result.mode}, ${result.modelRef}).`);
	}

	private ensureTeamMembersExist(memberAgentIds: readonly string[], port: BotTeamChatSessionPort): void {
		for (const memberId of memberAgentIds) {
			if (!port.listPersistentBots().some((b) => b.agentId === memberId)) {
				const defaultSpec = port.resolveModelSpec();
				port.upsertPersistentBot({
					agentId: memberId,
					provider: defaultSpec.provider,
					modelId: defaultSpec.modelId,
					thinkingLevel: defaultSpec.thinkingLevel,
				});
			}
		}
	}

	private async createTeam(rest: string, port: BotTeamChatSessionPort): Promise<void> {
		const [rawId, afterId] = splitHead(rest);
		const teamId = normalizeBotOrTeamId(rawId, "teamId");
		const [rawMembers, description] = splitHead(afterId);
		const memberAgentIds = parseIdList(rawMembers);
		this.ensureTeamMembersExist(memberAgentIds, port);
		const team = port.upsertPersistentTeam({
			teamId,
			description: description.trim().length > 0 ? description.trim() : undefined,
			memberAgentIds,
		});
		await this.switchTarget({ kind: "team", teamId: team.teamId });
		this.host.showStatus(
			`Created team ${team.teamId} [${team.memberAgentIds.join(", ")}] and switched to its live chat.`,
		);
	}

	private async setTeamMembersFromCommand(rest: string, port: BotTeamChatSessionPort): Promise<void> {
		const [rawId, rawMembers] = splitHead(rest);
		const teamId = normalizeBotOrTeamId(rawId, "teamId");
		const memberAgentIds = parseIdList(rawMembers);
		this.ensureTeamMembersExist(memberAgentIds, port);
		const team = port.setPersistentTeamMembers(teamId, memberAgentIds);
		if (this.activeTarget.kind === "team" && this.activeTarget.teamId === team.teamId) {
			await this.refreshActiveChatView();
		}
		this.host.showStatus(`Team ${team.teamId} members: ${team.memberAgentIds.join(", ") || "none"}.`);
	}

	private formatBotList(bots: readonly PersistentBotView[]): string {
		if (bots.length === 0) {
			return "No bots. Create one with /bot new <id> [--write] [model] [instructions...].";
		}
		return bots.map((b) => `${b.agentId} · ${b.state} · ${b.modelRef}`).join("\n");
	}

	private formatTeamList(port: BotTeamChatSessionPort): string {
		const teams = port.listPersistentTeams();
		if (teams.length === 0) {
			return "No teams. Create one with /team create <teamId> <bot1,bot2,...>.";
		}
		return teams.map((t) => `${t.teamId} · [${t.memberAgentIds.join(", ")}]`).join("\n");
	}
}
