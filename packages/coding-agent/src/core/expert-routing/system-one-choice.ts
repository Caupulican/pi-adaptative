/**
 * System One's part in model allocation: it judges what KIND of model and thinking a task needs, one
 * Choice over four categories; code then picks the model inside the category from facts (probe
 * evidence, the owner's pool preference, measured speed and cost, the thinking levels a model
 * supports). A Choice over every (model, thinking level) pair was measured live and failed: with a
 * pool of 36 models the probability spread over ~150 options and no pick cleared 0.3.
 *
 * Confidence rule: 0.90 or above decides. Otherwise the question is asked again between the two
 * leading options only, and decides there at 0.90 (options that split one answer, such as three
 * effort variants of one model, leave no single option high until narrowed). A leader between 0.80
 * and 0.90 that the narrower question did not settle may stand for reversible routing, with its
 * doubt shown; anything else falls back and the doubt is shown.
 */

import type { ModelThinkingLevel } from "@caupulican/pi-ai";
import { settledAnswer } from "../decision/noul.ts";
import { confidenceGate } from "../system-one/authority-line.ts";
import type { ModelCapabilityCard } from "./capability-card.ts";

export interface RouteChoiceJudge {
	evaluateRouteChoice(
		input: { readonly request: string; readonly options: readonly { id: string; description: string }[] },
		signal?: AbortSignal,
	): Promise<Record<string, unknown>>;
	/** Per model, whether a later version of the same model is among `models`: one Noul each, one request. */
	evaluateSupersededModels?(
		input: { readonly models: readonly { id: string; description: string }[] },
		signal?: AbortSignal,
	): Promise<Record<string, unknown>>;
	/** Per model, whether it is a lightweight variant built for speed and low cost: one Noul each, one request. */
	evaluateLightweightModels?(
		input: { readonly models: readonly { id: string; description: string }[] },
		signal?: AbortSignal,
	): Promise<Record<string, unknown>>;
}

export const supersededQuestionId = (index: number): string => `superseded_${index}`;

export const lightweightQuestionId = (index: number): string => `lightweight_${index}`;

export const ROUTE_CHOICE_QUESTION_ID = "route_choice";

export type RouteCategory = "flash_light" | "flash_deep" | "strong_medium" | "strong_deep";

/** What each category means to System One, with the work it is and is not for. */
export const ROUTE_CATEGORIES: Readonly<Record<RouteCategory, string>> = {
	flash_light:
		"A fast, inexpensive model with little thinking. For trivial edits, renames, lookups, short answers and reading a file. Not for anything that needs a plan.",
	flash_deep:
		"A fast, inexpensive model thinking hard. For scoped but tricky work with a clear target in a few files: a focused bug fix, a small feature, a careful edit. Not for work spanning many components.",
	strong_medium:
		"A strong reasoning model at moderate thinking. For normal implementation across several files and ordinary debugging. Not for trivial edits, and not for deep design.",
	strong_deep:
		"A strong reasoning model thinking hard. For architecture, concurrency, security, deep debugging and ambiguous or long work. Not for simple edits.",
};

export const ALL_ROUTE_CATEGORIES: readonly RouteCategory[] = [
	"flash_light",
	"flash_deep",
	"strong_medium",
	"strong_deep",
];

/** The router tier a category runs on, so the owner's pin for that tier can take it. */
export const CATEGORY_TIER: Readonly<Record<RouteCategory, "cheap" | "medium" | "expensive">> = {
	flash_light: "cheap",
	flash_deep: "medium",
	strong_medium: "medium",
	strong_deep: "expensive",
};

/** The thinking level a category runs at, clamped to what the chosen model supports. */
export const CATEGORY_THINKING: Readonly<Record<RouteCategory, ModelThinkingLevel>> = {
	flash_light: "low",
	flash_deep: "high",
	strong_medium: "medium",
	strong_deep: "high",
};

export interface ChoiceDecision<T extends string> {
	readonly choice: T;
	readonly confidence: number;
	/** `decided` first pass; `followed_up` settled between the top two; `provisional` stood with a doubt. */
	readonly stage: "decided" | "followed_up" | "provisional";
	readonly reasons: readonly string[];
}

export type CategoryOutcome =
	| ({ readonly kind: "chosen"; readonly category: RouteCategory } & Omit<ChoiceDecision<RouteCategory>, "choice">)
	| { readonly kind: "fallback"; readonly reason: string };

interface ChoiceAnswer {
	readonly choice?: unknown;
	readonly confidence?: unknown;
	readonly probabilities?: unknown;
}

function asChoice(answers: Record<string, unknown>, id: string): ChoiceAnswer | undefined {
	const answer = answers[id];
	return answer && typeof answer === "object" ? (answer as ChoiceAnswer) : undefined;
}

/**
 * The confidence rule for one Choice among `options`, asked through `ask`: decide at 0.90; otherwise
 * narrow to the two leaders and decide there at 0.90; a first-pass leader from 0.80 may stand when
 * `provisional` allows it. A thrown ask is an outage and falls back.
 */
async function decideChoice<T extends string>(
	options: readonly T[],
	ask: (subset: readonly T[]) => Promise<ChoiceAnswer | undefined>,
	provisional: boolean,
): Promise<ChoiceDecision<T> | { readonly fallback: string }> {
	const isOption = (value: unknown): value is T => typeof value === "string" && options.includes(value as T);
	try {
		const first = await ask(options);
		if (!first || !isOption(first.choice)) return { fallback: "System One returned no option" };
		const leader = first.choice;
		const confidence = typeof first.confidence === "number" ? first.confidence : Number.NaN;
		const gate = confidenceGate(confidence);
		if (gate === "decide")
			return { choice: leader, confidence, stage: "decided", reasons: [`confidence ${confidence}`] };
		const runnerUp =
			first.probabilities && typeof first.probabilities === "object"
				? Object.entries(first.probabilities as Record<string, unknown>)
						.filter((entry): entry is [T, number] => isOption(entry[0]) && typeof entry[1] === "number")
						.filter(([option]) => option !== leader)
						.sort((a, b) => b[1] - a[1])[0]?.[0]
				: undefined;
		if (runnerUp) {
			const narrowed = await ask([leader, runnerUp]);
			const narrowedConfidence = typeof narrowed?.confidence === "number" ? narrowed.confidence : Number.NaN;
			if (isOption(narrowed?.choice) && confidenceGate(narrowedConfidence) === "decide")
				return {
					choice: narrowed.choice,
					confidence: narrowedConfidence,
					stage: "followed_up",
					reasons: [
						`first pass ${leader} at ${confidence}; between ${leader} and ${runnerUp}: ${narrowedConfidence}`,
					],
				};
		}
		if (provisional && gate === "ask_more")
			return {
				choice: leader,
				confidence,
				stage: "provisional",
				reasons: [`provisional at ${confidence}: the narrower question did not settle it`],
			};
		return { fallback: `System One leaned ${leader} at only ${confidence}` };
	} catch (error) {
		return { fallback: `System One unavailable: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export async function chooseRouteCategory(
	judge: RouteChoiceJudge | undefined,
	input: {
		readonly request: string;
		/** Categories with at least one eligible model; others are not offered. */
		readonly available: readonly RouteCategory[];
		readonly signal?: AbortSignal;
	},
): Promise<CategoryOutcome> {
	const { available } = input;
	if (available.length === 0) return { kind: "fallback", reason: "no eligible model" };
	if (available.length === 1)
		return { kind: "chosen", category: available[0]!, confidence: 1, stage: "decided", reasons: ["only category"] };
	if (!judge) return { kind: "fallback", reason: "System One is not bound" };
	const decision = await decideChoice(
		available,
		async (subset) =>
			asChoice(
				await judge.evaluateRouteChoice(
					{
						request: input.request,
						options: subset.map((category) => ({ id: category, description: ROUTE_CATEGORIES[category] })),
					},
					input.signal,
				),
				ROUTE_CHOICE_QUESTION_ID,
			),
		true,
	);
	if ("fallback" in decision) return { kind: "fallback", reason: decision.fallback };
	const { choice, ...rest } = decision;
	return { kind: "chosen", category: choice, ...rest };
}

/**
 * The models System One judges superseded by a later version of the same model in `models` (a
 * Flash 3.8 supersedes a Flash 3.6; an effort preset of the same version does not). Cross-family
 * order is not asked: "is Gemini newer than GPT" has no answer, and asking it only dilutes. A
 * settled yes is superseded; anything else, an outage included, is not.
 */
export async function classifySupersededModels(
	judge: RouteChoiceJudge | undefined,
	models: readonly { id: string; description: string }[],
	signal?: AbortSignal,
): Promise<Set<string>> {
	if (!judge?.evaluateSupersededModels || models.length < 2) return new Set();
	try {
		const answers = await judge.evaluateSupersededModels({ models }, signal);
		return new Set(
			models.filter((_, index) => settledAnswer(answers[supersededQuestionId(index)]) === true).map((m) => m.id),
		);
	} catch {
		return new Set();
	}
}

/**
 * Which models are lightweight speed variants, as System One judges from their identities (never a
 * name rule in code). A settled yes is flash; anything else is not. System One unavailable: none.
 */
export async function classifyLightweightModels(
	judge: RouteChoiceJudge | undefined,
	models: readonly { id: string; description: string }[],
	signal?: AbortSignal,
): Promise<Set<string>> {
	if (!judge?.evaluateLightweightModels || models.length === 0) return new Set();
	try {
		const answers = await judge.evaluateLightweightModels({ models }, signal);
		return new Set(
			models.filter((_, index) => settledAnswer(answers[lightweightQuestionId(index)]) === true).map((m) => m.id),
		);
	} catch {
		return new Set();
	}
}

/** Whether a card belongs to a category's model class: flash models for flash_*, reasoning non-flash models for strong_*. */
export function cardFitsCategory(card: ModelCapabilityCard, category: RouteCategory): boolean {
	return category.startsWith("flash") ? card.flash : card.reasoning && !card.flash;
}
