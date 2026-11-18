/** Bounded, session-local provider history retained only from accepted native requests. */

import type { Api, AssistantMessage, Context, Message, Model } from "@caupulican/pi-ai";
import type { AgentContextPlan, AgentProviderHistoryPlan, ProviderHistoryCandidate } from "../../kernel/loop-config.ts";
import { convertToLlm } from "../../kernel/messages.ts";
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

export interface ProviderHistoryContinuation {
	/** The proven current handoff and the pinned view rows that account for its new chat work. */
	readonly work?: { readonly text: string; isCurrent(): boolean };
}

export interface ProviderHistoryRetentionSource {
	proveContinuation(
		previous: IcmTurnHandle,
		next: IcmTurnHandle,
		history: readonly AgentMessage[],
		handoff: AgentMessage | undefined,
	): ProviderHistoryContinuation | undefined;
	readLiveHandoffAttempts?(message: AgentMessage): readonly string[] | undefined;
	allowsHistoryTokens?(model: Model<Api>, tokens: number): boolean;
}

export interface ProviderHistoryFrame {
	headMessages: number;
	legend?: readonly PathAliasLegendEntry[];
	bodyAliases(handoff: AgentMessage | undefined): readonly PathAliasLegendEntry[] | undefined;
	verifyAliases: AgentContextPlan["verifyPathAliases"];
}

interface HandoffEvidence {
	readonly attemptIds: readonly string[];
	isCurrent(): boolean;
}

interface HistoryOffer {
	messages: Message[];
	requestOnly: ProviderHistoryCandidate["requestOnly"];
	frameLength: number;
	handoffs: readonly HandoffEvidence[];
	model: Model<Api>;
	tokens: number;
}

interface AcceptedRequest {
	handle: IcmTurnHandle;
	dependencies: ContinuousChatMessageDependencies;
	handoffs: readonly HandoffEvidence[];
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

function captureHandoff(source: ProviderHistoryRetentionSource, message: AgentMessage): HandoffEvidence | undefined {
	try {
		const attemptIds = source.readLiveHandoffAttempts?.(message)?.slice();
		if (!attemptIds?.length || attemptIds.length >= MAX_RETAINED_MESSAGES) return undefined;
		return {
			attemptIds,
			isCurrent: () => {
				const current = source.readLiveHandoffAttempts?.(message);
				return current?.length === attemptIds.length && attemptIds.every((id, index) => id === current[index]);
			},
		};
	} catch {
		return undefined;
	}
}

function bindHandoffWork(
	opening: HandoffEvidence,
	work: NonNullable<ProviderHistoryContinuation["work"]>,
): HandoffEvidence {
	return { attemptIds: opening.attemptIds, isCurrent: () => opening.isCurrent() && work.isCurrent() };
}

function handoffsCurrent(handoffs: readonly HandoffEvidence[]): boolean {
	try {
		return handoffs.every((handoff) => handoff.isCurrent());
	} catch {
		return false;
	}
}

function uniqueHandoffAttempts(handoffs: readonly HandoffEvidence[]): boolean {
	const attempts = new Set<string>();
	for (const { attemptIds } of handoffs) {
		for (const attempt of attemptIds) {
			if (attempts.size >= MAX_RETAINED_MESSAGES || attempts.has(attempt)) return false;
			attempts.add(attempt);
		}
	}
	return true;
}

function indexedAliases(aliases: ReadonlyMap<string, string>): PathAliasLegendEntry[] {
	return [...aliases].map(([id, path]) => ({ id, path }));
}

export class ContinuousChatProviderHistory {
	private readonly source: ProviderHistoryRetentionSource;
	private accepted: AcceptedRequest | undefined;
	private active: { handle: IcmTurnHandle; previous: PreviousTurn | undefined } | undefined;

	constructor(source: ProviderHistoryRetentionSource) {
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
		let continuation: ProviderHistoryContinuation | undefined;
		let handoff: HandoffEvidence | undefined;
		const opening = messages[start];
		const durableOpening = opening && sourceMessage ? sourceMessage(opening) : opening;
		const handoffEvidence = (retain?: PreviousTurn): readonly HandoffEvidence[] => {
			const prior = retain?.request.handoffs ?? [];
			if (!handoff) return prior;
			return [...prior, retain && continuation?.work ? bindHandoffWork(handoff, continuation.work) : handoff];
		};
		const fixedHeadMessages = frame.headMessages - (frame.legend ? 1 : 0);
		const aliasesCurrent = (aliases: readonly PathAliasLegendEntry[]): boolean => {
			try {
				return aliases.length === 0 || frame.verifyAliases?.(aliases) === true;
			} catch {
				return false;
			}
		};
		const prove = (): ProviderHistoryContinuation | undefined => {
			if (
				!previous?.request.dependencies.isCurrent() ||
				previous.request.handle.latestCompaction !== undefined ||
				!dependencies.complete ||
				!canUseHistory() ||
				handle.latestCompaction !== undefined
			)
				return undefined;
			try {
				const aliases = previous.request.aliases;
				if (
					!aliasesCurrent(aliases) ||
					(aliases.length > 0 && previous.request.verifyAliases?.(aliases) !== true) ||
					(offeredAliases !== undefined && !aliasesCurrent(offeredAliases)) ||
					(selected !== undefined && !this.tokensAllowed(selected.model, selected.tokens))
				)
					return undefined;
				return this.source.proveContinuation(
					previous.request.handle,
					handle,
					previous.history,
					handoff ? durableOpening : undefined,
				);
			} catch {
				return undefined;
			}
		};
		const authorized = (): boolean => {
			const current = prove();
			return current !== undefined && current.work?.text === continuation?.work?.text;
		};

		return {
			trackDependencies: (messages) => dependencies.add(messages),
			offer: (candidate) => {
				selected = undefined;
				offeredAliases = undefined;
				continuation = undefined;
				handoff = undefined;
				if (!dependencies.complete || !dependencies.isCurrent() || !canUseHistory() || !candidate.nativeHistory)
					return undefined;
				const openingEvidence = durableOpening && captureHandoff(this.source, durableOpening);
				if (durableOpening && openingEvidence) {
					const { start, count } = candidate.requestOnly;
					const wire = candidate.context.messages[start + count];
					if (
						!wire ||
						wire.timestamp !== durableOpening.timestamp ||
						!equalWireMessages([wire], convertToLlm([durableOpening]))
					)
						return undefined;
					handoff = openingEvidence;
				}
				const bodyAliases = frame.bodyAliases(handoff ? durableOpening : undefined);
				if (!bodyAliases) return undefined;
				const tail = replayableBodyAliases(candidate.transientTail, true);
				if (!tail) return undefined;
				const aliases = [...(frame.legend ?? []), ...bodyAliases, ...tail];
				const local = mergeRetainedAliases([], aliases);
				if (!local || !aliasesCurrent(aliases)) return undefined;
				offeredAliases = indexedAliases(local);
				continuation = prove();
				if (!previous || !continuation) return undefined;
				const handoffs = handoffEvidence(previous);
				if (!uniqueHandoffAttempts(handoffs) || !handoffsCurrent(handoffs)) return undefined;
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
					continuation,
					handoffs,
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
				handoffsCurrent(selected?.handoffs ?? handoffEvidence()) &&
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
				const handoffs = retained?.handoffs ?? handoffEvidence();
				if (!handoffsCurrent(handoffs)) return;
				committed = {
					handle,
					dependencies: retainedDependencies,
					handoffs,
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
					!handoffsCurrent(committed.handoffs) ||
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
		continuation: ProviderHistoryContinuation,
		handoffs: HistoryOffer["handoffs"],
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
							...(continuation.work ? [{ type: "text" as const, text: continuation.work.text }] : []),
						],
					}
				: state;
		const messages: Message[] = [...previous.request.messages, previous.terminal.wire, turnState];
		if (additions.length > 0) {
			messages.push({
				role: "user",
				content: [{ type: "text", text: renderRetainedAliasAdditions(additions) }],
				timestamp: state.timestamp,
			});
		}
		const frameLength = messages.length;
		for (let index = end; index < fresh.messages.length; index++) messages.push(fresh.messages[index]!);
		const context = { ...fresh, messages };
		const tokens = this.eligibleTokens(candidate, context);
		return tokens === undefined
			? undefined
			: {
					messages: context.messages,
					requestOnly: previous.request.requestOnly,
					frameLength,
					handoffs,
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
