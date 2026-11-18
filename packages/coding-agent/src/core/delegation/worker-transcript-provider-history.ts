/** Owns the immutable replay and cache observation projection of a worker's canonical transcript. */

import type { Message } from "@caupulican/pi-ai";
import { countHistoryWork, historyWorkFallback, inheritHistoryWork } from "@caupulican/pi-ai/history-work";
import {
	createVersionedMessageHistory,
	immutableHistoryMessage,
	type MessageHistoryVersion,
	messageHistoryVersion,
} from "../../kernel/message-revision.ts";
import { convertMessage, convertToLlm } from "../../kernel/messages.ts";
import type { SessionContext, SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { addIdleHolderRole, type CacheIdleHolder, compactionLineage } from "../context/cache-observation-recorder.ts";

export class WorkerTranscriptProviderHistory {
	private providerHistory?: {
		source: readonly AgentMessage[];
		through: number;
		messages: Message[];
		version: MessageHistoryVersion | undefined;
	};
	private replaySourceExposed?: SessionManager;
	private providerMessageViews?: WeakMap<AgentMessage, AgentMessage>;
	private responseHistory?: {
		source: readonly AgentMessage[];
		through: number;
		lineage: string;
		holder: CacheIdleHolder;
	};

	ownsReplay(history: readonly Message[] | undefined): boolean {
		return history !== undefined && history === this.providerHistory?.messages;
	}

	/** Resolve current provider-visible messages lazily through SessionManager. */
	inspect(owner: object, sessionManager: SessionManager, persisted: boolean): SessionContext {
		inheritHistoryWork(owner, sessionManager);
		const context = sessionManager.buildSessionContext();
		countHistoryWork(owner, "copiedRows", context.messages.length);
		if (!persisted || this.replaySourceExposed === sessionManager) return context;
		// Canonical persisted rows stay private to the transcript owner. Observers may retain or edit
		// their view without changing the next worker request or what its replay proof describes.
		this.providerMessageViews ??= new WeakMap();
		const views = this.providerMessageViews;
		countHistoryWork(owner, "copiedRows", context.messages.length);
		countHistoryWork(owner, "oldRowsRead", context.messages.length);
		return {
			...context,
			messages: context.messages.map((message) => {
				const detached = views.get(message) ?? immutableHistoryMessage(message);
				if (detached) {
					views.set(message, detached);
					return detached;
				}
				this.replaySourceExposed = sessionManager;
				this.providerMessageViews = undefined;
				this.providerHistory = undefined;
				return message;
			}),
		};
	}

	/** Cache observation inputs for the next assistant, which has not entered the transcript yet. */
	cacheResponseHistory(
		owner: object,
		sessionManager: SessionManager,
		persisted: boolean,
	): { lineage: string; holder: CacheIdleHolder } {
		return sessionManager.readSessionContext(({ messages: source }) => {
			const reusable = persisted && this.replaySourceExposed !== sessionManager;
			let history = reusable ? this.responseHistory : undefined;
			if (!history || history.source !== source) {
				history = { source, through: 0, lineage: "root", holder: "host" };
			}
			for (; history.through < source.length; history.through++) {
				countHistoryWork(owner, "oldRowsRead");
				const message = source[history.through]!;
				if (message.role === "compactionSummary") history.lineage = compactionLineage(message.timestamp);
				history.holder = message.role === "assistant" ? "host" : addIdleHolderRole(history.holder, message.role);
			}
			if (reusable) this.responseHistory = history;
			return { lineage: history.lineage, holder: history.holder };
		});
	}

	/** Replay the detached immutable provider projection, converting only new committed rows. */
	replay(owner: object, sessionManager: SessionManager, persisted: boolean, overlap: boolean): Message[] {
		inheritHistoryWork(owner, sessionManager);
		const cold = (reason: string): Message[] => {
			if (persisted) {
				this.replaySourceExposed = sessionManager;
				this.providerHistory = undefined;
				this.providerMessageViews = undefined;
			}
			historyWorkFallback(owner, reason);
			const context = sessionManager.buildSessionContext();
			countHistoryWork(owner, "copiedRows", context.messages.length);
			countHistoryWork(owner, "oldRowsRead", context.messages.length);
			countHistoryWork(owner, "providerRowsConverted", context.messages.length);
			const messages = convertToLlm(context.messages);
			countHistoryWork(owner, "copiedRows", messages.length);
			inheritHistoryWork(owner, messages);
			return messages;
		};
		if (!persisted || this.replaySourceExposed === sessionManager) return cold("unowned-worker-replay-source");
		if (overlap) return cold("overlapping-worker-replay");
		return sessionManager.readSessionContext(({ messages: source }) => {
			let replay = this.providerHistory;
			if (!replay || replay.source !== source || replay.version !== messageHistoryVersion(replay.messages)) {
				replay = {
					source,
					through: 0,
					messages: createVersionedMessageHistory() as Message[],
					version: undefined,
				};
				this.providerHistory = replay;
			}
			inheritHistoryWork(owner, replay.messages);
			for (; replay.through < source.length; replay.through++) {
				countHistoryWork(replay.messages, "oldRowsRead");
				const converted = convertMessage(source[replay.through]!);
				if (!converted) continue;
				countHistoryWork(replay.messages, "providerRowsConverted");
				const immutable = immutableHistoryMessage(converted);
				if (immutable === undefined) {
					// A cold payload reader or unusual value must remain on the authoritative replay path.
					return cold("unsafe-worker-replay-message");
				}
				replay.messages.push(immutable as Message);
				countHistoryWork(replay.messages, "copiedRows");
			}
			replay.version = messageHistoryVersion(replay.messages);
			return replay.messages;
		});
	}
}
