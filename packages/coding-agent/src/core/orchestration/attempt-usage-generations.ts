import {
	addAttemptUsage,
	attemptUsageIncrease,
	EMPTY_ATTEMPT_USAGE,
	reconcileAttemptUsage,
	validateAttemptUsageSnapshot,
} from "./attempt-usage.ts";
import type { AttemptLease, AttemptUsageSnapshot } from "./contracts.ts";

export type AttemptUsageGenerationIdentity = Pick<AttemptLease, "leaseId" | "fencingToken">;

export interface AttemptUsageGeneration {
	readonly fencingToken: number;
	/** The exact cumulative total used to initialize this generation's local counters. */
	readonly baseline: AttemptUsageSnapshot;
	/** Latest cumulative local counters, including this generation's immutable baseline. */
	readonly reported: AttemptUsageSnapshot;
}

export interface AttemptUsageAccounting {
	readonly total: AttemptUsageSnapshot;
	readonly generations: Readonly<Record<string, AttemptUsageGeneration>>;
}

function sameUsage(left: AttemptUsageSnapshot, right: AttemptUsageSnapshot): boolean {
	return (Object.keys(EMPTY_ATTEMPT_USAGE) as Array<keyof AttemptUsageSnapshot>).every(
		(key) => left[key] === right[key],
	);
}

function findUsageGeneration(
	accounting: AttemptUsageAccounting,
	identity: AttemptUsageGenerationIdentity,
): AttemptUsageGeneration | undefined {
	if (!Object.hasOwn(accounting.generations, identity.leaseId)) return undefined;
	const generation = accounting.generations[identity.leaseId];
	if (generation.fencingToken !== identity.fencingToken) {
		throw new Error("Usage generation fence does not match its registered lease.");
	}
	return generation;
}

/** Canonical projection from attributed counters, independent of report arrival order. */
export function totalAttemptGenerationUsage(
	generations: Readonly<Record<string, AttemptUsageGeneration>>,
): AttemptUsageSnapshot {
	const ordered = Object.values(generations).sort((left, right) => left.fencingToken - right.fencingToken);
	if (ordered.length === 0) throw new Error("Usage accounting requires a registered generation.");
	let total = validateAttemptUsageSnapshot(ordered[0].baseline);
	for (const generation of ordered) {
		total = addAttemptUsage(
			total,
			attemptUsageIncrease(generation.reported, generation.baseline),
			"generation accounting",
		);
	}
	return total;
}

/**
 * Register accounting only after the durable runtime admits the live execution generation.
 * Recovery can initialize the first generation; subsequent generations inherit this owner's
 * total. Merging another anonymous baseline later could duplicate a pending generation report.
 */
export function beginAttemptUsageGeneration(
	accounting: AttemptUsageAccounting | undefined,
	identity: AttemptUsageGenerationIdentity,
	recoveryBaseline?: AttemptUsageSnapshot,
): AttemptUsageAccounting {
	const registered = accounting ? findUsageGeneration(accounting, identity) : undefined;
	if (accounting && registered) {
		if (recoveryBaseline !== undefined) {
			const replayed = validateAttemptUsageSnapshot(recoveryBaseline, "usage generation baseline");
			if (!sameUsage(replayed, registered.baseline)) {
				throw new Error("Usage generation registration has a conflicting baseline.");
			}
		}
		return accounting;
	}
	if (accounting && recoveryBaseline !== undefined) {
		throw new Error("Recovery baseline is only valid before accounting begins.");
	}
	if (!accounting && recoveryBaseline === undefined) throw new Error("Initial usage accounting requires a baseline.");
	if (
		accounting &&
		Object.values(accounting.generations).some((epoch) => epoch.fencingToken === identity.fencingToken)
	) {
		throw new Error("Usage generation fence is already registered to another lease.");
	}
	const baseline = validateAttemptUsageSnapshot(accounting?.total ?? recoveryBaseline!, "usage generation baseline");
	return {
		total: baseline,
		generations: {
			...accounting?.generations,
			[identity.leaseId]: { fencingToken: identity.fencingToken, baseline, reported: baseline },
		},
	};
}

/**
 * Record a received charge without granting execution authority. Registration establishes the
 * generation identity; late reports keep that identity across suspension or a subsequent resume.
 * The caller's local counters must never absorb another generation's external corrections.
 */
export function recordAttemptGenerationUsage(
	accounting: AttemptUsageAccounting,
	identity: AttemptUsageGenerationIdentity,
	usage: AttemptUsageSnapshot,
): AttemptUsageAccounting {
	const generation = findUsageGeneration(accounting, identity);
	if (!generation) throw new Error("Usage generation is not registered.");
	const reported = validateAttemptUsageSnapshot(usage, "generation usage report");
	const delta = attemptUsageIncrease(reported, generation.reported);
	if (Object.values(delta).every((value) => value === 0)) return accounting;
	const generations = { ...accounting.generations, [identity.leaseId]: { ...generation, reported } };
	return { total: totalAttemptGenerationUsage(generations), generations };
}

/** Overlay this generation's received but possibly unwritten counters without changing durable state. */
export function projectPendingAttemptGenerationUsage(
	accounting: AttemptUsageAccounting,
	identity: AttemptUsageGenerationIdentity,
	local: AttemptUsageSnapshot,
): AttemptUsageAccounting {
	const generation = findUsageGeneration(accounting, identity);
	if (!generation) throw new Error("Usage generation is not registered.");
	return recordAttemptGenerationUsage(accounting, identity, reconcileAttemptUsage(generation.reported, local));
}

/**
 * Combine received publications by their registered generation, never by anonymous attempt totals.
 * Old and resumed gateways can each hold an unwritten charge. Per-generation maxima preserve both
 * while repeated, stale and subsequently persisted publications remain idempotent.
 */
export function reconcileAttemptUsageAccounting(
	previous: AttemptUsageAccounting | undefined,
	incoming: AttemptUsageAccounting,
): AttemptUsageAccounting {
	const generations: Record<string, AttemptUsageGeneration> = {};
	const leasesByFence = new Map<number, string>();
	for (const accounting of previous ? [previous, incoming] : [incoming]) {
		const total = validateAttemptUsageSnapshot(accounting.total);
		if (!sameUsage(total, totalAttemptGenerationUsage(accounting.generations))) {
			throw new Error("Usage publication total does not match its generations.");
		}
		for (const [leaseId, generation] of Object.entries(accounting.generations)) {
			if (!leaseId || !Number.isSafeInteger(generation.fencingToken) || generation.fencingToken < 1) {
				throw new Error("Usage publication has an invalid generation identity.");
			}
			const registeredLease = leasesByFence.get(generation.fencingToken);
			if (registeredLease !== undefined && registeredLease !== leaseId) {
				throw new Error("Usage generation fence is already registered to another lease.");
			}
			const baseline = validateAttemptUsageSnapshot(generation.baseline);
			const reported = validateAttemptUsageSnapshot(generation.reported);
			const existing = Object.hasOwn(generations, leaseId) ? generations[leaseId] : undefined;
			if (
				existing &&
				(existing.fencingToken !== generation.fencingToken || !sameUsage(existing.baseline, baseline))
			) {
				throw new Error("Usage publication has conflicting generation provenance.");
			}
			// Define a data property so even a lease named __proto__ cannot change the registry prototype.
			Object.defineProperty(generations, leaseId, {
				value: {
					fencingToken: generation.fencingToken,
					baseline,
					reported: existing ? reconcileAttemptUsage(existing.reported, reported) : reported,
				},
				enumerable: true,
				configurable: true,
				writable: true,
			});
			leasesByFence.set(generation.fencingToken, leaseId);
		}
	}
	return { total: totalAttemptGenerationUsage(generations), generations };
}
