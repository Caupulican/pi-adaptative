/**
 * Expert Selection Service.
 * Central coordinator for the Harness Mixture of Experts (H-MoE) selection plane.
 * Implements reference/expert-selection-service.ts and HMOE-010.
 */

import { randomUUID } from "node:crypto";
import { clampThinkingLevel } from "@caupulican/pi-ai/models";
import type { ExpertAdmissionPolicy } from "./admission.ts";
import { describeModelCard, estimatedTurnMs, type ModelCapabilityCard, withFlashCategory } from "./capability-card.ts";
import type { ExpertCapacityService } from "./capacity.ts";
import type { ExpertCatalog } from "./catalog.ts";
import {
	EXPERT_ROUTING_SCHEMA_VERSION,
	type ExpertBinding,
	type ExpertCandidateRejection,
	type ExpertSelectionMode,
	type ExpertSelectionPlan,
	type ExpertSelectionTrace,
	NoEligibleExpertError,
	type ScoredExpertCandidate,
	type WorkerCapabilityRequest,
} from "./contracts.ts";
import type { ExpertFeatureBuilder } from "./features.ts";
import type { ExpertOutcomeStore } from "./outcome-store.ts";
import type { ExpertRankingPolicy } from "./ranking.ts";
import { buildSelectionTrace } from "./selection-trace.ts";
import {
	CATEGORY_THINKING,
	type CategoryOutcome,
	cardFitsCategory,
	chooseRouteCategory,
	classifyLightweightModels,
	classifySupersededModels,
	ROUTE_CATEGORIES,
	type RouteCategory,
	type RouteChoiceJudge,
} from "./system-one-choice.ts";

export interface ExpertSelectionResult extends ExpertSelectionPlan {
	readonly trace: ExpertSelectionTrace;
}

export class ExpertSelectionService {
	private readonly catalog: ExpertCatalog;
	private readonly admission: ExpertAdmissionPolicy;
	private readonly features: ExpertFeatureBuilder;
	private readonly ranking: ExpertRankingPolicy;
	private readonly capacity: ExpertCapacityService;
	readonly outcomeStore?: ExpertOutcomeStore;
	private readonly getJudge: () => RouteChoiceJudge | undefined;

	constructor(
		catalog: ExpertCatalog,
		admission: ExpertAdmissionPolicy,
		features: ExpertFeatureBuilder,
		ranking: ExpertRankingPolicy,
		capacity: ExpertCapacityService,
		outcomeStore?: ExpertOutcomeStore,
		/** System One, when bound: it chooses the primary expert; the ranking is the fallback. */
		getJudge: () => RouteChoiceJudge | undefined = () => undefined,
	) {
		this.getJudge = getJudge;
		this.catalog = catalog;
		this.admission = admission;
		this.features = features;
		this.ranking = ranking;
		this.capacity = capacity;
		this.outcomeStore = outcomeStore;
	}

	/**
	 * Selects the optimal materialized expert(s) for a given WorkerCapabilityRequest.
	 */
	async select(
		request: WorkerCapabilityRequest,
		options?: {
			mode?: ExpertSelectionMode;
			signal?: AbortSignal;
			requestText?: string;
			/** A category System One already judged for this request; it is not asked again. */
			category?: Extract<CategoryOutcome, { kind: "chosen" }>;
		},
	): Promise<ExpertSelectionResult> {
		if (options?.signal?.aborted) {
			throw new Error("Expert selection aborted.");
		}

		// 1. Materialize candidates lazily
		const candidates = await this.catalog.materializeCandidates(request);

		// 2. Hard admission filtering
		const admitted = [];
		const rejected: ExpertCandidateRejection[] = [];

		for (const candidate of candidates) {
			const evalResult = this.admission.evaluate(request, candidate);
			if (evalResult.allowed) {
				admitted.push(candidate);
			} else {
				rejected.push({ candidate, reasonCodes: evalResult.reasonCodes });
			}
		}

		// 3. Check for empty eligible set
		if (admitted.length === 0) {
			throw new NoEligibleExpertError(request, rejected);
		}

		// 4. Feature vector scoring
		const scored: ScoredExpertCandidate[] = await Promise.all(
			admitted.map(async (candidate) => ({
				candidate,
				features: await this.features.build(request, candidate),
			})),
		);

		// 5. Ranking and mode selection; System One chooses the primary of a single selection.
		const mode = options?.mode ?? "single";
		const ranked = this.ranking.select(request, scored, mode);
		const plan = await this.chooseWithSystemOne(request, scored, ranked, options);

		// 6. Capacity reservation
		await this.capacity.reserve(plan.bindings, request);

		// 7. Selection trace building
		const trace = buildSelectionTrace(request, candidates, rejected, scored, plan, this.ranking.version);

		return {
			...plan,
			trace,
		};
	}

	/**
	 * System One judges which category of model and thinking the task needs; code picks the model in
	 * that category from facts. Without a judgment the routing band maps to a category, so the
	 * fallback is a category too, never the composite score. A team selection keeps the ranking.
	 */
	private async chooseWithSystemOne(
		request: WorkerCapabilityRequest,
		scored: readonly ScoredExpertCandidate[],
		ranked: ExpertSelectionPlan,
		options:
			| {
					mode?: ExpertSelectionMode;
					signal?: AbortSignal;
					requestText?: string;
					category?: Extract<CategoryOutcome, { kind: "chosen" }>;
			  }
			| undefined,
	): Promise<ExpertSelectionPlan> {
		if (ranked.mode !== "single") return { ...ranked, decidedBy: { kind: "ranking", reasons: ["team selection"] } };
		const withCards = scored.filter((entry) => entry.candidate.card !== undefined);
		const unique = [...new Map(withCards.map((entry) => [entry.candidate.card!.ref, entry])).values()].map(
			(entry) => ({
				...entry.candidate.card!,
				evidence: entry.features.adequacyClass ?? "unprobed",
			}),
		);
		const cards = withFlashCategory(unique, await this.lightweightModels(unique, options?.signal));
		const available = (Object.keys(ROUTE_CATEGORIES) as RouteCategory[]).filter((category) =>
			cards.some((card) => cardFitsCategory(card, category)),
		);
		const text =
			options?.requestText ??
			(typeof request.task_signature?.prompt === "string" ? request.task_signature.prompt : "");
		const judged = options?.category;
		const outcome: CategoryOutcome =
			judged && available.includes(judged.category)
				? judged
				: text.trim()
					? await chooseRouteCategory(this.getJudge(), {
							request: text,
							available,
							...(options?.signal ? { signal: options.signal } : {}),
						})
					: { kind: "fallback", reason: "no request text to judge" };
		const category = outcome.kind === "chosen" ? outcome.category : fallbackCategory(request.routing_band, available);
		const picked = category
			? await this.pickInCategory(
					category,
					cards,
					withCards,
					request.prefer_subscription === true,
					request.minimum_context_window ?? 0,
					options?.signal,
				)
			: undefined;
		if (!picked)
			return {
				...ranked,
				decidedBy: {
					kind: "ranking",
					reasons: [outcome.kind === "fallback" ? outcome.reason : "no model in the chosen category"],
				},
			};
		const descriptor = picked.entry.candidate.descriptor;
		const binding: ExpertBinding = {
			schema_version: EXPERT_ROUTING_SCHEMA_VERSION,
			selection_id: randomUUID(),
			request_id: request.request_id,
			expert_id: descriptor.expert_id,
			provider: descriptor.provider,
			model_id: descriptor.model_id,
			thinking_level: descriptor.thinking_level,
			role: descriptor.role,
			selection_trace_id: ranked.traceId,
			exploration: false,
			expected_cost_usd: picked.entry.candidate.state.estimatedCostUsd ?? null,
			expected_latency_ms: picked.entry.candidate.state.estimatedLatencyMs ?? null,
		};
		const described = `${category} -> ${picked.card.ref} at thinking ${descriptor.thinking_level}${picked.card.flash ? " (flash)" : ""}`;
		return {
			...ranked,
			primary: binding,
			team: [binding],
			bindings: [binding],
			decidedBy:
				outcome.kind === "chosen"
					? {
							kind: "system_one",
							confidence: outcome.confidence,
							reasons: [
								described,
								`${outcome.stage}: ${outcome.reasons.join("; ")}`,
								...(outcome.stage === "provisional" ? ["unsure: the choice stands with a doubt"] : []),
							],
						}
					: { kind: "ranking", reasons: [described, `routing band fallback: ${outcome.reason}`] },
		};
	}

	/** System One's lightweight-variant judgment per exact pool of models; a pool change is a new key. */
	private readonly lightweight = new Map<string, ReadonlySet<string>>();

	private async lightweightModels(
		cards: readonly ModelCapabilityCard[],
		signal?: AbortSignal,
	): Promise<ReadonlySet<string>> {
		const key = cards
			.map((card) => card.ref)
			.sort()
			.join("|");
		const known = this.lightweight.get(key);
		if (known) return known;
		const flash = await classifyLightweightModels(
			this.getJudge(),
			cards.map((card) => ({ id: card.ref, description: describeModelCard({ ...card, flash: false }) })),
			signal,
		);
		// An outage classifies nothing and is not cached, so the next selection asks again.
		if (flash.size > 0) this.lightweight.set(key, flash);
		return flash;
	}

	/** System One's superseded-version judgment per exact group of tied models; a pool change is a new key. */
	private readonly superseded = new Map<string, ReadonlySet<string>>();

	/**
	 * The model for a category, from facts: a model the probes graded unfit last, then the owner's
	 * subscription preference. Among the models still tied there, System One judges the newest, most capable
	 * generation (a later version of a family outranks an earlier one); then a flash category takes
	 * the fastest and cheapest, a strong one the largest context, and for deep work the most capable
	 * by price. The thinking level is the category's, clamped to what the model supports.
	 */
	private async pickInCategory(
		category: RouteCategory,
		cards: readonly ModelCapabilityCard[],
		entries: readonly ScoredExpertCandidate[],
		preferSubscription: boolean,
		promptTokens: number,
		signal?: AbortSignal,
	): Promise<{ card: ModelCapabilityCard; entry: ScoredExpertCandidate } | undefined> {
		const cost = (card: ModelCapabilityCard) =>
			card.subscription ? 0 : card.inputCostPerMillion + card.outputCostPerMillion;
		// Probe evidence rules a model out only when it is negative: a model graded unfit sorts last,
		// but "passed" and "not probed yet" tie, so an older model's probe record never outranks a newer
		// generation the probes have not reached.
		const tier = (card: ModelCapabilityCard) =>
			(card.evidence === "known_unfit" ? 0 : 2) + (preferSubscription && card.subscription ? 1 : 0);
		const ordered = cards
			.filter((card) => cardFitsCategory(card, category))
			.sort((a, b) => {
				const rank = tier(b) - tier(a);
				if (rank !== 0) return rank;
				if (category.startsWith("flash")) {
					// Whole-turn time, first token included; an unmeasured model sorts after measured ones.
					const time =
						(estimatedTurnMs(a, promptTokens) ?? Number.POSITIVE_INFINITY) -
						(estimatedTurnMs(b, promptTokens) ?? Number.POSITIVE_INFINITY);
					return Number.isNaN(time) || time === 0 ? cost(a) - cost(b) : time;
				}
				const window = b.contextWindow - a.contextWindow;
				if (window !== 0) return window;
				return category === "strong_deep" ? cost(b) - cost(a) : cost(a) - cost(b);
			});
		// Among the models tied so far, one System One judges superseded by a later version of the same
		// model moves after the rest: the newer generation runs first.
		const leadTier = ordered[0] ? tier(ordered[0]) : undefined;
		const tied = ordered.filter((card) => tier(card) === leadTier);
		if (tied.length > 1) {
			const key = tied
				.map((card) => card.ref)
				.sort()
				.join("|");
			let superseded = this.superseded.get(key);
			if (!superseded) {
				superseded = await classifySupersededModels(
					this.getJudge(),
					tied.map((card) => ({ id: card.ref, description: describeModelCard(card) })),
					signal,
				);
				// An outage classifies nothing and is not cached, so the next selection asks again.
				if (superseded.size > 0) this.superseded.set(key, superseded);
			}
			const known = superseded;
			const exact = (card: ModelCapabilityCard) => card.thinkingLevels.includes(CATEGORY_THINKING[category]);
			// Superseded last; then a model that runs the category's thinking level exactly before one that
			// only reaches it by clamping (a fixed-preset variant for this level is that exact model).
			ordered.sort(
				(a, b) => Number(known.has(a.ref)) - Number(known.has(b.ref)) || Number(exact(b)) - Number(exact(a)),
			);
		}
		for (const card of ordered) {
			const thinking = clampThinkingLevel(card.model, CATEGORY_THINKING[category]);
			const entry = entries.find(
				(candidate) =>
					candidate.candidate.card?.ref === card.ref && candidate.candidate.descriptor.thinking_level === thinking,
			);
			if (entry) return { card, entry };
		}
		return undefined;
	}

	/**
	 * Releases capacity reserved by selected bindings.
	 */
	release(plan: ExpertSelectionPlan): void {
		this.capacity.release(plan.bindings);
	}
}

/** The category the classifier's routing band stands for when System One has not judged. */
function fallbackCategory(
	band: WorkerCapabilityRequest["routing_band"],
	available: readonly RouteCategory[],
): RouteCategory | undefined {
	const preferred: readonly RouteCategory[] =
		band === "cheap"
			? ["flash_light", "strong_medium"]
			: band === "expensive"
				? ["strong_deep", "strong_medium"]
				: ["strong_medium", "flash_deep", "strong_deep"];
	return preferred.find((category) => available.includes(category)) ?? available[0];
}
