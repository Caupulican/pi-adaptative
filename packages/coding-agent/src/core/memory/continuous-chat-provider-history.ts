/** Bounded, session-local provider history retained only from accepted native requests. */

import type { Api, AssistantMessage, Context, Message, Model } from "@caupulican/pi-ai";
import type { AgentContextPlan, AgentProviderHistoryPlan, ProviderHistoryCandidate } from "../../kernel/loop-config.ts";
import { estimateProviderRequestTokens } from "../../kernel/provider-request-estimator.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import type { PathAliasLegendEntry } from "../comms/host-injection-records.ts";
import {
	mergeRetainedAliases,
	renderRetainedAliasAdditions,
	replayableBodyAliases,
} from "./continuous-chat-history-aliases.ts";
import { ContinuousChatMessageDependencies, MAX_RETAINED_MESSAGES } from "./continuous-chat-message-dependencies.ts";
import type { IcmTurnHandle } from "./continuous-chat-turn-coordinator.ts";

const MAX_HISTORY_INPUT_TOKENS = 48_000;

interface RetentionSource {
	canRetain(previous: IcmTurnHandle, next: IcmTurnHandle, history: readonly AgentMessage[]): boolean;
	allowsHistoryTokens?(model: Model<Api>, tokens: number): boolean;
}

export interface ProviderHistoryFrame {
	headMessages: number;
	legend?: readonly PathAliasLegendEntry[];
	bodyAliases?: readonly PathAliasLegendEntry[];
	verifyAliases: AgentContextPlan["verifyPathAliases"];
}

interface HistoryOffer {
	messages: Message[];
	requestOnly: ProviderHistoryCandidate["requestOnly"];
	frameLength: number;
	model: Model<Api>;
	tokens: number;
}

interface AcceptedRequest {
	handle: IcmTurnHandle;
	dependencies: ContinuousChatMessageDependencies;
	envelope: ProviderHistoryCandidate;
	requestOnly: ProviderHistoryCandidate["requestOnly"];
	fixedHeadMessages: number;
	aliases: readonly PathAliasLegendEntry[];
	verifyAliases: ProviderHistoryFrame["verifyAliases"];
	messages: readonly Message[];
	terminal?: { wire: AssistantMessage; durable: AssistantMessage };
}

interface PreviousTurn {
	request: AcceptedRequest;
	terminal: NonNullable<AcceptedRequest["terminal"]>;
	history: readonly AgentMessage[];
}

interface RetentionPlan extends AgentProviderHistoryPlan {
	isCurrent(): boolean;
}

function equalJson(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

function comparableWireMessage(message: Message, ignoreBoundary: boolean): unknown {
	const { timestamp: _timestamp, ...body } = message;
	if (!ignoreBoundary || body.role !== "user" || typeof body.content === "string") return body;
	const content = body.content.map((block) => {
		if (block.type !== "text") return block;
		const { cacheBoundary: _cacheBoundary, ...text } = block;
		return text;
	});
	return { ...body, content };
}

function equalWireMessages(left: readonly Message[], right: readonly Message[], ignoreBoundary = false): boolean {
	return (
		left.length === right.length &&
		left.every((message, index) =>
			equalJson(
				comparableWireMessage(message, ignoreBoundary),
				comparableWireMessage(right[index]!, ignoreBoundary),
			),
		)
	);
}

function sameEnvelope(previous: ProviderHistoryCandidate, next: ProviderHistoryCandidate): boolean {
	const a = previous.model;
	const b = next.model;
	return (
		previous.accountKey !== undefined &&
		previous.accountKey === next.accountKey &&
		a.provider === b.provider &&
		a.api === b.api &&
		a.id === b.id &&
		a.baseUrl === b.baseUrl &&
		previous.context.systemPrompt === next.context.systemPrompt &&
		equalJson(previous.context.tools, next.context.tools)
	);
}

function hasImages(messages: readonly Message[]): boolean {
	return messages.some(
		(message) => Array.isArray(message.content) && message.content.some((block) => block.type === "image"),
	);
}

function sameTerminal(provider: AssistantMessage, final: AssistantMessage, model: Model<Api>): boolean {
	return (
		provider.stopReason === "stop" &&
		final.stopReason === "stop" &&
		provider.provider === model.provider &&
		provider.api === model.api &&
		provider.model === model.id &&
		provider.provider === final.provider &&
		provider.api === final.api &&
		provider.model === final.model &&
		provider.responseId === final.responseId &&
		!provider.content.some((block) => block.type === "toolCall") &&
		equalJson(provider.content, final.content)
	);
}

function indexedAliases(aliases: ReadonlyMap<string, string>): PathAliasLegendEntry[] {
	return [...aliases].map(([id, path]) => ({ id, path }));
}

export class ContinuousChatProviderHistory {
	private readonly source: RetentionSource;
	private accepted: AcceptedRequest | undefined;
	private active: { handle: IcmTurnHandle; previous: PreviousTurn | undefined } | undefined;

	constructor(source: RetentionSource) {
		this.source = source;
	}

	plan(
		handle: IcmTurnHandle,
		messages: readonly AgentMessage[],
		start: number,
		sourceMessage: ((message: AgentMessage) => AgentMessage) | undefined,
		frame: ProviderHistoryFrame,
		dependencies: ContinuousChatMessageDependencies,
		canUseHistory: () => boolean,
		noteFrame: (frame: readonly AgentMessage[], lineageStartedAt?: number) => void,
	): RetentionPlan {
		const previous =
			this.active?.handle === handle
				? this.active.previous
				: this.previousTurn(handle, messages, start, sourceMessage);
		let selected: HistoryOffer | undefined;
		let offeredAliases: readonly PathAliasLegendEntry[] | undefined;
		let committed: AcceptedRequest | undefined;
		const fixedHeadMessages = frame.headMessages - (frame.legend ? 1 : 0);
		const aliasesCurrent = (aliases: readonly PathAliasLegendEntry[]): boolean => {
			try {
				return aliases.length === 0 || frame.verifyAliases?.(aliases) === true;
			} catch {
				return false;
			}
		};
		const authorized = (): boolean => {
			if (
				!previous?.request.dependencies.isCurrent() ||
				previous.request.handle.latestCompaction !== undefined ||
				!dependencies.complete ||
				!canUseHistory() ||
				handle.latestCompaction !== undefined
			)
				return false;
			try {
				const aliases = previous.request.aliases;
				return (
					aliasesCurrent(aliases) &&
					(aliases.length === 0 || previous.request.verifyAliases?.(aliases) === true) &&
					(offeredAliases === undefined || aliasesCurrent(offeredAliases)) &&
					(selected === undefined || this.tokensAllowed(selected.model, selected.tokens)) &&
					this.source.canRetain(previous.request.handle, handle, previous.history)
				);
			} catch {
				return false;
			}
		};

		return {
			trackDependencies: (messages) => dependencies.add(messages),
			offer: (candidate) => {
				selected = undefined;
				offeredAliases = undefined;
				if (
					!dependencies.complete ||
					!dependencies.isCurrent() ||
					!canUseHistory() ||
					!candidate.nativeHistory ||
					!frame.bodyAliases
				)
					return undefined;
				const tail = replayableBodyAliases(candidate.transientTail, true);
				if (!tail) return undefined;
				const aliases = [...(frame.legend ?? []), ...frame.bodyAliases, ...tail];
				const local = mergeRetainedAliases([], aliases);
				if (!local || !aliasesCurrent(aliases)) return undefined;
				offeredAliases = indexedAliases(local);
				if (!previous || !authorized()) return undefined;
				const priorMappings = mergeRetainedAliases([], previous.request.aliases)!;
				const merged = mergeRetainedAliases(previous.request.aliases, offeredAliases);
				if (!merged) return undefined;
				const additions = (frame.legend ?? []).filter(({ id }) => !priorMappings.has(id));
				selected = this.extend(
					previous,
					candidate,
					frame,
					fixedHeadMessages,
					additions,
					handle.boundary.totalMessages,
				);
				if (selected) {
					dependencies.add(selected.messages.slice(previous.request.messages.length + 1, selected.frameLength));
					if (!dependencies.complete) {
						selected = undefined;
						return undefined;
					}
					offeredAliases = indexedAliases(merged);
				}
				return selected;
			},
			isCurrent: () =>
				dependencies.isCurrent() &&
				(selected ? authorized() : offeredAliases === undefined || aliasesCurrent(offeredAliases)),
			accept: (candidate, messages) => {
				const retained = selected?.messages === messages ? selected : undefined;
				this.active = { handle, previous: retained ? previous : undefined };
				committed = undefined;
				this.accepted = undefined;
				if (retained && previous) {
					noteFrame(messages.slice(0, retained.frameLength), previous.request.handle.lineageStartedAt);
				} else noteFrame([]);
				if (
					!canUseHistory() ||
					!dependencies.complete ||
					!dependencies.isCurrent() ||
					handle.latestCompaction ||
					!candidate.nativeHistory ||
					!offeredAliases ||
					!aliasesCurrent(offeredAliases) ||
					(!retained && this.eligibleTokens(candidate, candidate.context) === undefined)
				)
					return;
				const { start, count } = candidate.requestOnly;
				const envelope = {
					...candidate,
					transientTail: [],
					context: { ...candidate.context, messages: candidate.context.messages.slice(0, start + count) },
				};
				const retainedDependencies = new ContinuousChatMessageDependencies();
				if (retained && previous) retainedDependencies.include(previous.request.dependencies);
				retainedDependencies.include(dependencies);
				retainedDependencies.add(messages);
				if (!retainedDependencies.complete || !retainedDependencies.isCurrent()) return;
				committed = {
					handle,
					dependencies: retainedDependencies,
					envelope,
					requestOnly: retained?.requestOnly ?? candidate.requestOnly,
					fixedHeadMessages,
					aliases: offeredAliases,
					verifyAliases: frame.verifyAliases,
					messages: messages.slice(),
				};
				this.accepted = committed;
			},
			observeAssistant: (provider, final) => {
				if (
					!committed ||
					this.accepted !== committed ||
					!committed.dependencies.isCurrent() ||
					!sameTerminal(provider, final, committed.envelope.model)
				)
					return;
				committed.dependencies.add([provider, final]);
				if (committed.dependencies.complete) committed.terminal = { wire: provider, durable: final };
			},
		};
	}

	private previousTurn(
		handle: IcmTurnHandle,
		messages: readonly AgentMessage[],
		start: number,
		sourceMessage: ((message: AgentMessage) => AgentMessage) | undefined,
	): PreviousTurn | undefined {
		const request = this.accepted;
		const terminal = request?.terminal;
		const first = request?.handle.startMessage;
		if (
			!request ||
			!terminal ||
			!first ||
			request.handle.latestCompaction ||
			request.handle.turnId + 1 !== handle.turnId
		)
			return undefined;
		if (messages[start - 1] !== terminal.durable) return undefined;
		for (let index = start - 1, count = 1; index >= 0 && count <= MAX_RETAINED_MESSAGES; index--, count++) {
			if (messages[index] !== first) continue;
			const history = messages.slice(index, start);
			return { request, terminal, history: sourceMessage ? history.map(sourceMessage) : history };
		}
		return undefined;
	}

	private extend(
		previous: PreviousTurn,
		candidate: ProviderHistoryCandidate,
		frame: ProviderHistoryFrame,
		fixedHeadMessages: number,
		additions: readonly PathAliasLegendEntry[],
		endId: number,
	): HistoryOffer | undefined {
		const fresh = candidate.context;
		const old = previous.request.envelope;
		const start = candidate.requestOnly.start;
		const end = start + candidate.requestOnly.count;
		const oldStart = old.requestOnly.start;
		const state = fresh.messages[frame.headMessages + 1];
		if (
			!sameEnvelope(old, candidate) ||
			start !== frame.headMessages + 2 ||
			previous.request.fixedHeadMessages !== fixedHeadMessages ||
			state?.role !== "user" ||
			!equalWireMessages(
				old.context.messages.slice(0, fixedHeadMessages),
				fresh.messages.slice(0, fixedHeadMessages),
				true,
			) ||
			!equalWireMessages(
				old.context.messages.slice(oldStart, oldStart + old.requestOnly.count),
				fresh.messages.slice(start, end),
			)
		)
			return undefined;
		const firstId = previous.request.handle.boundary.totalMessages;
		const content =
			typeof state.content === "string" ? [{ type: "text" as const, text: state.content }] : state.content;
		const turnState =
			firstId < endId
				? {
						...state,
						content: [
							...content,
							{ type: "text" as const, text: `Previous turn: chat IDs ${firstId} through ${endId - 1}.` },
						],
					}
				: state;
		const head: Message[] = [...previous.request.messages, previous.terminal.wire, turnState];
		if (additions.length > 0) {
			head.push({
				role: "user",
				content: [{ type: "text", text: renderRetainedAliasAdditions(additions) }],
				timestamp: state.timestamp,
			});
		}
		const context = { ...fresh, messages: [...head, ...fresh.messages.slice(end)] };
		const tokens = this.eligibleTokens(candidate, context);
		return tokens === undefined
			? undefined
			: {
					messages: context.messages,
					requestOnly: previous.request.requestOnly,
					frameLength: head.length,
					model: candidate.model,
					tokens,
				};
	}

	private eligibleTokens(candidate: ProviderHistoryCandidate, context: Context): number | undefined {
		if (
			!candidate.nativeHistory ||
			candidate.accountKey === undefined ||
			context.messages.length >= MAX_RETAINED_MESSAGES ||
			hasImages(context.messages)
		)
			return undefined;
		const tokens = estimateProviderRequestTokens(context, candidate.model);
		return this.tokensAllowed(candidate.model, tokens) ? tokens : undefined;
	}

	private tokensAllowed(model: Model<Api>, tokens: number): boolean {
		return (
			tokens <= MAX_HISTORY_INPUT_TOKENS &&
			(this.source.allowsHistoryTokens?.(model, tokens) ?? tokens <= model.contextWindow / 3)
		);
	}
}
