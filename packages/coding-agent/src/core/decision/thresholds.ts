/**
 * Where every System One answer decides: the one table of cuts, and the readers that apply them.
 *
 * System One makes judgments and code makes decisions; this module is the code side of that line. A
 * yes/no answer is P(true) read against a family's bands, with a middle band that settles nothing and
 * gets its own outcome at the call site. A Choice is read on the probability of the option the code
 * will act on (never on `confidence`, which for a Choice is only a transform of the top probability),
 * higher for riskier actions, and a destructive option only starts a confirmation. A Score is first
 * checked for being settled at all (its confidence), then read on the probability mass on the side of
 * the boundary that matters.
 *
 * Measured values carry their measurement; the rest are starting points that stay until an evaluation
 * on the harness's own answers says otherwise. Nothing else may invent a cutoff.
 */

import type { NoulBandThresholds } from "./noul.ts";
import type { Consequence } from "./primitives.ts";

/** The yes/no families. Each names what an answer in it may authorize, so its cut scales with that risk. */
export type YesNoFamily =
	| "gating"
	| "advisory"
	| "operation_effect"
	| "operation_request"
	| "plan_review"
	| "completion"
	| "orchestration";

/**
 * "Something is present that must not be": established at 0.8, absent at or below an even chance,
 * unsettled between. Shared by the families that ask for an effect or a defect, each measured on its own.
 *
 * Absence is accepted at or below 0.5, looser than the 0.10 the owner's rule sets for requiring absence.
 * The written reason: in both families an absence reading authorizes nothing beyond what runs without
 * System One. `plan_review` only steers or annotates a plan the model keeps working from, and an
 * `operation_effect` absence lets a shell call run under the edge policy that already governs it; at 0.10
 * every routine command whose effect reads in (0.10, 0.5] becomes unsettled, which refuses it in a worker
 * and asks the owner at the root, an autonomy loss on calls the probes below read as effect-free. The
 * measurement owed: a labelled set per question (effect-free and effectful operations; sound and planted-defect
 * plans), answered once, then re-decided offline from the saved answers (`typesafe-review decide`) to place
 * the absence cut where no labelled effect or defect reads below it. Until that set exists the cut stays a
 * starting point.
 */
const PRESENCE_BANDS: NoulBandThresholds = Object.freeze({
	requiredTrue: Object.freeze({ hardPass: 0.5, softPass: 0.5, hardFail: 0.2 }),
	requiredFalse: Object.freeze({ hardPassMax: 0.5, softPassMax: 0.5, hardFailMin: 0.8 }),
});

/**
 * The bands of every yes/no family, both directions. `noulBand` reads them; a band is inclusive at
 * each cut (a pass at `>= hardPass` / `<= hardPassMax`, a fail at `<= hardFail` / `>= hardFailMin`).
 */
export const YES_NO_BANDS: Readonly<Record<YesNoFamily, NoulBandThresholds>> = Object.freeze({
	/**
	 * Authorizes, closes a goal, or reaches outward. Measured on the owner-words screen: 70 messages in
	 * ten languages at the 0.93 floor (docs/system-one.md). Stricter than the vendor's 0.7 start, which
	 * suits authority. A soft pass may continue a step and may not authorize.
	 */
	gating: Object.freeze({
		requiredTrue: Object.freeze({ hardPass: 0.93, softPass: 0.85, hardFail: 0.2 }),
		requiredFalse: Object.freeze({ hardPassMax: 0.07, softPassMax: 0.15, hardFailMin: 0.8 }),
	}),
	/**
	 * Advisory or reversible work: the vendor's starting cuts, unmeasured here. No soft band: an answer
	 * between 0.3 and 0.7 is undecided and the caller gives it its own outcome (keep, ask, look again).
	 */
	advisory: Object.freeze({
		requiredTrue: Object.freeze({ hardPass: 0.7, softPass: 0.7, hardFail: 0.3 }),
		requiredFalse: Object.freeze({ hardPassMax: 0.3, softPassMax: 0.3, hardFailMin: 0.7 }),
	}),
	/**
	 * What an operation does (leaves the machine, cannot be undone, ...), asked as "the effect is
	 * present", which needs a no: absent at or below an even chance, established at 0.8, unsettled
	 * between. Probed live: `npm test`, `git status`, a build script and a `sed` edit read at most 0.22
	 * on every effect; `pip install` reads 0.99 acquires external code; a Python POST 0.93 leaves the
	 * machine.
	 */
	operation_effect: PRESENCE_BANDS,
	/** Whether the owner's request asks for the operation: asks at 0.8 or above, clearly does not at 0.2 or below. */
	operation_request: Object.freeze({
		requiredTrue: Object.freeze({ hardPass: 0.8, softPass: 0.8, hardFail: 0.2 }),
		requiredFalse: Object.freeze({ hardPassMax: 0.2, softPassMax: 0.2, hardFailMin: 0.8 }),
	}),
	/**
	 * A plan defect: steers the model at 0.8, a doubt above an even chance, sound at or below it.
	 * Probed live: a missing requested part 0.92 vs 0.18 for a sound plan; an order that uses a later
	 * step's result 0.62 vs at most 0.2; the result check 0.97 vs 0.04.
	 */
	plan_review: PRESENCE_BANDS,
	/**
	 * Completion packs: two bands, no middle, as measured (see {@link COMPLETION_THRESHOLDS}). An outcome
	 * holds at 0.7 or above and fails below; a defect holds (is absent) at 0.5 or below and fails above.
	 */
	completion: Object.freeze({
		requiredTrue: Object.freeze({ hardPass: 0.7, softPass: 0.7, hardFail: 0.7 }),
		requiredFalse: Object.freeze({ hardPassMax: 0.5, softPassMax: 0.5, hardFailMin: 0.5 }),
	}),
	/**
	 * Orchestration judgments: a plan graph's missing part or dependency, a brief's self-containment, a
	 * pair's evidence sufficiency, findings that contradict, routing doubts. The owner's rule as written:
	 * accept at 0.90, require absence at 0.10, no soft band; anything between is `open` and the caller's
	 * ordered exits give it its own outcome. Unmeasured; Choices in this area read `consequential`.
	 */
	orchestration: Object.freeze({
		requiredTrue: Object.freeze({ hardPass: 0.9, softPass: 0.9, hardFail: 0.1 }),
		requiredFalse: Object.freeze({ hardPassMax: 0.1, softPassMax: 0.1, hardFailMin: 0.9 }),
	}),
});

/**
 * Where completion answers decide, measured against the real System One on the completion eval set
 * (`npm run eval:completion`, 2026-09-25: repository, machine, remote, information and mixed goals,
 * each done and with a planted gap). Done goals scored every required outcome 0.89-0.98 and every
 * defect at most 0.47; planted gaps scored the outcome 0.05-0.35 and the gating defects 0.59 or more.
 * Claims in the model's account that held read 0.63-0.96; vague or irrelevant evidence 0.14-0.27; a
 * contradicted claim at most 0.03.
 */
export const COMPLETION_THRESHOLDS = Object.freeze({ outcomeMin: 0.7, defectMax: 0.5, claimSupportedMin: 0.5 });

/** Knowledge admission and grounding: a fact enters the owner's knowledge at 0.9 or above. */
export const KNOWLEDGE_FLOOR = 0.9;

/** What acting on a Choice option risks; the act probability rises with it. */
export type ChoiceRisk = "reversible" | "route" | "consequential" | "authority" | "destructive";

export interface ChoiceActThreshold {
	/** P(the option acted on) at or above which code acts. */
	readonly minProbability: number;
	/** P(option) minus the best other option's P, where a close second matters. */
	readonly minMargin?: number;
	/** Acting starts a confirmation step; identifying the intent never performs the action. */
	readonly confirm?: true;
}

export const CHOICE_ACT = Object.freeze({
	/** Reversible work: the vendor's starting floor. */
	reversible: Object.freeze({ minProbability: 0.7 }),
	/** The next bounded route of an objective step (preflight, postflight): the configured value, unmeasured. */
	route: Object.freeze({ minProbability: 0.88, minMargin: 0.15 }),
	/** Consequential, not destructive: the vendor's raised floor. */
	consequential: Object.freeze({ minProbability: 0.9 }),
	/** The owner's own intent and optional-tool standing: the gating family's 0.93, with a clear runner-up gap. */
	authority: Object.freeze({ minProbability: 0.93, minMargin: 0.2 }),
	/** Destructive or outward: the raised floor, and acting only starts a confirmation. */
	destructive: Object.freeze({ minProbability: 0.9, confirm: true as const }),
}) satisfies Readonly<Record<ChoiceRisk, ChoiceActThreshold>>;

/** Runner-up margin, only where a close second changes what code does; unmeasured. */
export const CHOICE_RUNNER_UP_MARGIN = 0.15;

/**
 * The authority line's gate on a Choice (on P(chosen option)) or a Score (on its confidence): decide
 * at 0.9, ask a narrower follow-up from 0.8, below that the answer decides nothing.
 */
export const CHOICE_FOLLOW_UP = Object.freeze({ decide: 0.9, askMore: 0.8 });

/** A Score whose confidence is below this is genuinely unsure: read nothing from it. */
export const SCORE_CONFIDENCE_FLOOR = 0.5;
/** The probability mass on one side of a Score boundary that settles it on that side. */
export const SCORE_BOUNDARY_MASS = 0.7;

/**
 * A plan vote's rubric criterion (S6): met when the Score mass at level 2 or above reaches {@link RUBRIC_MEET_MASS}, failed
 * when that mass is at most {@link RUBRIC_FAIL_MASS}, open between. These are the owner's orchestration cuts (accept at 0.90,
 * require absence at 0.10), so the rubric does not use the score floors above.
 */
export const RUBRIC_MEET_MASS = 0.9;
export const RUBRIC_FAIL_MASS = 0.1;

/**
 * The steering plane's floor on a Choice, Score or Set answer by consequence: below it the answer is a
 * doubt and a pass becomes `gather_more`. Unmeasured.
 */
export const CONSEQUENCE_MIN_CONFIDENCE: Readonly<Record<Consequence, number>> = Object.freeze({
	low: 0.6,
	medium: 0.75,
	high: 0.85,
	critical: 0.9,
});

/**
 * The steering plane's per-checkpoint cuts, as live today. Unmeasured; named so the plane reads them
 * from here. The semantic outcome of JEV-004 and JEV-024 reads `completion_plausible` at 0.65; the
 * JEV-024 directive reads it at 0.75.
 */
export const STEERING_CUTS = Object.freeze({
	/** JEV-004 directive: completion is plausible enough to propose a completion candidate. */
	routeCompletionPlausible: 0.8,
	/** JEV-004 directive: a capability gap is suspected. */
	routeCapabilityGap: 0.7,
	/** JEV-007/008: a capability is needed, or a gap remains. */
	capabilityNeed: 0.6,
	/** JEV-013: the specification is fulfilled (directive and semantic outcome). */
	specFulfilled: 0.7,
	/** JEV-024 directive: the transition's completion answer. */
	transitionDirective: 0.75,
	/** JEV-004 and JEV-024 semantic outcome: `completion_plausible`. */
	outcomeCompletionPlausible: 0.65,
	/**
	 * JEV-001 `ambiguity_severity` at level 2 or more: this much Score mass on the adverse side flags it. A flag only
	 * sends the pass to `gather_more`, the safe side, so the
	 * pass needs more than half its mass clear of it. It is not {@link SCORE_BOUNDARY_MASS} (0.7, with a confidence
	 * floor), which settles a side to act on; reading these flags at 0.7 would let a pass through on a 0.6 adverse mass.
	 */
	scoreAdverseMass: 0.5,
});

/**
 * JEV-043 `duplicate_introduced`: at or above it the route stops and a repair task is added; below it the change
 * passes. There is no middle band. Unmeasured.
 */
export const DUPLICATE_INTRODUCED_CUT = 0.6;

// ---------------------------------------------------------------------------------------------------
// Choice readers. They take a raw System One answer (`{ choice, confidence, probabilities }`), a
// certificate answer (`{ choice, distribution }`) or an engine result (`{ selected, distribution }`).

/** What a Choice lets code do with one option: act on it, leave it undecided, or rule it out. */
export type ChoiceActReading = "act" | "unsure" | "not_this";

interface ChoiceShape {
	readonly selected?: string;
	readonly distribution?: Readonly<Record<string, number>>;
}

function choiceShape(answer: unknown): ChoiceShape | undefined {
	if (!answer || typeof answer !== "object") return undefined;
	const record = answer as {
		choice?: unknown;
		selected?: unknown;
		probabilities?: unknown;
		distribution?: unknown;
	};
	const selected =
		typeof record.choice === "string"
			? record.choice
			: typeof record.selected === "string"
				? record.selected
				: undefined;
	const raw = record.probabilities ?? record.distribution;
	const distribution: Record<string, number> = {};
	if (raw && typeof raw === "object")
		for (const [option, p] of Object.entries(raw))
			if (typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1) distribution[option] = p;
	return { ...(selected !== undefined ? { selected } : {}), distribution };
}

/** P(option), the selected option by default; undefined when the answer carries no such probability. */
export function choiceProbability(answer: unknown, option?: string): number | undefined {
	const shape = choiceShape(answer);
	const key = option ?? shape?.selected;
	return key === undefined ? undefined : shape?.distribution?.[key];
}

/** The most probable option other than the selected one, for traces and close-second checks. */
export function choiceRunnerUp(answer: unknown, option?: string): { option: string; p: number } | undefined {
	const shape = choiceShape(answer);
	const key = option ?? shape?.selected;
	let best: { option: string; p: number } | undefined;
	for (const [candidate, p] of Object.entries(shape?.distribution ?? {}))
		if (candidate !== key && (!best || p > best.p)) best = { option: candidate, p };
	return best;
}

/**
 * Whether code may act on `option` (the selected option when omitted) at `risk`. `act` when P(option)
 * reaches the risk's floor and, where a margin applies, clears the runner-up by it; `not_this` when the
 * mass against the option is at least that floor; `unsure` otherwise, including an answer with no
 * probability. For `destructive`, `act` means start the confirmation step.
 */
export function choiceAct(
	answer: unknown,
	option: string | undefined,
	risk: ChoiceRisk,
	options: { readonly minMargin?: number } = {},
): ChoiceActReading {
	const threshold: ChoiceActThreshold = CHOICE_ACT[risk];
	const p = choiceProbability(answer, option);
	if (p === undefined) return "unsure";
	if (p <= 1 - threshold.minProbability) return "not_this";
	if (p < threshold.minProbability) return "unsure";
	const minMargin = options.minMargin ?? threshold.minMargin;
	if (minMargin !== undefined) {
		const runnerUp = choiceRunnerUp(answer, option);
		if (runnerUp && p - runnerUp.p < minMargin) return "unsure";
	}
	return "act";
}

// ---------------------------------------------------------------------------------------------------
// Score readers.

/** Whether a Score settled on the side of a boundary that matters. */
export type ScoreReading = "on_side" | "off_side" | "unsettled";

/** The probability mass of the levels on `side`, or undefined when the answer has no distribution. */
export function scoreBoundaryMass(answer: unknown, side: (level: number) => boolean): number | undefined {
	if (!answer || typeof answer !== "object") return undefined;
	const record = answer as { probabilities?: unknown; distribution?: unknown };
	const raw = record.probabilities ?? record.distribution;
	if (!raw || typeof raw !== "object") return undefined;
	let mass = 0;
	let any = false;
	for (const [level, p] of Object.entries(raw)) {
		const value = Number(level);
		if (Number.isNaN(value) || typeof p !== "number" || !Number.isFinite(p)) continue;
		any = true;
		if (side(value)) mass += p;
	}
	return any ? mass : undefined;
}

/**
 * Confidence first, then the boundary: a Score below {@link SCORE_CONFIDENCE_FLOOR} decides nothing;
 * otherwise it is on the side when that side holds {@link SCORE_BOUNDARY_MASS}, off it when the other
 * side does, and unsettled between.
 */
export function scoreSettled(answer: unknown, side: (level: number) => boolean): ScoreReading {
	const confidence = (answer as { confidence?: unknown } | undefined)?.confidence;
	const value = typeof confidence === "number" ? confidence : (confidence as { value?: unknown } | undefined)?.value;
	if (typeof value !== "number" || !Number.isFinite(value) || value < SCORE_CONFIDENCE_FLOOR) return "unsettled";
	const mass = scoreBoundaryMass(answer, side);
	if (mass === undefined) return "unsettled";
	if (mass >= SCORE_BOUNDARY_MASS) return "on_side";
	return mass <= 1 - SCORE_BOUNDARY_MASS ? "off_side" : "unsettled";
}
