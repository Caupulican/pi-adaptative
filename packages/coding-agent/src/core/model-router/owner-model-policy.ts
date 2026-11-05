/**
 * The owner's model policy for this session: which pools of language models may be allocated. The
 * owner changes it by saying so ("we can only use subscription models", "turn API models back on",
 * "no subscription models now"); System One reads the request, and the next allocation, of any
 * foreground turn, worker, lane or consult, reads the policy at the moment it picks. Nothing is
 * restarted and nothing is refused: a model outside the policy is simply never allocated, and work
 * pinned to one is reallocated to the best allowed model. System One is not a pool here; it judges, it is
 * not allocated.
 *
 * The policy lives on the session branch: each change is a `pi_model_pool_policy` record, and the
 * policy in force is the latest record on the current branch, so a resumed, forked or re-branched
 * session allows exactly what the owner said on that branch.
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

export const MODEL_POOL_POLICY_CUSTOM_TYPE = "pi_model_pool_policy";

export interface ModelPoolPolicyRecord {
	readonly version: 1;
	readonly policy: ModelPoolPolicy;
	readonly changedAt: string;
}

function poolPolicyRecord(value: unknown): ModelPoolPolicyRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as { version?: unknown; policy?: unknown; changedAt?: unknown };
	const policy = record.policy as Record<string, unknown> | undefined;
	if (record.version !== 1 || !policy || typeof policy !== "object" || typeof record.changedAt !== "string")
		return undefined;
	if (!MODEL_POOLS.every((pool) => typeof policy[pool] === "boolean")) return undefined;
	return {
		version: 1,
		policy: Object.freeze({
			subscription: policy.subscription,
			metered: policy.metered,
			local: policy.local,
		}) as ModelPoolPolicy,
		changedAt: record.changedAt,
	};
}

/** The policy the latest pool-policy record on `branch` states, or undefined when the branch has none. */
export function latestPoolPolicy(
	branch: readonly { type: string; customType?: string; data?: unknown }[],
): ModelPoolPolicy | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "custom" || entry.customType !== MODEL_POOL_POLICY_CUSTOM_TYPE) continue;
		const record = poolPolicyRecord(entry.data);
		if (record) return record.policy;
	}
	return undefined;
}

/** The reader of a session's branch the policy in force is read from. */
export interface PoolPolicyBranchReader {
	getSessionId(): string;
	getLeafId(): string | null;
	getBranch(): readonly { type: string; customType?: string; data?: unknown }[];
}

/** The policy in force on a reader's branch, read once per branch position: allocation asks per candidate model. */
export function branchPoolPolicyReader(getReader: () => PoolPolicyBranchReader): () => ModelPoolPolicy | undefined {
	let read: { branchKey: string; policy: ModelPoolPolicy | undefined } | undefined;
	return () => {
		const reader = getReader();
		const branchKey = `${reader.getSessionId()}:${reader.getLeafId() ?? ""}`;
		if (read?.branchKey !== branchKey) read = { branchKey, policy: latestPoolPolicy(reader.getBranch()) };
		return read.policy;
	};
}

/** Where the policy is kept: read at every allocation, written on every applied change. */
export interface ModelPoolPolicyStore {
	read(): ModelPoolPolicy | undefined;
	record(record: ModelPoolPolicyRecord): void;
}

/**
 * The policy as its readers see it: the pools in force and the models they allow. Built from a reader of the branch
 * alone, so a parent opened away allocates its workers under the owner's policy without the means to change it.
 */
export class ModelPoolPolicyView {
	protected readonly facts: ModelPoolFacts;
	private readonly readPolicy: () => ModelPoolPolicy | undefined;

	constructor(facts: ModelPoolFacts, read: () => ModelPoolPolicy | undefined) {
		this.facts = facts;
		this.readPolicy = read;
	}

	get policy(): ModelPoolPolicy {
		return this.readPolicy() ?? ALL_POOLS_ALLOWED;
	}

	allows(model: Model<Api>): boolean {
		return this.policy[modelPoolOf(model, this.facts)];
	}

	/** The subset of `models` the policy allows, in the given order. */
	allowed<T extends Model<Api>>(models: readonly T[]): T[] {
		return models.filter((model) => this.allows(model));
	}
}

/** Session-scoped policy the owner's words change. Readers call `allows` at the moment they allocate. */
export class OwnerModelPolicy extends ModelPoolPolicyView {
	private readonly store: ModelPoolPolicyStore;

	constructor(facts: ModelPoolFacts, store: ModelPoolPolicyStore) {
		super(facts, () => store.read());
		this.store = store;
	}

	/**
	 * Apply the pools a request turned on or off. A change that would leave none of `candidates`
	 * allowed is refused with the reason, and the policy stays as it was.
	 */
	apply(change: ModelPoolChange, candidates: readonly Model<Api>[]): PolicyChangeOutcome {
		const current = this.policy;
		const next: ModelPoolPolicy = Object.freeze({ ...current, ...change });
		if (MODEL_POOLS.every((pool) => next[pool] === current[pool])) return { kind: "unchanged" };
		if (!candidates.some((model) => next[modelPoolOf(model, this.facts)]))
			return {
				kind: "refused",
				reason: `${describePolicy(next)} leaves no model in the pool to allocate; kept ${describePolicy(current)}`,
			};
		this.store.record({ version: 1, policy: next, changedAt: new Date().toISOString() });
		return { kind: "applied", policy: next };
	}
}
