import { type Container, Spacer, Text, type TUI } from "@caupulican/pi-tui";
import {
	type ActiveChatTarget,
	type BotOperatorMessageDispatchResult,
	type BotTeamChange,
	formatActiveChatTargetBadge,
	formatDurationIntervalMs,
	normalizeBotOrTeamId,
	type PersistentBotDaemonStatus,
	type PersistentBotRecord,
	type PersistentBotTeamStore,
	type PersistentBotView,
	type PersistentRoutineScheduleRecord,
	type PersistentTeamRecord,
	parseDirectChatAddress,
	parseDurationIntervalMs,
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
	listPersistentBots(defaultModelRef?: string, teamId?: string): PersistentBotView[];
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
	readBotChatMessages(agentId: string, teamId?: string): AgentMessage[];
	readTeamChatMessages(teamId: string): AgentMessage[];
	subscribeBotTeamUpdates(listener: (change: BotTeamChange) => void): () => void;
	resolveModelSpec(rawModel?: string): { provider: string; modelId: string; thinkingLevel?: string };
	readonly modelRegistry: Pick<ModelRegistry, "getAll">;
	getRootModelLabel(): string;
	getRootStatusLabel(): string;
	getBotTeamStore?(): PersistentBotTeamStore;
	tickPersistentRoutines?(routineId?: string): Promise<{ dispatched: string[]; failed: string[] }>;
	getPersistentBotDaemonStatus?(): PersistentBotDaemonStatus;
	startPersistentBotDaemon?(): { started: boolean; pid?: number; detail: string };
	stopPersistentBotDaemon?(): { stopped: boolean; detail: string };
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
					if (this.activeTarget.kind === "team")
						return this.dispatchToTeam(this.activeTarget.teamId, `@${target.agentId} ${addressed.body}`, {
							refreshOnly: true,
						});
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
				case "inbox":
					this.handleBotInboxCommand(rest, port);
					return;
				case "ack":
					this.handleBotAckCommand(rest, port);
					return;
				case "schedule":
				case "routine":
					await this.handleBotScheduleCommand(rest, port);
					return;
				case "daemon":
					await this.handleBotDaemonCommand(rest, port);
					return;
				default:
					this.host.showWarning(
						"Usage: /bot [list] | /bot new <id> [--write] [model] [instructions...] | /bot open <id> | /bot msg|send|steer|queue <id> <text...> | /bot inbox [id] | /bot ack [id|all] | /bot schedule [list|add|rm|run] ... | /bot daemon [status|start|stop|tick] | /bot stop <id> | /bot retire <id>",
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
				case "inbox":
					this.handleTeamInboxCommand(rest, port);
					return;
				case "ack":
					this.handleTeamAckCommand(rest, port);
					return;
				case "schedule":
				case "routine":
					await this.handleTeamScheduleCommand(rest, port);
					return;
				default:
					this.host.showWarning(
						"Usage: /team [list] | /team create <teamId> <bot1,bot2,...> [description...] | /team members <teamId> <bot1,bot2,...> | /team open <teamId> | /team msg <teamId> <text...> | /team inbox [teamId] | /team ack [teamId|all] | /team schedule [list|add|rm] ... | /team delete <teamId>",
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
		port.getBotTeamStore?.().acknowledgeBotInbox(agentId);
		const bot = port.listPersistentBots().find((b) => b.agentId === agentId);
		const messages = port.readBotChatMessages(agentId);
		const routines = (port.getBotTeamStore?.().listRoutines() ?? []).filter(
			(r) => r.target.kind === "bot" && r.target.agentId === agentId,
		);
		if (!this.beginChatRender(chatSignature({ kind: "bot", agentId, bot: bot ?? null, routines }, messages))) return;

		const modelLabel = bot?.modelRef ?? "unknown model";
		const thinking = bot?.thinkingLevel ?? "default";
		const state = bot?.state ?? "unknown";
		const teams = bot && bot.teamIds.length > 0 ? `Teams: ${bot.teamIds.join(", ")}` : undefined;
		const routineLabel =
			routines.length > 0
				? `Routines: ${routines.map((r) => `${r.routineId} (every ${formatDurationIntervalMs(r.intervalMs)})`).join(", ")}`
				: undefined;
		const detail = [bot?.description, bot?.currentSummary].filter((part): part is string => !!part).join(" · ");

		const lines = [
			theme.fg("accent", theme.bold(`● LIVE BOT CHAT · ${agentId}`)) +
				theme.fg("muted", ` · ${modelLabel} · thinking ${thinking} · ${state}`),
		];
		const secondLine = [teams, routineLabel, detail].filter((part): part is string => !!part).join("  ");
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
		port.getBotTeamStore?.().acknowledgeTeamInbox(teamId);
		const team = port.getPersistentTeam(teamId);
		const members = team?.memberAgentIds ?? [];
		const liveBots = port.listPersistentBots(undefined, teamId);
		const memberStatus = members
			.map((memberId) => {
				const bot = liveBots.find((b) => b.agentId === memberId);
				return `${memberId} (${bot?.state ?? "unknown"})`;
			})
			.join(" · ");
		const routines = (port.getBotTeamStore?.().listRoutines() ?? []).filter(
			(r) => r.target.kind === "team" && r.target.teamId === teamId,
		);
		const messages = port.readTeamChatMessages(teamId);
		if (
			!this.beginChatRender(
				chatSignature({ kind: "team", teamId, team: team ?? null, memberStatus, routines }, messages),
			)
		)
			return;

		const memoryPath = team?.memoryFilePath ?? `~/.pi/agent/memory/teams/${teamId}.md`;
		const routineLine =
			routines.length > 0
				? ` · Routines: ${routines.map((r) => `${r.routineId} (${formatDurationIntervalMs(r.intervalMs)})`).join(", ")}`
				: "";
		const lines = [
			theme.fg("accent", theme.bold(`◆ LIVE TEAM CHAT · ${team?.name ?? teamId}`)) +
				theme.fg("muted", ` [${members.join(", ")}]${routineLine}`),
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
		return bots
			.map((b) => {
				const unread = (b.unreadCount ?? 0) > 0 ? ` · ${b.unreadCount} unread` : "";
				const sched = (b.routineCount ?? 0) > 0 ? ` · ⏱${b.routineCount}` : "";
				return `${b.agentId} · ${b.state} · ${b.modelRef}${unread}${sched}`;
			})
			.join("\n");
	}

	private formatTeamList(port: BotTeamChatSessionPort): string {
		const teams = port.listPersistentTeams();
		if (teams.length === 0) {
			return "No teams. Create one with /team create <teamId> <bot1,bot2,...>.";
		}
		return teams
			.map((t) => {
				const unread = (t.unreadCount ?? 0) > 0 ? ` · ${t.unreadCount} unread` : "";
				return `${t.teamId} · [${t.memberAgentIds.join(", ")}]${unread}`;
			})
			.join("\n");
	}

	private handleBotInboxCommand(rest: string, port: BotTeamChatSessionPort): void {
		const store = port.getBotTeamStore?.();
		if (!store) {
			this.host.showWarning("Bot store is unavailable in this session.");
			return;
		}
		const [rawId] = splitHead(rest);
		const targetBotId = rawId
			? normalizeBotOrTeamId(rawId, "agentId")
			: this.activeTarget.kind === "bot"
				? this.activeTarget.agentId
				: undefined;
		if (targetBotId) {
			const entries = store.listBotInbox(targetBotId, 10);
			if (entries.length === 0) {
				this.host.showStatus(`Inbox for bot ${targetBotId} is empty.`);
				return;
			}
			const lines = entries.map(
				(e) =>
					`${e.unread ? "●" : "○"} [${new Date(e.timestamp).toISOString()}] (${e.kind}:${e.targetId}) ${e.sender}: ${e.text.replace(/\r?\n+/g, " ").slice(0, 120)}`,
			);
			this.host.showStatus(`Inbox for bot ${targetBotId}:\n${lines.join("\n")}`);
			return;
		}
		const bots = port.listPersistentBots();
		const teams = port.listPersistentTeams();
		const summary: string[] = [];
		for (const bot of bots) {
			if ((bot.unreadCount ?? 0) > 0 || bot.lastSummary) {
				summary.push(
					`bot:${bot.agentId} (${bot.unreadCount ?? 0} unread): ${(bot.lastSummary ?? "no summary").replace(/\r?\n+/g, " ").slice(0, 100)}`,
				);
			}
		}
		for (const team of teams) {
			if ((team.unreadCount ?? 0) > 0) {
				summary.push(`team:${team.teamId} (${team.unreadCount} unread)`);
			}
		}
		this.host.showStatus(
			summary.length > 0 ? `Bot & Team Inboxes:\n${summary.join("\n")}` : "All bot and team inboxes are caught up.",
		);
	}

	private handleBotAckCommand(rest: string, port: BotTeamChatSessionPort): void {
		this.handleInboxAck("bot", rest, port);
	}

	private handleTeamAckCommand(rest: string, port: BotTeamChatSessionPort): void {
		this.handleInboxAck("team", rest, port);
	}

	private handleInboxAck(kind: "bot" | "team", rest: string, port: BotTeamChatSessionPort): void {
		const store = port.getBotTeamStore?.();
		if (!store) {
			this.host.showWarning("Store is unavailable in this session.");
			return;
		}
		const [rawId] = splitHead(rest);
		if (!rawId || rawId === "all") {
			const count = store.acknowledgeAllInboxes();
			this.host.showStatus(`Acknowledged ${count} inbox(es).`);
			this.host.ui.requestRender();
			return;
		}
		const normId = normalizeBotOrTeamId(rawId, kind === "bot" ? "agentId" : "teamId");
		const acknowledged = kind === "bot" ? store.acknowledgeBotInbox(normId) : store.acknowledgeTeamInbox(normId);
		if (acknowledged) {
			this.host.showStatus(`Acknowledged inbox for ${kind} ${normId}.`);
			this.host.ui.requestRender();
		} else {
			this.host.showWarning(`${kind === "bot" ? "Bot" : "Team"} not found: ${normId}.`);
		}
	}

	private handleTeamInboxCommand(rest: string, port: BotTeamChatSessionPort): void {
		const store = port.getBotTeamStore?.();
		if (!store) {
			this.host.showWarning("Team store is unavailable in this session.");
			return;
		}
		const [rawId] = splitHead(rest);
		const targetTeamId = rawId
			? normalizeBotOrTeamId(rawId, "teamId")
			: this.activeTarget.kind === "team"
				? this.activeTarget.teamId
				: undefined;
		if (!targetTeamId) {
			this.handleBotInboxCommand("", port);
			return;
		}
		const entries = store.listTeamInbox(targetTeamId, 10);
		if (entries.length === 0) {
			this.host.showStatus(`Inbox for team ${targetTeamId} is empty.`);
			return;
		}
		const lines = entries.map(
			(e) =>
				`${e.unread ? "●" : "○"} [${new Date(e.timestamp).toISOString()}] ${e.sender}: ${e.text.replace(/\r?\n+/g, " ").slice(0, 120)}`,
		);
		this.host.showStatus(`Inbox for team ${targetTeamId}:\n${lines.join("\n")}`);
	}

	private formatRoutineList(routines: readonly PersistentRoutineScheduleRecord[]): string {
		if (routines.length === 0) {
			return "No scheduled routines. Add one with /bot schedule add <routineId> <botId> <interval> <prompt...>.";
		}
		return routines
			.map((r) => {
				const targetLabel = r.target.kind === "bot" ? `bot:${r.target.agentId}` : `team:${r.target.teamId}`;
				const status = r.lastStatus ? ` · last=${r.lastStatus}` : "";
				return `${r.routineId} → ${targetLabel} · every ${formatDurationIntervalMs(r.intervalMs)} · next=${new Date(r.nextRunAt).toISOString()}${status} · "${r.prompt}"`;
			})
			.join("\n");
	}

	private async handleBotScheduleCommand(rest: string, port: BotTeamChatSessionPort): Promise<void> {
		await this.handleSchedule("bot", rest, port);
	}

	private async handleTeamScheduleCommand(rest: string, port: BotTeamChatSessionPort): Promise<void> {
		await this.handleSchedule("team", rest, port);
	}

	private async handleSchedule(kind: "bot" | "team", rest: string, port: BotTeamChatSessionPort): Promise<void> {
		const store = port.getBotTeamStore?.();
		if (!store) {
			this.host.showWarning("Store is unavailable in this session.");
			return;
		}
		const [sub, subRest] = splitHead(rest);
		if (!sub || sub === "list") {
			const routines =
				kind === "team" ? store.listRoutines().filter((r) => r.target.kind === "team") : store.listRoutines();
			this.host.showStatus(this.formatRoutineList(routines));
			return;
		}
		if (sub === "rm" || sub === "delete") {
			const [id] = splitHead(subRest);
			const routineId = normalizeBotOrTeamId(id, "routineId");
			if (store.deleteRoutine(routineId)) {
				this.host.showStatus(`Deleted scheduled routine ${routineId}.`);
				this.host.ui.requestRender();
			} else {
				this.host.showWarning(`Routine not found: ${routineId}.`);
			}
			return;
		}
		if (kind === "bot" && (sub === "run" || sub === "tick")) {
			const [id] = splitHead(subRest);
			const res = await port.tickPersistentRoutines?.(id ? normalizeBotOrTeamId(id, "routineId") : undefined);
			this.host.showStatus(
				res
					? `Routines dispatched: ${res.dispatched.join(", ") || "none"}${res.failed.length ? ` · failed: ${res.failed.join("; ")}` : ""}.`
					: "Routine scheduler tick unavailable.",
			);
			return;
		}
		if (sub === "add" || sub === "set") {
			const [rawRoutineId, afterRoutineId] = splitHead(subRest);
			const [rawTargetId, afterTargetId] = splitHead(afterRoutineId);
			const [rawInterval, prompt] = splitHead(afterTargetId);
			if (!rawRoutineId || !rawTargetId || !rawInterval || !prompt.trim()) {
				this.host.showWarning(`Usage: /${kind} schedule add <routineId> <${kind}Id> <interval> <prompt...>`);
				return;
			}
			const intervalMs = parseDurationIntervalMs(rawInterval);
			if (kind === "bot") {
				const agentId = normalizeBotOrTeamId(rawTargetId, "agentId");
				this.ensureTeamMembersExist([agentId], port);
				const routine = store.upsertRoutine({
					routineId: rawRoutineId,
					target: { kind: "bot", agentId },
					intervalMs,
					prompt,
				});
				this.host.showStatus(
					`Scheduled routine ${routine.routineId} for bot ${agentId} every ${formatDurationIntervalMs(routine.intervalMs)}.`,
				);
			} else {
				const teamId = normalizeBotOrTeamId(rawTargetId, "teamId");
				if (!port.getPersistentTeam(teamId)) {
					this.host.showWarning(`Team not found: ${teamId}. Create it first with /team create.`);
					return;
				}
				const routine = store.upsertRoutine({
					routineId: rawRoutineId,
					target: { kind: "team", teamId },
					intervalMs,
					prompt,
				});
				this.host.showStatus(
					`Scheduled routine ${routine.routineId} for team ${teamId} every ${formatDurationIntervalMs(routine.intervalMs)}.`,
				);
			}
			this.host.ui.requestRender();
			return;
		}
		this.host.showWarning(
			`Usage: /${kind} schedule [list | add <routineId> <${kind}Id> <interval> <prompt...> | rm <routineId>${kind === "bot" ? " | run [routineId]" : ""}]`,
		);
	}

	private async handleBotDaemonCommand(rest: string, port: BotTeamChatSessionPort): Promise<void> {
		const [sub] = splitHead(rest);
		switch (sub) {
			case "":
			case "status": {
				const status = port.getPersistentBotDaemonStatus?.() ?? port.getBotTeamStore?.().getDaemonStatus();
				if (!status) {
					this.host.showWarning("Daemon status unavailable.");
					return;
				}
				this.host.showStatus(
					status.running
						? `Detached bot daemon running (pid ${status.pid}, ${status.activeRoutines} active routines, ${status.dueRoutines} due).`
						: `Detached bot daemon stopped (${status.activeRoutines} active routines, ${status.dueRoutines} due).`,
				);
				return;
			}
			case "start": {
				const res = port.startPersistentBotDaemon?.();
				if (!res) {
					this.host.showWarning("Detached bot daemon start unavailable.");
					return;
				}
				if (res.started) this.host.showStatus(res.detail);
				else this.host.showWarning(res.detail);
				return;
			}
			case "stop": {
				const res = port.stopPersistentBotDaemon?.();
				if (!res) {
					this.host.showWarning("Detached bot daemon stop unavailable.");
					return;
				}
				if (res.stopped) this.host.showStatus(res.detail);
				else this.host.showWarning(res.detail);
				return;
			}
			case "tick": {
				const res = await port.tickPersistentRoutines?.();
				this.host.showStatus(
					res
						? `Daemon/routine tick dispatched: ${res.dispatched.join(", ") || "none"}.`
						: "Routine tick unavailable.",
				);
				return;
			}
			default:
				this.host.showWarning("Usage: /bot daemon [status | start | stop | tick]");
		}
	}
}
