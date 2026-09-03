/**
 * Capability tier: which features a model earns, decided by evidence.
 *
 * The capability CLASS (model-capability.ts) is derived from the context window and decides what a
 * small model can carry at all. Every cloud coding model lands in the `full` class, and that class
 * ran every feature on every model. Measured live on 2026-09-02, the same harness completed a
 * multi-file task cleanly on one frontier model and, on another full-class model, misread a path
 * alias in `git status` as a literal path for ten turns and then streamed one repeated sentence
 * for twenty-three minutes. Nothing in the harness said which tier a feature needed.
 *
 * The tier layers over the class:
 *
 * - `frontier`: the full class with no demotion evidence. Every feature on.
 * - `strong`: the full class after graded evidence of a slip the frontier defaults amplified (a
 *   runaway stop, a refusal rate above the gate). Aliasing keeps the saving gate but tighter
 *   guards and caps apply.
 * - `constrained`: the lean, minimal and chat classes, exactly as model-capability.ts already
 *   shapes them; the tier adds nothing beyond the smaller caps.
 *
 * Demotion is recorded in the model adaptation store (`capabilityTier`) so it survives the
 * session, and expires with the same thirty-day recency the store applies to teach rules: a model
 * earns its way back by not repeating the evidence, never by a list edit.
 */
import type { ModelCapabilityClass } from "./model-capability.ts";

export type CapabilityTier = "frontier" | "strong" | "constrained";

export interface CapabilityTierDemotion {
	tier: "strong";
	/** What was measured: `runaway_stop`, `refusal_rate`, or a probe outcome. */
	reason: string;
	at: string;
}

export interface CapabilityTierInput {
	capabilityClass: ModelCapabilityClass;
	/** The store's demotion record for this model, if any. */
	demotion?: CapabilityTierDemotion;
	/** Now, for demotion expiry. */
	now?: Date;
}

/** A demotion older than this no longer applies; the model earns the frontier tier back. */
export const CAPABILITY_TIER_DEMOTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface CapabilityTierPolicy {
	tier: CapabilityTier;
	/** Whether path aliasing runs at all; the saving gate still applies when it does. */
	pathAliasing: boolean;
	/** Per-response output cap the session applies when no smaller setting or goal budget does. */
	maxOutputTokens: number;
	/** Repeats of one output window that end a response as a runaway (see the stream guard). */
	repetitionGuardRepeats: number;
	/** Upper bound for the active skill bodies the vault keeps in context. */
	skillBodyMaxBytes: number;
	/** How much of the failure protocol rides each request: a pointer, or the full text. */
	protocolProse: "pointer" | "full";
	/** How hard tool-output reducers cut (see tools/output-reduction.ts): lower caps on the constrained tier. */
	outputReduction: "standard" | "compact";
}

const POLICIES: Readonly<Record<CapabilityTier, Omit<CapabilityTierPolicy, "tier">>> = {
	frontier: {
		pathAliasing: true,
		maxOutputTokens: 32_768,
		repetitionGuardRepeats: 6,
		skillBodyMaxBytes: 64 * 1024,
		protocolProse: "pointer",
		outputReduction: "standard",
	},
	strong: {
		pathAliasing: true,
		maxOutputTokens: 16_384,
		repetitionGuardRepeats: 4,
		skillBodyMaxBytes: 32 * 1024,
		protocolProse: "pointer",
		outputReduction: "standard",
	},
	constrained: {
		pathAliasing: false,
		maxOutputTokens: 8_192,
		repetitionGuardRepeats: 3,
		skillBodyMaxBytes: 16 * 1024,
		protocolProse: "full",
		outputReduction: "compact",
	},
};

export function resolveCapabilityTier(input: CapabilityTierInput): CapabilityTier {
	if (input.capabilityClass !== "full") return "constrained";
	const demotion = input.demotion;
	if (!demotion) return "frontier";
	const at = Date.parse(demotion.at);
	const now = (input.now ?? new Date()).getTime();
	if (!Number.isFinite(at) || now - at > CAPABILITY_TIER_DEMOTION_TTL_MS) return "frontier";
	return demotion.tier;
}

export function capabilityTierPolicy(tier: CapabilityTier): CapabilityTierPolicy {
	return { tier, ...POLICIES[tier] };
}

export function isCapabilityTierDemotion(value: unknown): value is CapabilityTierDemotion {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return record.tier === "strong" && typeof record.reason === "string" && typeof record.at === "string";
}
