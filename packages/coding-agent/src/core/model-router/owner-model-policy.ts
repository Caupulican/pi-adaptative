/**
 * The owner's model policy for this session: which pools of language models may be allocated. The
 * owner changes it by saying so ("we can only use subscription models", "turn API models back on",
 * "no subscription models now"); System One reads the request, and the next allocation, of any
 * foreground turn, worker, lane or consult, reads the policy at the moment it picks. Nothing is
 * restarted and nothing is refused: a model outside the policy is simply never allocated, and work
 * pinned to one is reallocated to the best allowed model. System One is not a pool here; it judges, it is
 * not allocated.
 */

import type { Api, Model } from "@caupulican/pi-ai";

export const MODEL_POOLS = ["subscription", "metered", "local"] as const;
export type ModelPool = (typeof MODEL_POOLS)[number];

export type ModelPoolPolicy = Readonly<Record<ModelPool, boolean>>;

export const ALL_POOLS_ALLOWED: ModelPoolPolicy = Object.freeze({ subscription: true, metered: true, local: true });

/** A requested change per pool, as the request states it. */
export type ModelPoolChange = Partial<Record<ModelPool, boolean>>;

export interface ModelPoolFacts {
	isSubscription(model: Model<Api>): boolean;
	isLocal(model: Model<Api>): boolean;
}

/** The pool a model is allocated from: local runtime, a subscription, or metered API billing. */
export function modelPoolOf(model: Model<Api>, facts: ModelPoolFacts): ModelPool {
	if (facts.isLocal(model)) return "local";
	return facts.isSubscription(model) ? "subscription" : "metered";
}

export function describePolicy(policy: ModelPoolPolicy): string {
	const on = MODEL_POOLS.filter((pool) => policy[pool]);
	const off = MODEL_POOLS.filter((pool) => !policy[pool]);
	return off.length === 0 ? "all model pools allowed" : `allowed: ${on.join(", ") || "none"}; off: ${off.join(", ")}`;
}

export type PolicyChangeOutcome =
	| { readonly kind: "unchanged" }
	| { readonly kind: "applied"; readonly policy: ModelPoolPolicy }
	/** The change would leave no model to allocate; the previous policy stays. */
	| { readonly kind: "refused"; readonly reason: string };

/** Live, session-scoped policy. Readers call `allows` at the moment they allocate. */
export class OwnerModelPolicy {
	private current: ModelPoolPolicy;
	private readonly facts: ModelPoolFacts;

	constructor(facts: ModelPoolFacts, initial: ModelPoolPolicy = ALL_POOLS_ALLOWED) {
		this.facts = facts;
		this.current = initial;
	}

	get policy(): ModelPoolPolicy {
		return this.current;
	}

	allows(model: Model<Api>): boolean {
		return this.current[modelPoolOf(model, this.facts)];
	}

	/** The subset of `models` the policy allows, in the given order. */
	allowed<T extends Model<Api>>(models: readonly T[]): T[] {
		return models.filter((model) => this.allows(model));
	}

	/**
	 * Apply the pools a request turned on or off. A change that would leave none of `candidates`
	 * allowed is refused with the reason, and the policy stays as it was.
	 */
	apply(change: ModelPoolChange, candidates: readonly Model<Api>[]): PolicyChangeOutcome {
		const next: ModelPoolPolicy = { ...this.current, ...change };
		if (MODEL_POOLS.every((pool) => next[pool] === this.current[pool])) return { kind: "unchanged" };
		if (!candidates.some((model) => next[modelPoolOf(model, this.facts)]))
			return {
				kind: "refused",
				reason: `${describePolicy(next)} leaves no model in the pool to allocate; kept ${describePolicy(this.current)}`,
			};
		this.current = Object.freeze(next);
		return { kind: "applied", policy: this.current };
	}
}
