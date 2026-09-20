import type { Api, Model } from "@caupulican/pi-ai";
import { deriveModelCapabilityProfile, type ModelCapabilityClass } from "../model-capability.ts";
import type { ModelToolProbeVerdict } from "../models/adaptation-store.ts";
import type { ModelRouterPoolPreference } from "../settings-manager.ts";
import type { FitnessGatedSurface, FitnessGateVerdict } from "./fitness-gate.ts";
import { isLocalOrManagedRouterModel } from "./tool-escalation.ts";

/**
 * Deterministic exact-model selection for an AUTO tier, bounded to the candidate pool.
 *
 * Order of authority, top to bottom, and nothing lower ever overrides anything higher:
 *   1. hard admission — auth, quota, a working tool-call path, the fitness gate when enabled;
 *   2. evidence class — known-fit ahead of unprobed ahead of known-unfit. Adequacy outranks who
 *      pays: a model the probes graded as unfit for this surface is never preferred for being
 *      subscription-backed, whether or not the hard fitness gate is on;
 *   3. pool preference — subscription-first ranks subscription-backed models ahead, within a class;
 *   4. capability class, then tier-appropriate cost;
 *   5. a stable name order so two runs agree.
 * The result carries every candidate with its reasons so diagnostics and the preview can show why.
 */
export type AutoSelectionTier = "cheap" | "medium" | "expensive";

/** What the probes know about this model on this surface, independent of the hard fitness gate. */
export type AutoSelectionEvidenceClass = "known_fit" | "unprobed" | "known_unfit";

const EVIDENCE_RANK: Record<AutoSelectionEvidenceClass, number> = { known_fit: 2, unprobed: 1, known_unfit: 0 };

export function evidenceClassOf(verdict: FitnessGateVerdict): AutoSelectionEvidenceClass {
	if (verdict.fit) return verdict.probed ? "known_fit" : "unprobed";
	return verdict.reason === "unprobed" ? "unprobed" : "known_unfit";
}

export interface AutoSelectionDeps {
	isSubscription(model: Model<Api>): boolean;
	hasConfiguredAuth(model: Model<Api>): boolean;
	isExhausted(model: Model<Api>): boolean;
	/** Persisted `/toolprobe` verdict; consulted only for local/managed models, as the router does. */
	toolProbeVerdict(model: Model<Api>): ModelToolProbeVerdict | undefined;
	fitness(surface: FitnessGatedSurface, model: Model<Api>): FitnessGateVerdict;
	fitnessGate: boolean;
	preference: ModelRouterPoolPreference;
}

export interface AutoSelectionCandidate {
	readonly model: Model<Api>;
	readonly ref: string;
	readonly subscription: boolean;
	readonly admitted: boolean;
	readonly rejectReasons: readonly string[];
	readonly fitness: FitnessGateVerdict;
	/** Probe evidence for this surface; ranks above the subscription preference. */
	readonly evidenceClass: AutoSelectionEvidenceClass;
	readonly capabilityClass: ModelCapabilityClass;
}

export interface AutoSelectionResult {
	readonly tier: AutoSelectionTier;
	/** Admitted candidates in rank order, then rejected ones. */
	readonly candidates: readonly AutoSelectionCandidate[];
	readonly chosen?: AutoSelectionCandidate;
	readonly eligible: number;
	readonly subscriptionEligible: number;
	/**
	 * True when the chosen model outranked a metered candidate of its own evidence class because of
	 * subscription-first. A subscription model that only won by having better evidence is not
	 * "subscription-preferred".
	 */
	readonly subscriptionPreferred: boolean;
	readonly reason: string;
}

const CAPABILITY_RANK: Record<ModelCapabilityClass, number> = { full: 3, lean: 2, minimal: 1, chat: 0 };

export function routerSurfaceForTier(tier: AutoSelectionTier): FitnessGatedSurface {
	return tier === "cheap" ? "router_cheap" : tier === "medium" ? "router_medium" : "router_expensive";
}

function formatFitness(verdict: FitnessGateVerdict): string {
	if (verdict.fit) return verdict.probed ? "fit" : "unprobed";
	return verdict.reason === "unprobed" ? "unprobed" : `unfit (${verdict.lane} ${verdict.succeeded}/${verdict.total})`;
}

function inputCost(model: Model<Api>): number {
	const cost = model.cost?.input;
	return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}

function admit(tier: AutoSelectionTier, model: Model<Api>, deps: AutoSelectionDeps): AutoSelectionCandidate {
	const reasons: string[] = [];
	if (!deps.hasConfiguredAuth(model)) reasons.push("auth_missing");
	if (deps.isExhausted(model)) reasons.push("quota_exhausted");
	if (isLocalOrManagedRouterModel(model) && deps.toolProbeVerdict(model) === "none") reasons.push("no_tool_path");
	const fitness = deps.fitness(routerSurfaceForTier(tier), model);
	if (deps.fitnessGate && !fitness.fit) reasons.push("fitness_gate");
	return {
		model,
		ref: `${model.provider}/${model.id}`,
		subscription: deps.isSubscription(model),
		admitted: reasons.length === 0,
		rejectReasons: reasons,
		fitness,
		evidenceClass: evidenceClassOf(fitness),
		capabilityClass: deriveModelCapabilityProfile({ contextWindow: model.contextWindow, mode: "auto" }).class,
	};
}

function compareCandidates(
	tier: AutoSelectionTier,
	preference: ModelRouterPoolPreference,
	a: AutoSelectionCandidate,
	b: AutoSelectionCandidate,
): number {
	const evidence = EVIDENCE_RANK[b.evidenceClass] - EVIDENCE_RANK[a.evidenceClass];
	if (evidence !== 0) return evidence;
	if (preference === "subscription-first" && a.subscription !== b.subscription) return a.subscription ? -1 : 1;
	const capability = CAPABILITY_RANK[b.capabilityClass] - CAPABILITY_RANK[a.capabilityClass];
	if (capability !== 0) return capability;
	if (tier === "expensive") {
		// Absent evidence, the expensive tier prefers the largest, then the priciest, model.
		const window = (b.model.contextWindow ?? 0) - (a.model.contextWindow ?? 0);
		if (window !== 0) return window;
		const cost = inputCost(b.model) - inputCost(a.model);
		if (cost !== 0) return cost;
	} else {
		const cost = inputCost(a.model) - inputCost(b.model);
		if (cost !== 0) return cost;
	}
	return a.ref.localeCompare(b.ref);
}

export function selectAutoTierModel(
	tier: AutoSelectionTier,
	pool: readonly Model<Api>[],
	deps: AutoSelectionDeps,
): AutoSelectionResult {
	const evaluated = pool.map((model) => admit(tier, model, deps));
	const admitted = evaluated
		.filter((candidate) => candidate.admitted)
		.sort((a, b) => compareCandidates(tier, deps.preference, a, b));
	const rejected = evaluated.filter((candidate) => !candidate.admitted);
	const chosen = admitted[0];
	const subscriptionEligible = admitted.filter((candidate) => candidate.subscription).length;
	const subscriptionPreferred =
		deps.preference === "subscription-first" &&
		chosen?.subscription === true &&
		admitted.some((candidate) => !candidate.subscription && candidate.evidenceClass === chosen.evidenceClass);
	const reason = !chosen
		? pool.length === 0
			? "candidate pool is empty"
			: `no admitted candidate (${Array.from(new Set(rejected.flatMap((c) => c.rejectReasons))).join(", ")})`
		: `${chosen.evidenceClass}${subscriptionPreferred ? " + subscription-preferred" : ""} · fitness ${formatFitness(chosen.fitness)}`;
	return {
		tier,
		candidates: [...admitted, ...rejected],
		chosen,
		eligible: admitted.length,
		subscriptionEligible,
		subscriptionPreferred,
		reason,
	};
}

export function formatAutoSelectionCandidate(candidate: AutoSelectionCandidate): string {
	const state = candidate.admitted ? "eligible" : `rejected (${candidate.rejectReasons.join(", ")})`;
	return `${candidate.ref} · ${candidate.subscription ? "subscription" : "metered"} · ${candidate.evidenceClass} · ${formatFitness(candidate.fitness)} · ${state}`;
}
