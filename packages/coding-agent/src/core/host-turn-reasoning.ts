/**
 * Request-local reasoning policy for turns the HOST starts by itself.
 *
 * A background tool or a delegated worker finishing does not wait for the operator: the session
 * delivers a `role: "custom"` completion message and starts a turn on it. The expected work in that
 * turn's FIRST request is bookkeeping - read the delivered result, cite it, continue - yet it ran at
 * the full session thinking level, the same effort the operator chose for their own hard questions.
 *
 * This module decides one request's effort and nothing else. It never mutates session state, never
 * raises effort above the session level, and never touches a turn the operator or the model drives.
 * The resolution is a pure function so the ladder arithmetic is testable without a provider.
 */

import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { Api, Model, ModelThinkingLevel } from "@caupulican/pi-ai";
import { getSupportedThinkingLevels } from "@caupulican/pi-ai/models";
import { REASONING_LADDER, type ReasoningEffortMap, type ReasoningLevel } from "./cost-guard.ts";
import type { ThinkingLevel } from "./settings-manager.ts";

/**
 * The completion messages the host delivers on its own initiative. Both carry a finished result the
 * next request only has to read; neither is a question the operator asked.
 */
export const HOST_TURN_CUSTOM_TYPES = ["background-tool-completion", "background-worker-completion"] as const;

export type HostTurnCustomType = (typeof HOST_TURN_CUSTOM_TYPES)[number];

export type HostTurnThinkingSetting = ThinkingLevel | "inherit" | undefined;

/**
 * Tools whose calls are bookkeeping: they record or read the harness's own state (goal lifecycle,
 * task steps) and never touch the workspace. A request that only answers their results is a
 * continuation of bookkeeping, not the operator's question: it reads a receipt and moves on.
 */
export const BOOKKEEPING_TOOL_NAMES: ReadonlySet<string> = new Set([
	"goal",
	"create_goal",
	"get_goal",
	"update_goal",
	"task_steps",
]);

/** Which cheap-turn rule matched a request. */
export type CheapTurnKind = "host-turn" | "bookkeeping";

/** One resolved decision, retained for the usage report exactly like the cost guard's. */
export interface HostTurnReasoningDecision {
	kind: CheapTurnKind;
	/** The host completion the request answers (host-turn rule). */
	customType?: HostTurnCustomType;
	/** The bookkeeping tools whose results the request answers (bookkeeping rule). */
	tools?: readonly string[];
	sessionLevel: ModelThinkingLevel;
	resolvedLevel: ModelThinkingLevel;
	/** False when the policy resolved to the session level itself (`"inherit"`, or a floor/clamp no-op). */
	lowered: boolean;
}

/** Both rules' settings; the controller reads them live so an edit applies to the next request. */
export interface CheapTurnSettings {
	hostTurn: HostTurnThinkingSetting;
	bookkeeping: HostTurnThinkingSetting;
}

/** The floor the default policy never goes below: a bookkeeping turn still has to read and cite. */
const DEFAULT_FLOOR: ReasoningLevel = "low";

/** Ascending cost order; `REASONING_LADDER` is descending and is the one source both share. */
function rank(level: string): number {
	const index = REASONING_LADDER.indexOf(level as ReasoningLevel);
	return index < 0 ? -1 : REASONING_LADDER.length - 1 - index;
}

/**
 * Which host completion, if any, this request is answering. Deliberately reads the DURABLE agent
 * messages, not the wire context: `convertToLlm` turns every custom message into a plain `user`
 * message before transport, so the wire has no `customType` left to recognize.
 */
export function hostTurnCustomType(sourceMessages: readonly AgentMessage[]): HostTurnCustomType | undefined {
	const last = sourceMessages.at(-1);
	if (last?.role !== "custom") return undefined;
	return HOST_TURN_CUSTOM_TYPES.find((candidate) => candidate === last.customType);
}

/**
 * The bookkeeping tools whose results this request answers, or undefined. The request's last
 * messages must be tool results, and the assistant message they answer must have called ONLY
 * bookkeeping tools: a message that mixed a `task_steps` update with a real edit is real work.
 */
export function bookkeepingContinuationTools(sourceMessages: readonly AgentMessage[]): string[] | undefined {
	let index = sourceMessages.length - 1;
	const answered: string[] = [];
	while (index >= 0 && sourceMessages[index]?.role === "toolResult") {
		const result = sourceMessages[index] as { toolName?: string };
		if (typeof result.toolName === "string") answered.push(result.toolName);
		index -= 1;
	}
	if (answered.length === 0) return undefined;
	const assistant = sourceMessages[index];
	if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) return undefined;
	const called = assistant.content.flatMap((block) =>
		block.type === "toolCall" && typeof block.name === "string" ? [block.name] : [],
	);
	if (called.length === 0) return undefined;
	if (!called.every((name) => BOOKKEEPING_TOOL_NAMES.has(name))) return undefined;
	if (!answered.every((name) => BOOKKEEPING_TOOL_NAMES.has(name))) return undefined;
	return [...new Set(called)];
}

/** The highest supported level at or below `desiredRank`; the cheapest supported one when none qualifies. */
function supportedAtOrBelow(desiredRank: number, supportedLevels: readonly ModelThinkingLevel[]): ModelThinkingLevel {
	let best: ModelThinkingLevel | undefined;
	let cheapest: ModelThinkingLevel | undefined;
	for (const level of supportedLevels) {
		const levelRank = rank(level);
		if (levelRank < 0) continue;
		if (cheapest === undefined || levelRank < rank(cheapest)) cheapest = level;
		if (levelRank <= desiredRank && (best === undefined || levelRank > rank(best))) best = level;
	}
	return best ?? cheapest ?? "off";
}

/**
 * Resolve the effort for one host turn.
 *
 * - unset: one rung below the session level, floored at `"low"`, never above the session level - so a
 *   session at `"low"`, `"minimal"` or `"off"` keeps exactly what it had.
 * - `"inherit"`: the session level unchanged.
 * - an explicit level: that level, clamped to at most the session level.
 *
 * `supportedLevels` narrows the result to what the model actually offers (an unsupported level would
 * be silently re-mapped by the provider, possibly upward); `effortMap` lets two rungs that resolve to
 * the same provider effort count as one, so "one level below" is a real reduction.
 */
export function resolveHostTurnThinkingLevel(
	sessionLevel: ModelThinkingLevel,
	setting: HostTurnThinkingSetting,
	supportedLevels?: readonly ModelThinkingLevel[],
	effortMap?: ReasoningEffortMap,
): ModelThinkingLevel {
	const sessionRank = rank(sessionLevel);
	if (sessionRank < 0 || setting === "inherit") return sessionLevel;
	const levels = supportedLevels && supportedLevels.length > 0 ? supportedLevels : REASONING_LADDER;
	const desiredRank =
		setting === undefined
			? Math.min(sessionRank, Math.max(rank(oneRungBelow(sessionLevel, levels, effortMap)), rank(DEFAULT_FLOOR)))
			: Math.min(sessionRank, rank(setting));
	if (desiredRank < 0) return sessionLevel;
	return supportedAtOrBelow(desiredRank, levels);
}

/**
 * The next cheaper rung the model really distinguishes: a rung whose mapped provider effort equals
 * the current one is not a step down, so it is skipped rather than reported as a reduction.
 */
function oneRungBelow(
	level: ModelThinkingLevel,
	supportedLevels: readonly ModelThinkingLevel[],
	effortMap: ReasoningEffortMap | undefined,
): ModelThinkingLevel {
	const currentEffort = effectiveEffort(level, effortMap);
	let best: ModelThinkingLevel | undefined;
	const currentRank = rank(level);
	for (const candidate of supportedLevels) {
		const candidateRank = rank(candidate);
		if (candidateRank < 0 || candidateRank >= currentRank) continue;
		if (effectiveEffort(candidate, effortMap) === currentEffort) continue;
		if (best === undefined || candidateRank > rank(best)) best = candidate;
	}
	return best ?? level;
}

function effectiveEffort(level: ModelThinkingLevel, effortMap: ReasoningEffortMap | undefined): string | null {
	const mapped = effortMap?.[level as ReasoningLevel];
	return mapped === undefined ? level : mapped;
}

/**
 * Resolve one request, or return undefined when the policy does not apply (not a host turn, or no
 * session reasoning to lower). Pure: the caller owns both the decision record and the applied value.
 */
export function resolveHostTurnRequestReasoning(input: {
	sourceMessages: readonly AgentMessage[];
	sessionLevel: ModelThinkingLevel | undefined;
	setting: HostTurnThinkingSetting;
	supportedLevels?: readonly ModelThinkingLevel[];
	effortMap?: ReasoningEffortMap;
}): HostTurnReasoningDecision | undefined {
	const customType = hostTurnCustomType(input.sourceMessages);
	if (!customType || input.sessionLevel === undefined) return undefined;
	const resolvedLevel = resolveHostTurnThinkingLevel(
		input.sessionLevel,
		input.setting,
		input.supportedLevels,
		input.effortMap,
	);
	return {
		kind: "host-turn",
		customType,
		sessionLevel: input.sessionLevel,
		resolvedLevel,
		lowered: resolvedLevel !== input.sessionLevel,
	};
}

/**
 * Resolve a bookkeeping continuation: the request that answers only `goal` / `task_steps` results.
 *
 * - unset: `"low"`, clamped to at most the session level (a session already at or below `low` is
 *   left alone). A receipt needs reading and citing, not deliberation; the request after the next
 *   real tool result is back at the session level.
 * - `"inherit"`: the session level unchanged (the policy is off).
 * - an explicit level: that level, clamped to at most the session level.
 */
export function resolveBookkeepingRequestReasoning(input: {
	sourceMessages: readonly AgentMessage[];
	sessionLevel: ModelThinkingLevel | undefined;
	setting: HostTurnThinkingSetting;
	supportedLevels?: readonly ModelThinkingLevel[];
	effortMap?: ReasoningEffortMap;
}): HostTurnReasoningDecision | undefined {
	const tools = bookkeepingContinuationTools(input.sourceMessages);
	if (!tools || input.sessionLevel === undefined) return undefined;
	const resolvedLevel = resolveHostTurnThinkingLevel(
		input.sessionLevel,
		input.setting === undefined ? DEFAULT_FLOOR : input.setting,
		input.supportedLevels,
		input.effortMap,
	);
	return {
		kind: "bookkeeping",
		tools,
		sessionLevel: input.sessionLevel,
		resolvedLevel,
		lowered: resolvedLevel !== input.sessionLevel,
	};
}

/**
 * Stateful owner of the policy, shaped like `CostGuardController`: it decides one request and
 * retains only the latest decision plus a cumulative count, so a session census can answer "how many
 * turns ran cheap" without re-reading the transcript. Best-effort - it never fails a provider call.
 */
export class HostTurnReasoningController {
	private readonly getSettings: () => CheapTurnSettings;
	private lastDecision: HostTurnReasoningDecision | undefined;
	private loweredRequests = 0;

	constructor(getSettings: () => CheapTurnSettings) {
		this.getSettings = getSettings;
	}

	/** Latest host-turn decision for the host UI/report. Undefined until one host turn has run. */
	getLastDecision(): HostTurnReasoningDecision | undefined {
		return this.lastDecision;
	}

	/** How many provider requests this session has lowered. The census counter. */
	getLoweredRequestCount(): number {
		return this.loweredRequests;
	}

	resolveRequestReasoning(
		model: Model<Api>,
		sourceMessages: readonly AgentMessage[],
		reasoning: ModelThinkingLevel | undefined,
	): ModelThinkingLevel | undefined {
		try {
			const settings = this.getSettings();
			const shared = {
				sourceMessages,
				sessionLevel: reasoning,
				supportedLevels: getSupportedThinkingLevels(model),
				effortMap: model.thinkingLevelMap,
			};
			const decision =
				resolveHostTurnRequestReasoning({ ...shared, setting: settings.hostTurn }) ??
				resolveBookkeepingRequestReasoning({ ...shared, setting: settings.bookkeeping });
			if (!decision) return reasoning;
			this.lastDecision = decision;
			if (decision.lowered) this.loweredRequests++;
			return decision.resolvedLevel;
		} catch {
			// Reasoning policy is request-local and advisory; it must never disrupt the provider call.
			return reasoning;
		}
	}
}
