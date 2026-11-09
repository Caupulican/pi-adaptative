import { type Container, Spacer, Text, type TUI } from "@caupulican/pi-tui";
import type { AwayChannelStatus } from "../../core/channels/away-channels.ts";
import { SPAWNER_BOT_ID, SPAWNER_SOUL } from "../../core/delegation/bot-creation.ts";
import { displayNameFor } from "../../core/delegation/bot-naming.ts";
import { describeDaemonBuild, OWN_DAEMON_BUILD } from "../../core/delegation/bot-team-routine-helpers.ts";
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
	type PersistentTeamRecord,
	parseDirectChatAddress,
	parseDurationIntervalMs,
	type TeamOperatorMessageDispatchResult,
	type UpsertPersistentBotInput,
	type UpsertPersistentTeamInput,
} from "../../core/delegation/persistent-bot-team-store.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { isModelReference } from "../../core/model-resolver.ts";
import type { RemoteHubController } from "../../core/remote/hub-controller.ts";
import { type AwayService, describeAwayServiceInspection } from "../../core/routines/away-service.ts";
import { nextRoutineAt, type RoutineDefinitionView } from "../../core/routines/routine-contract.ts";
import { describeRoutineProgress } from "../../core/routines/routine-progress.ts";
import { describeWatchCondition } from "../../core/routines/watch-contract.ts";
import { boundedLine } from "../../core/util/bounded-line.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { theme } from "../../presentation/theme-model.ts";
import { REMOTE_MARK } from "./components/bot-state-mark.ts";
import { teamSpeakerTone } from "./components/custom-message.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { botStateGlyph } from "./components/workbench.ts";
import { runRemoteCommand } from "./remote-commands.ts";

/** What the owner is told after a message went to a bot, in plain words (no mode names, no link labels). */
function sentToBotText(agentId: string, result: BotOperatorMessageDispatchResult): string {
	if (result.modelRef === "link/remote") return `Sent to ${agentId}; its answer comes back here.`;
	const how: Record<BotOperatorMessageDispatchResult["mode"], string> = {
		started: "it started on it",
		followed_up: "added to its conversation",
		steered: "sent while it works",
		queued: "queued for it",
	};
	return `Sent to ${agentId}: ${how[result.mode]} (${result.modelRef}).`;
}

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
		options?: { mode?: "follow_up" | "queue" | "start"; answerInSession?: boolean },
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
	/** The session's background lanes: the always-on service of its agent directory and its channels served away. */
	readonly backgroundLanes?: {
		getAwayService(): AwayService;
		readAwayChannelStatus(): readonly AwayChannelStatus[];
		getRemoteHub(): RemoteHubController;
		readonly channels: { reload(): void };
	};
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
	/** Opens a multi-line editor panel with `prefill`; undefined when the owner cancels. Text is returned exactly as typed. */
	promptForEdit(title: string, prefill: string): Promise<string | undefined>;
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

function routineScheduleLabel(routine: RoutineDefinitionView): string {
	switch (routine.schedule.kind) {
		case "interval":
			return `every ${formatDurationIntervalMs(routine.schedule.intervalMs)}`;
		case "once":
			return `once at ${new Date(routine.schedule.at).toISOString()}`;
		case "calendar":
			return `"${routine.schedule.cron}" in ${routine.schedule.timeZone}`;
		case "event": {
			const schedule = routine.schedule;
			if (schedule.source === "watch") return describeWatchCondition(schedule.condition);
			if (schedule.source === "github") {
				const scope = [
					schedule.pullRequest === undefined ? undefined : `#${schedule.pullRequest}`,
					schedule.branch === undefined ? undefined : `branch ${schedule.branch}`,
					schedule.ownPullRequests ? "own pull requests" : undefined,
					schedule.authors === undefined
						? undefined
						: `by ${schedule.authors.map((login) => `@${login}`).join(", ")}`,
				].filter((part) => part !== undefined);
				return `on GitHub ${schedule.kinds.join("/")}${scope.length ? ` (${scope.join("; ")})` : ""}`;
			}
			return `on CI ${schedule.conclusions.join("/")}${schedule.workflowPath === undefined ? "" : ` of ${schedule.workflowPath}`}`;
		}
	}
}

function chatRoutine(store: PersistentBotTeamStore, routineId: string): RoutineDefinitionView | undefined {
	const routine = store.getRoutine(routineId);
	if (routine?.target.kind === "session")
		throw new Error("Manage a main-session routine through its owner's routine tool.");
	return routine;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * What a rendered chat shows: its header facts plus the message count and the last message's time. A transcript only
 * grows, so these change whenever a message is added; hashing every message on each event would cost more than it saves.
 */
/** What a bot is doing now, in a few words: its last tool call with the argument that names its target, from its own transcript. */
function currentActivity(messages: readonly AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const call = [...message.content].reverse().find((block) => block.type === "toolCall");
		if (call?.type !== "toolCall") return "writing its answer";
		const args = call.arguments as Record<string, unknown>;
		// A message to a peer shows who it goes to, never its text; any other call shows the argument that names its target.
		const keys =
			call.name === "bot_message"
				? ["to", "agentId", "target", "recipient"]
				: ["path", "command", "pattern", "query", "url", "prompt", "message", "text"];
		const key = keys.find((name) => typeof args[name] === "string");
		const value = key ? String(args[key]).replace(/\s+/g, " ").trim() : "";
		const shown = value.length > 42 ? `${value.slice(0, 41)}…` : value;
		if (call.name === "bot_message") return shown ? `messages ${shown}` : "messages a peer";
		return shown ? `${call.name} ${shown}` : call.name;
	}
	return undefined;
}

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
	 * caller should submit normally; for an `@root` address the caller submits the text from `rootAddressBodyStart(rawText)`.
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

	/**
	 * Where the text after a leading `@root` or `@brain` address starts (0 without one): the rest submits to root. An
	 * offset, not the stripped text, so the caller keeps the submission's pasted ranges aligned.
	 */
	rootAddressBodyStart(rawText: string): number {
		return /^\s*@(?:root|brain)\s+(?=\S)/.exec(rawText)?.[0].length ?? 0;
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

	/** `/remote ...`: machines joined to this session as bots, and hubs this session joined. */
	async handleRemoteCommand(rawText: string): Promise<void> {
		const lanes = this.host.getSessionPort().backgroundLanes;
		if (!lanes) {
			this.host.showWarning("Remote machines are not available in this session.");
			return;
		}
		await runRemoteCommand(
			rawText,
			{ hub: lanes.getRemoteHub(), reloadChannels: () => lanes.channels.reload() },
			this.host,
		);
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
				case "soul":
					await this.editBotSoul(rest, port);
					return;
				case "lead":
				case "unlead":
					this.setBotLeader(rest, sub === "lead", port);
					return;
				case "spawner":
					this.createSpawnerBot(port);
					return;
				case "rename":
					this.renameBot(rest, port);
					return;
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
						"Usage: /bot [list] | /bot new <id> [--write] [model] [soul...] | /bot soul <id> | /bot rename <id> <name...> | /bot lead|unlead <id> (a standing leader; its goals are /lead) | /bot spawner | /bot open <id> | /bot msg|send|steer|queue <id> <text...> | /bot inbox [id] | /bot ack [id|all] | /bot schedule [list|add|rm|run] ... | /bot daemon [status|start|stop|tick|service] | /bot stop <id> | /bot retire <id>",
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
				? `Routines: ${routines.map((r) => `${r.routineId} (${routineScheduleLabel(r)})`).join(", ")}`
				: undefined;
		const detail = [bot?.description, bot?.currentSummary].filter((part): part is string => !!part).join(" · ");

		const lines = [
			theme.fg("accent", theme.bold(`● LIVE BOT CHAT · ${agentId}${bot?.remote ? ` ${REMOTE_MARK} remote` : ""}`)) +
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
	private finishChatRender(
		header: readonly string[],
		messages: readonly AgentMessage[],
		emptyHint: string,
		footer: readonly string[] = [],
	): void {
		const chat = this.host.chatContainer;
		chat.addChild(new Text(header.join("\n"), 1, 0));
		chat.addChild(new DynamicBorder());
		chat.addChild(new Spacer(1));
		if (messages.length === 0) {
			chat.addChild(new Text(theme.fg("muted", emptyHint), 1, 0));
		} else {
			for (const message of messages) this.host.appendRenderedMessageToChat(message);
		}
		// What is happening now sits after the last message, where the eye is, not in the header that scrolls away.
		if (footer.length > 0) chat.addChild(new Text(footer.join("\n"), 1, 0));
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
				return `${botStateGlyph(bot?.state ?? "idle")} ${theme.fg(teamSpeakerTone(memberId), memberId)}`;
			})
			.join("  ");
		// A member at work gets a live line: its current step, in its own colour, so the group shows what each bot is doing.
		const working = members.flatMap((memberId) => {
			const state = liveBots.find((b) => b.agentId === memberId)?.state;
			if (state !== "running" && state !== "queued") return [];
			const activity =
				state === "queued" ? "waiting to start" : currentActivity(port.readBotChatMessages(memberId, teamId));
			return [{ memberId, activity: activity ?? "starting" }];
		});
		const routines = (port.getBotTeamStore?.().listRoutines() ?? []).filter(
			(r) => r.target.kind === "team" && r.target.teamId === teamId,
		);
		const messages = port.readTeamChatMessages(teamId);
		if (
			!this.beginChatRender(
				chatSignature({ kind: "team", teamId, team: team ?? null, memberStatus, routines, working }, messages),
			)
		)
			return;

		const routineLine =
			routines.length > 0
				? `  ⏱ ${routines.map((r) => `${r.routineId} ${routineScheduleLabel(r)}`).join(", ")}`
				: "";
		// The members' own glyphs say who is working; the hint is the one thing a newcomer to the group needs.
		const lines = [
			theme.fg("accent", theme.bold(`◆ ${team?.name ?? teamId}`)) +
				`  ${memberStatus.length > 0 ? memberStatus : theme.fg("muted", "no members")}${theme.fg("muted", routineLine)}`,
			theme.fg("dim", "Type to message everyone · @bot for one · /chat root returns to Brain"),
		];
		this.finishChatRender(
			lines,
			messages,
			`  No messages in team ${teamId} yet. Type below and press Enter to message the team.`,
			working.map(
				({ memberId, activity }) =>
					`${theme.fg(teamSpeakerTone(memberId), `◐ ${memberId}`)} ${theme.fg("muted", activity)}`,
			),
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
			const result = await this.host.getSessionPort().sendOperatorMessageToBot(agentId, body, {
				answerInSession: this.isRootChatActive(),
			});
			if (options.refreshOnly || !this.isRootChatActive()) {
				await this.refreshActiveChatView();
			}
			if (!options.refreshOnly) {
				this.host.showStatus(sentToBotText(agentId, result));
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
		// A token that names a registry model is the model; anything else begins the soul.
		const hasModel = isModelReference(maybeModel, port.modelRegistry.getAll());
		const modelSpec = port.resolveModelSpec(hasModel ? maybeModel : undefined);
		const soul = (hasModel ? afterModel : afterId).trim();
		const bot = port.upsertPersistentBot({
			agentId,
			displayName: displayNameFor(agentId),
			provider: modelSpec.provider,
			modelId: modelSpec.modelId,
			thinkingLevel: modelSpec.thinkingLevel,
			soul: soul.length > 0 ? soul : undefined,
			createdBy: "owner",
			...(canWrite ? { canWrite } : {}),
		});
		await this.switchTarget({ kind: "bot", agentId: bot.agentId });
		this.host.showStatus(
			`Created bot ${bot.agentId} on ${bot.provider}/${bot.modelId} and switched to its live chat.`,
		);
	}

	/** The persistent bot a `/bot` subcommand names, or a warning (usage, or no such bot) and undefined. */
	private namedPersistentBot(
		rest: string,
		usage: string,
		port: BotTeamChatSessionPort,
	): PersistentBotView | undefined {
		const [rawId] = splitHead(rest);
		if (rawId.length === 0) {
			this.host.showWarning(`Usage: ${usage}`);
			return undefined;
		}
		const agentId = normalizeBotOrTeamId(rawId, "agentId");
		const bot = port.listPersistentBots().find((b) => b.agentId === agentId && b.persistent);
		if (!bot) this.host.showWarning(`No bot named ${agentId}. Create it with /bot new ${agentId} <model> [soul...].`);
		return bot;
	}

	/** `/bot rename <id> <name...>`: what the screen shows for the bot; its id, the handle typed after `@`, stays. */
	private renameBot(rest: string, port: BotTeamChatSessionPort): void {
		const bot = this.namedPersistentBot(rest, "/bot rename <id> <name...>", port);
		if (!bot) return;
		const name = splitHead(rest)[1].trim();
		if (name.length === 0 || name.length > 60) {
			this.host.showWarning("Usage: /bot rename <id> <name...> (a name of 1 to 60 characters).");
			return;
		}
		port.upsertPersistentBot({ agentId: bot.agentId, displayName: name });
		this.host.showStatus(`${bot.agentId} is now shown as ${name}. Address it as @${bot.agentId} as before.`);
	}

	/** `/bot spawner`: the one bot whose only work is making the bots and workers the orchestrator asks for. */
	private createSpawnerBot(port: BotTeamChatSessionPort): void {
		if (port.listPersistentBots().some((b) => b.agentId === SPAWNER_BOT_ID && b.persistent)) {
			this.host.showStatus(`${SPAWNER_BOT_ID} already exists.`);
			return;
		}
		const spec = port.resolveModelSpec(undefined);
		port.upsertPersistentBot({
			agentId: SPAWNER_BOT_ID,
			displayName: displayNameFor(SPAWNER_BOT_ID),
			provider: spec.provider,
			modelId: spec.modelId,
			thinkingLevel: spec.thinkingLevel,
			soul: SPAWNER_SOUL,
			leader: true,
			createdBy: "owner",
		});
		this.host.showStatus(
			`${SPAWNER_BOT_ID} is ready. The orchestrator can hand it the making of many bots at once; it creates them and briefs each.`,
		);
	}

	/** `/bot lead <id>` and `/bot unlead <id>`: only the owner makes a bot a leader; a leader creates bots on the fly. */
	private setBotLeader(rest: string, leader: boolean, port: BotTeamChatSessionPort): void {
		const bot = this.namedPersistentBot(rest, `/bot ${leader ? "lead" : "unlead"} <id>`, port);
		if (!bot) return;
		port.upsertPersistentBot({ agentId: bot.agentId, leader });
		this.host.showStatus(
			leader
				? `${bot.agentId} is now a standing leader: it can create bots, and other bots ask it or the orchestrator for one. It takes effect from the bot's next worker start. Its goals, handed to it by the orchestrator, are shown and overridden with /lead, not here.`
				: `${bot.agentId} is no longer a standing leader. It takes effect from the bot's next worker start. A goal it already leads keeps running: /lead shows it, and /lead cancel ${bot.agentId} stops it.`,
		);
	}

	/** `/bot soul <id>`: edit the bot's soul in a panel and store it through the same write path as `/bot new`. */
	private async editBotSoul(rest: string, port: BotTeamChatSessionPort): Promise<void> {
		const bot = this.namedPersistentBot(rest, "/bot soul <id>", port);
		if (!bot) return;
		const agentId = bot.agentId;
		const edited = await this.host.promptForEdit(`Edit soul of bot ${agentId}`, bot.soul ?? "");
		if (edited === undefined) {
			this.host.showStatus("Soul edit cancelled.");
			return;
		}
		if (edited.trim() === (bot.soul ?? "")) {
			this.host.showStatus(`Soul of ${agentId} unchanged.`);
			return;
		}
		// A rejected soul and a bot with a live worker both throw with their reason; the command handler shows it.
		const saved = port.upsertPersistentBot({ agentId, soul: edited });
		this.host.showStatus(
			saved.soul
				? `Soul of ${agentId} saved (${saved.soul.length} characters). It opens the bot's system prompt from its next worker start.`
				: `Soul of ${agentId} cleared.`,
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
		const result = await port.sendOperatorMessageToBot(agentId, body, {
			...(mode ? { mode } : {}),
			answerInSession: this.isRootChatActive(),
		});
		if (!this.isRootChatActive()) {
			await this.refreshActiveChatView();
		}
		this.host.showStatus(sentToBotText(agentId, result));
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
			return "No bots. Create one with /bot new <id> [--write] [model] [soul...].";
		}
		return bots
			.map((b) => {
				const unread = (b.unreadCount ?? 0) > 0 ? ` · ${b.unreadCount} unread` : "";
				const sched = (b.routineCount ?? 0) > 0 ? ` · ⏱${b.routineCount}` : "";
				const role = `${b.leader ? " · leader" : ""}${b.remote ? ` · ${REMOTE_MARK} remote` : ""}`;
				return `${b.agentId}${role} · ${b.state} · ${b.modelRef}${unread}${sched}`;
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

	private formatRoutineList(routines: readonly RoutineDefinitionView[]): string {
		if (routines.length === 0) {
			return "No scheduled routines. Add one with /bot schedule add <routineId> <botId> <interval> <prompt...>.";
		}
		return routines
			.map((r) => {
				const targetLabel =
					r.target.kind === "bot"
						? `bot:${r.target.agentId}`
						: r.target.kind === "team"
							? `team:${r.target.teamId}`
							: "main session";
				const next = nextRoutineAt(r.schedule, r.cursor);
				const outcome = r.lastSummary ? `: ${r.lastSummary.replace(/\r?\n+/g, " ").slice(0, 100)}` : "";
				const status = r.lastStatus ? ` · last=${r.lastStatus}${outcome}` : "";
				const progress = describeRoutineProgress(r.progress);
				const stood = progress ? ` · where it stood: ${boundedLine(progress, 160)}` : "";
				const nextLabel =
					next !== undefined
						? new Date(next).toISOString()
						: r.schedule.kind === "event"
							? "on event"
							: "complete";
				return `${r.routineId} → ${targetLabel} · ${routineScheduleLabel(r)} · next=${nextLabel}${status}${stood} · "${r.prompt}"`;
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
		store.reload();
		const [sub, subRest] = splitHead(rest);
		if (!sub || sub === "list") {
			const routines = store
				.listRoutines()
				.filter((r) => (kind === "team" ? r.target.kind === "team" : r.target.kind !== "session"));
			this.host.showStatus(this.formatRoutineList(routines));
			return;
		}
		if (sub === "rm" || sub === "delete") {
			const [id] = splitHead(subRest);
			const routineId = normalizeBotOrTeamId(id, "routineId");
			const routine = chatRoutine(store, routineId);
			if (routine && store.deleteRoutine(routineId, routine.revision)) {
				this.host.showStatus(`Deleted scheduled routine ${routineId}.`);
				this.host.ui.requestRender();
			} else {
				this.host.showWarning(`Routine not found: ${routineId}.`);
			}
			return;
		}
		if (kind === "bot" && (sub === "run" || sub === "tick")) {
			const [id] = splitHead(subRest);
			if (id) chatRoutine(store, normalizeBotOrTeamId(id, "routineId"));
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
			const existing = chatRoutine(store, normalizeBotOrTeamId(rawRoutineId, "routineId"));
			const revision = existing ? { expectedRevision: existing.revision } : { createOnly: true };
			if (kind === "bot") {
				const agentId = normalizeBotOrTeamId(rawTargetId, "agentId");
				this.ensureTeamMembersExist([agentId], port);
				const routine = store.upsertRoutine({
					...revision,
					routineId: rawRoutineId,
					target: { kind: "bot", agentId },
					schedule: { kind: "interval", intervalMs },
					prompt,
				});
				this.host.showStatus(
					`Scheduled routine ${routine.routineId} for bot ${agentId} ${routineScheduleLabel(routine)}.`,
				);
			} else {
				const teamId = normalizeBotOrTeamId(rawTargetId, "teamId");
				if (!port.getPersistentTeam(teamId)) {
					this.host.showWarning(`Team not found: ${teamId}. Create it first with /team create.`);
					return;
				}
				const routine = store.upsertRoutine({
					...revision,
					routineId: rawRoutineId,
					target: { kind: "team", teamId },
					schedule: { kind: "interval", intervalMs },
					prompt,
				});
				this.host.showStatus(
					`Scheduled routine ${routine.routineId} for team ${teamId} ${routineScheduleLabel(routine)}.`,
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
		const [sub, subRest] = splitHead(rest);
		switch (sub) {
			case "":
			case "status": {
				const status = port.getPersistentBotDaemonStatus?.() ?? port.getBotTeamStore?.().getDaemonStatus();
				if (!status) {
					this.host.showWarning("Daemon status unavailable.");
					return;
				}
				const counts = `${status.activeRoutines} active routines, ${status.dueRoutines} due`;
				const legacyNote = status.legacy
					? ` An older build's daemon${status.legacy.pid === undefined ? "" : ` (pid ${status.legacy.pid})`} is still running; it can no longer write the store.`
					: "";
				const endNote =
					!status.running && status.lastEnd
						? ` It last ended ${status.lastEnd.reason === "released" ? "when a session stopped it" : status.lastEnd.reason === "signal" ? "when its process was stopped" : `on an error${status.lastEnd.detail ? `: ${status.lastEnd.detail}` : ""}`}.`
						: "";
				const lines = [
					status.running
						? `Detached bot daemon running (${status.pid === undefined ? "" : `pid ${status.pid}, `}${describeDaemonBuild(status.build, OWN_DAEMON_BUILD)}, ${counts}).${legacyNote}`
						: `Detached bot daemon stopped (${counts}).${endNote}${legacyNote}`,
					...status.awayRefusals.map(
						(refusal) => `Routine ${refusal.routineId} was not run away: ${refusal.reason}`,
					),
					...status.reports.slice(-5).map((report) => `${new Date(report.at).toISOString()} ${report.message}`),
				];
				const awayService = port.backgroundLanes?.getAwayService();
				if (awayService) lines.push(describeAwayServiceInspection(awayService.inspect()));
				for (const channel of port.backgroundLanes?.readAwayChannelStatus() ?? [])
					lines.push(
						`Channel ${channel.name} is served by the daemon in ${channel.cwd} while no session is open (now: ${channel.servedBy}); ${channel.awayDrafts} reply draft(s) it wrote wait for the next session (channel_reply).`,
					);
				this.host.showStatus(lines.join("\n"));
				return;
			}
			case "service": {
				const awayService = port.backgroundLanes?.getAwayService();
				if (!awayService) {
					this.host.showWarning("The always-on service is unavailable in this session.");
					return;
				}
				const [action] = splitHead(subRest);
				if (action === "" || action === "status") {
					this.host.showStatus((await awayService.status()).join("\n"));
					return;
				}
				if (action === "install" || action === "uninstall") {
					const outcome = action === "install" ? await awayService.install() : await awayService.uninstall();
					if (outcome.ok) this.host.showStatus(outcome.detail);
					else this.host.showWarning(outcome.detail);
					return;
				}
				this.host.showWarning("Usage: /bot daemon service [status | install | uninstall]");
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
				this.host.showWarning(
					"Usage: /bot daemon [status | start | stop | tick | service [status | install | uninstall]]",
				);
		}
	}
}
