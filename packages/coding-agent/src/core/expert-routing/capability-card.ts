/**
 * Capability cards: what each routable model can do, as facts from its metadata and the host's own
 * measurements. Never inferred from a model's name. A card is what System One reads when it weighs one
 * (model, thinking level) against another for a task; the hard filters here are what no judgment
 * may override (a task with an image cannot go to a model without image input).
 */

import type { Api, Model, ModelThinkingLevel } from "@caupulican/pi-ai";
import { getSupportedThinkingLevels } from "@caupulican/pi-ai/models";
import type { AutoSelectionEvidenceClass } from "../model-router/auto-selection.ts";
import type { ModelPerfProfile } from "../models/perf-profile.ts";

export interface ModelCapabilityCard {
	readonly ref: string;
	readonly model: Model<Api>;
	readonly image: boolean;
	readonly reasoning: boolean;
	readonly thinkingLevels: readonly ModelThinkingLevel[];
	readonly contextWindow: number;
	readonly maxOutputTokens: number | undefined;
	/** USD per million input / output tokens; 0 when the provider publishes no price. */
	readonly inputCostPerMillion: number;
	readonly outputCostPerMillion: number;
	readonly subscription: boolean;
	/** Measured on this host; undefined until the model has served requests here. */
	readonly decodeTokensPerSecond: number | undefined;
	readonly prefillTokensPerSecond: number | undefined;
	/** Measured time before the first token that does not depend on the prompt (model load, queueing). */
	readonly loadMs: number | undefined;
	/** What the probes know about this model on routed work. */
	readonly evidence: AutoSelectionEvidenceClass;
	/** A lightweight variant built for speed and low cost, as System One judged it; see {@link withFlashCategory}. */
	readonly flash: boolean;
}

export interface CapabilityCardFacts {
	readonly subscription: boolean;
	readonly evidence: AutoSelectionEvidenceClass;
	readonly perf?: ModelPerfProfile;
}

export function buildCapabilityCard(model: Model<Api>, facts: CapabilityCardFacts): ModelCapabilityCard {
	// Model prices are already quoted per million tokens.
	const perMillion = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	return {
		ref: `${model.provider}/${model.id}`,
		model,
		image: model.input.includes("image"),
		reasoning: model.reasoning,
		thinkingLevels: getSupportedThinkingLevels(model),
		contextWindow: model.contextWindow,
		maxOutputTokens: typeof model.maxTokens === "number" ? model.maxTokens : undefined,
		inputCostPerMillion: perMillion(model.cost?.input),
		outputCostPerMillion: perMillion(model.cost?.output),
		subscription: facts.subscription,
		decodeTokensPerSecond: facts.perf?.decodeTokensPerSecond,
		prefillTokensPerSecond: facts.perf?.prefillTokensPerSecond,
		loadMs: facts.perf?.loadMs,
		evidence: facts.evidence,
		flash: false,
	};
}

/** The reply size turn time is estimated at, so a slow first token and a slow stream both count. */
const REFERENCE_REPLY_TOKENS = 1_000;

/**
 * Estimated wall time of a turn on this host: time to first token (load plus the prompt at the
 * measured prefill speed) and a reference reply at the measured decode speed. Undefined until the
 * model has been measured here: a fast stream behind a slow first token must not look fast.
 */
export function estimatedTurnMs(card: ModelCapabilityCard, promptTokens: number): number | undefined {
	if (!card.decodeTokensPerSecond || !card.prefillTokensPerSecond) return undefined;
	return (
		(card.loadMs ?? 0) +
		(promptTokens / card.prefillTokensPerSecond) * 1000 +
		(REFERENCE_REPLY_TOKENS / card.decodeTokensPerSecond) * 1000
	);
}

/** Cards with the flash category System One judged: `flashRefs` are the lightweight speed variants. */
export function withFlashCategory(
	cards: readonly ModelCapabilityCard[],
	flashRefs: ReadonlySet<string>,
): ModelCapabilityCard[] {
	return cards.map((card) => ({ ...card, flash: flashRefs.has(card.ref) }));
}

/** What a turn needs that code can know for certain, before any judgment. */
export interface RouteHardNeeds {
	/** The turn carries images. */
	readonly image: boolean;
	/** Estimated tokens the turn sends; a model whose window cannot hold them is out. */
	readonly contextTokens: number;
}

/** Why a card cannot take the turn, or undefined when it can. */
export function hardFilterReason(card: ModelCapabilityCard, needs: RouteHardNeeds): string | undefined {
	if (needs.image && !card.image) return "no_image_input";
	if (card.contextWindow > 0 && needs.contextTokens > card.contextWindow) return "context_exceeds_window";
	return undefined;
}

export interface RouteOption {
	/** Stable option id sent to System One: `o<n>`. */
	readonly id: string;
	readonly card: ModelCapabilityCard;
	readonly thinking: ModelThinkingLevel;
}

/** Every eligible (model, thinking level) pair, in card order. */
export function routeOptions(cards: readonly ModelCapabilityCard[]): RouteOption[] {
	const options: RouteOption[] = [];
	for (const card of cards)
		for (const thinking of card.thinkingLevels) options.push({ id: `o${options.length}`, card, thinking });
	return options;
}

function formatCount(value: number): string {
	return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : `${Math.round(value / 1_000)}k`;
}

/** One option as System One reads it: the facts only, in plain words. */
export function describeRouteOption(option: RouteOption): string {
	return `${option.card.ref} at thinking ${option.thinking}; ${describeModelCard(option.card)}`;
}

/** A model's facts in plain words, for the questions System One asks about it. */
export function describeModelCard(card: ModelCapabilityCard): string {
	const facts = [
		card.model.name && card.model.name !== card.model.id ? `${card.ref} (${card.model.name})` : card.ref,
		card.image ? "reads text and images" : "reads text only",
		card.reasoning ? `reasoning model (levels: ${card.thinkingLevels.join(", ")})` : "no reasoning mode",
		`context ${formatCount(card.contextWindow)} tokens`,
		...(card.maxOutputTokens ? [`output up to ${formatCount(card.maxOutputTokens)} tokens`] : []),
		card.subscription
			? "covered by subscription"
			: card.inputCostPerMillion > 0
				? `$${card.inputCostPerMillion.toFixed(2)}/$${card.outputCostPerMillion.toFixed(2)} per million tokens in/out`
				: "no published price",
		card.decodeTokensPerSecond && card.prefillTokensPerSecond
			? `measured here: first token after ${Math.round((card.loadMs ?? 0) + (8_000 / card.prefillTokensPerSecond) * 1000)} ms on an 8k prompt, ${Math.round(card.decodeTokensPerSecond)} output tokens/s`
			: "speed not measured here",
		card.evidence === "known_fit"
			? "passed the harness probes"
			: card.evidence === "known_unfit"
				? "failed the harness probes"
				: "not probed",
		...(card.flash ? ["FLASH: a lightweight variant built for speed and low cost"] : []),
	];
	return facts.join("; ");
}
