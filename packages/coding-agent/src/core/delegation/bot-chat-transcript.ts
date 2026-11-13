/**
 * The chat an operator reads for a bot or a group: a bot's own session conversation with the owner, with the bot's earlier
 * worker conversations (what ran as a worker before the bot had a session of its own, and the sends that still run as
 * workers: the home's history index finds them in any session, the open session's own runtime is read live) shaped into
 * the messages the chat view draws and merged in by time, the remote hub's chat for a machine joined
 * over the link, the lane and group records as the fallback when no conversation exists, and a group's own message log. It
 * reads through the ports the coordinator gives it and never builds a worker, a store or a hub itself.
 */
import type { AssistantMessage } from "@caupulican/pi-ai";
import { parseWorkerTranscriptReference } from "../../kernel/session/worker-transcript-reference.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { workerControlOf } from "../../kernel/worker-control-stamp.ts";
import { isModelFacingText } from "../../presentation/plain-text.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { BotSessionHost } from "../bots/bot-session-host.ts";
import type { RemoteHubController } from "../remote/hub-controller.ts";
import type { BotRuntimeBindings } from "./bot-runtime-bindings.ts";
import {
	botChatOperatorText,
	botReplyText,
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
		if (this.host.getBotTeamStore().getBot(normId)?.remote) return this.host.getRemoteHub().chat(normId);
		// A group's chat is the group's own conversation with the bot, still a worker.
		if (teamId) return this.readWorkerChatMessages(normId, teamId, false);
		const own = this.host.botSessions.readMessages(normId);
		const history = this.host.botSessions.readHistory(normId);
		const earlier = history.runs.reduce<AgentMessage[]>(
			(all, run) => mergeByTime(all, this.shapeWorkerMessages(run.messages) ?? []),
			[],
		);
		// A runtime the home's index already holds is read from there, not twice.
		const worker = this.readWorkerChatMessages(
			normId,
			undefined,
			own === undefined && earlier.length === 0,
			new Set(history.runs.map((run) => run.runtime)),
		);
		const before = mergeByTime(earlier, worker);
		return own ? mergeByTime(before, own) : before;
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

	/**
	 * What the bot's worker runtime said, shaped for the chat; the last summary stands in when `withSummary` and nothing else
	 * exists. A direct conversation's runtime that `indexed` already holds (the history reads it) shows nothing here.
	 */
	private readWorkerChatMessages(
		normId: string,
		teamId: string | undefined,
		withSummary: boolean,
		indexed?: ReadonlySet<string>,
	): AgentMessage[] {
		const team = teamId ? this.host.getBotTeamStore().getTeam(teamId) : undefined;
		const runtime = this.botBindings.runtime(normId, teamId, team ? teamIncarnation(team) : undefined);
		if (!teamId && indexed?.has(runtime)) return [];
		let conv = this.host.openWorkerTranscript(runtime);
		const bot = this.host.getBotTeamStore().getBot(normId);
		const lastRuntime = bot?.lastTranscriptRef
			? parseWorkerTranscriptReference(bot.lastTranscriptRef)?.logicalAgentId
			: undefined;
		if (!teamId && !conv && bot?.lastTranscriptRef && !(lastRuntime !== undefined && indexed?.has(lastRuntime))) {
			conv = this.host.openWorkerTranscript(bot.lastTranscriptRef);
		}
		if (conv) {
			const shown = this.shapeWorkerMessages(conv.getProviderContext().messages);
			if (shown) return shown;
		}

		const store = this.host.getBotTeamStore();
		const memberTeamIds = teamId ? [teamId] : [];
		const relevantTeamMessages = memberTeamIds.flatMap((tId) =>
			store.listTeamMessages(tId).filter((m) => m.targetAgentIds.includes(normId)),
		);
		const laneRecords = this.host.getLaneRecords().filter((r) => r.agentId === runtime || r.laneId === runtime);

		if (relevantTeamMessages.length === 0 && laneRecords.length === 0) {
			return withSummary && !teamId && bot?.lastSummary
				? [this.createSyntheticBotSummaryMessage(bot, bot.lastSummary)]
				: [];
		}

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
		if (withSummary && !teamId && fallbackMessages.length === 0 && bot?.lastSummary) {
			fallbackMessages.push(this.createSyntheticBotSummaryMessage(bot, bot.lastSummary));
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
