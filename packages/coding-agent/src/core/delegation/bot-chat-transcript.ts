/**
 * The chat an operator reads for a bot or a group. A bot's direct chat is read from its home alone, whichever process wrote
 * it: its own session's conversation with the owner and the worker runs its history index holds (what ran as a worker
 * before the bot had a session of its own, and the sends that still run as workers, each indexed when it is bound), shaped
 * into the messages the chat view draws and merged in by time. A machine joined over the link reads the remote hub's chat;
 * a group's chat is the group's worker conversation with the bot in this session, with the lane and group records as the
 * fallback when none exists, and a group's own message log. It reads through the ports the coordinator gives it and never
 * builds a worker, a store or a hub itself.
 */
import type { AssistantMessage } from "@caupulican/pi-ai";
import type { AgentMessage } from "../../kernel/types.ts";
import { workerControlOf } from "../../kernel/worker-control-stamp.ts";
import { isModelFacingText } from "../../presentation/plain-text.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { BotHistoryRead } from "../bots/bot-history.ts";
import type { BotSessionHost } from "../bots/bot-session-host.ts";
import type { RemoteHubController } from "../remote/hub-controller.ts";
import { botChatOperatorText, botReplyText } from "./bot-chat-text.ts";
import type { BotRuntimeBindings } from "./bot-runtime-bindings.ts";
import {
	normalizeBotOrTeamId,
	type PersistentBotRecord,
	type PersistentBotTeamStore,
	teamIncarnation,
} from "./persistent-bot-team-store.ts";
import type { WorkerConversation } from "./worker-conversation-store.ts";
import { SUBMIT_REPORT_TOOL_NAME } from "./worker-report.ts";

/** What the chat reads from the coordinator: the roster store, the hub's chat, the worker transcript and the lane records. */
export interface BotChatHost {
	getBotTeamStore(): PersistentBotTeamStore;
	getRemoteHub(): Pick<RemoteHubController, "chat">;
	openWorkerTranscript(agentId: string): WorkerConversation | undefined;
	getLaneRecords(): LaneRecord[];
	/** The bots' own conversations: a bot's session, loaded or on disk, and its earlier worker conversations from its home. */
	readonly botSessions: Pick<BotSessionHost, "readMessages" | "readHistory">;
}

/** The messages of two chronological lists in time order, each list's own order kept (an untimed message keeps its place). */
function mergeByTime(first: readonly AgentMessage[], second: readonly AgentMessage[]): AgentMessage[] {
	const timed = (list: readonly AgentMessage[]): number[] => {
		let last = 0;
		return list.map((message) => (last = message.timestamp ?? last));
	};
	const firstTimes = timed(first);
	const secondTimes = timed(second);
	const merged: AgentMessage[] = [];
	let i = 0;
	let j = 0;
	while (i < first.length || j < second.length) {
		const takeFirst = j >= second.length || (i < first.length && firstTimes[i]! <= secondTimes[j]!);
		merged.push(takeFirst ? first[i++]! : second[j++]!);
	}
	return merged;
}

/** Reads the chat of a bot (its own generation, or a group's) and the message log of a group. */
export class BotChatTranscript {
	private readonly botBindings: Pick<BotRuntimeBindings, "runtime">;
	private readonly host: BotChatHost;
	/** Each history read as the chat draws it: kept while the history returns the same read (nothing it holds changed). */
	private readonly shapedHistory = new WeakMap<BotHistoryRead, AgentMessage[]>();

	constructor(botBindings: Pick<BotRuntimeBindings, "runtime">, host: BotChatHost) {
		this.botBindings = botBindings;
		this.host = host;
	}

	private createSyntheticBotSummaryMessage(bot: PersistentBotRecord | undefined, summary: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: `[Prior turn summary]: ${summary}` }],
			api: "anthropic-messages",
			provider: bot?.provider ?? "anthropic",
			model: bot?.modelId ?? "claude-haiku-5-5",
			usage: {
				totalTokens: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			stopReason: "stop",
			timestamp: bot?.lastMessageAt ?? Date.now(),
		};
	}

	/** The bot's chat with the owner: its own session's conversation, after what ran as a worker before or beside it. */
	readBotChatMessages(agentId: string, teamId?: string): AgentMessage[] {
		const normId = normalizeBotOrTeamId(agentId, "agentId");
		const bot = this.host.getBotTeamStore().getBot(normId);
		if (bot?.remote) return this.host.getRemoteHub().chat(normId);
		// A group's chat is the group's own conversation with the bot, still a worker.
		if (teamId) return this.readGroupChatMessages(normId, teamId);
		// Nothing here resolves through this session's bindings or transcripts: another process reads the same chat.
		const history = this.host.botSessions.readHistory(normId);
		let earlier = this.shapedHistory.get(history);
		if (!earlier) {
			earlier = history.runs.reduce<AgentMessage[]>(
				(all, run) => mergeByTime(all, this.shapeWorkerMessages(run.messages) ?? []),
				[],
			);
			this.shapedHistory.set(history, earlier);
		}
		const chat = mergeByTime(earlier, this.host.botSessions.readMessages(normId) ?? []);
		return chat.length === 0 && bot?.lastSummary
			? [this.createSyntheticBotSummaryMessage(bot, bot.lastSummary)]
			: chat;
	}

	/**
	 * A worker conversation's messages as the chat draws them; undefined when it holds nothing the chat shows. A bot that
	 * answers through `submit_report` said its summary: the chat shows those words, not the call.
	 */
	private shapeWorkerMessages(msgs: readonly AgentMessage[]): AgentMessage[] | undefined {
		const filtered = msgs.filter((msg) => {
			if (msg.role !== "user") return true;
			let text = "";
			if (typeof msg.content === "string") {
				text = msg.content;
			} else if (Array.isArray(msg.content)) {
				text = msg.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
			}
			const trimmed = text.trimStart();
			const isSyntheticBirth =
				(trimmed.startsWith("<chat>\n") || trimmed.startsWith("<chat>")) &&
				(trimmed.includes("The view") || trimmed.includes("id+n|"));
			return !isSyntheticBirth;
		});
		if (filtered.length === 0) return undefined;
		const shown: AgentMessage[] = [];
		for (const msg of filtered) {
			if (msg.role === "assistant") {
				shown.push({
					...msg,
					content: msg.content.map((part) => {
						if (part.type === "text") return { ...part, text: botReplyText(part.text) };
						if (part.type === "toolCall" && part.name === SUBMIT_REPORT_TOOL_NAME) {
							const summary: unknown = part.arguments.summary;
							return { type: "text" as const, text: typeof summary === "string" ? summary : "" };
						}
						return part;
					}),
				});
				continue;
			}
			if (msg.role === "toolResult" && msg.toolName === SUBMIT_REPORT_TOOL_NAME) continue;
			if (msg.role !== "user") {
				shown.push(msg);
				continue;
			}
			const control = workerControlOf(msg);
			const text = botChatOperatorText(msg, control);
			if (!control?.body && isModelFacingText(text)) continue;
			// A follow-up reaches the bot twice, as its wake task and as its mailbox message: one line in the chat.
			const previous = shown.at(-1);
			if (previous?.role === "user" && previous.timestamp !== undefined && msg.timestamp !== undefined) {
				const previousText =
					typeof previous.content === "string"
						? previous.content
						: previous.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
				if (previousText === text) continue;
			}
			shown.push({ ...msg, content: [{ type: "text", text }] });
		}
		return shown;
	}

	/** What the bot said in the group's worker conversation, shaped for the chat; the lane and group records when none exists. */
	private readGroupChatMessages(normId: string, teamId: string): AgentMessage[] {
		const team = this.host.getBotTeamStore().getTeam(teamId);
		const runtime = this.botBindings.runtime(normId, teamId, team ? teamIncarnation(team) : undefined);
		const conv = this.host.openWorkerTranscript(runtime);
		if (conv) {
			const shown = this.shapeWorkerMessages(conv.getProviderContext().messages);
			if (shown) return shown;
		}

		const relevantTeamMessages = this.host
			.getBotTeamStore()
			.listTeamMessages(teamId)
			.filter((m) => m.targetAgentIds.includes(normId));
		const laneRecords = this.host.getLaneRecords().filter((r) => r.agentId === runtime || r.laneId === runtime);

		const fallbackMessages: AgentMessage[] = [];
		for (const record of laneRecords) {
			const label = record.label;
			if (label) {
				fallbackMessages.push({
					role: "user",
					content: [{ type: "text", text: label }],
					timestamp: record.startedAt ? new Date(record.startedAt).getTime() : Date.now(),
				});
			}
			if (record.status !== "running" && record.status !== "queued") {
				fallbackMessages.push({
					role: "custom",
					customType: "bot-lane-status",
					content: `[${normId}] ${record.reasonCode ?? `Task ${record.status}`}`,
					display: true,
					timestamp: record.completedAt ? new Date(record.completedAt).getTime() : Date.now(),
				});
			}
		}
		for (const tm of relevantTeamMessages) {
			fallbackMessages.push({
				role: "user",
				content: [{ type: "text", text: `[Team ${tm.teamId}] ${tm.text}` }],
				timestamp: tm.timestamp,
			});
		}
		fallbackMessages.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
		return fallbackMessages;
	}

	readTeamChatMessages(teamId: string): AgentMessage[] {
		const store = this.host.getBotTeamStore();
		const teamMessages = store.listTeamMessages(teamId);
		const result: AgentMessage[] = [];

		for (const msg of teamMessages) {
			// One shape for every speaker: the text as written, and who spoke to whom as fields the chat view draws.
			result.push({
				role: "custom",
				customType: "team-message",
				content: msg.text,
				display: true,
				details: {
					teamId,
					from:
						msg.sender.kind === "bot" ? { kind: "bot", agentId: msg.sender.agentId } : { kind: msg.sender.kind },
					to: [...msg.targetAgentIds],
				},
				timestamp: msg.timestamp,
			});
		}

		result.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
		return result;
	}
}
