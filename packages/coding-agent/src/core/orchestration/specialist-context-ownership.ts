import { isPlainRecord } from "../util/value-guards.ts";

/** Process incarnation is opaque and host-issued; a parent id or PID alone cannot claim a context. */
export interface SpecialistContextOwner {
	parentSessionId: string;
	incarnation: string;
}

export interface SpecialistContextClaim extends SpecialistContextOwner {
	generation: number;
}

/** Provider-neutral ownership of a retained context, independent of individual task leases. */
export interface SpecialistContextOwnership {
	schemaVersion: 1;
	state: "busy" | "idle" | "retired";
	claim: SpecialistContextClaim;
}

function normalizeOwner(value: unknown): SpecialistContextOwner {
	if (
		!isPlainRecord(value) ||
		![value.parentSessionId, value.incarnation].every(
			(field) => typeof field === "string" && field.trim().length > 0 && field.length <= 512,
		)
	)
		throw new TypeError("Specialist context owner is invalid.");
	return { parentSessionId: value.parentSessionId as string, incarnation: value.incarnation as string };
}

export function normalizeSpecialistContextOwnership(value: unknown): SpecialistContextOwnership {
	if (
		!isPlainRecord(value) ||
		Object.keys(value).length !== 3 ||
		value.schemaVersion !== 1 ||
		!["busy", "idle", "retired"].includes(String(value.state)) ||
		!isPlainRecord(value.claim) ||
		Object.keys(value.claim).length !== 3 ||
		typeof value.claim.generation !== "number" ||
		!Number.isSafeInteger(value.claim.generation) ||
		value.claim.generation < 1
	)
		throw new TypeError("Specialist context ownership is invalid.");
	return {
		schemaVersion: 1,
		state: value.state as SpecialistContextOwnership["state"],
		claim: { ...normalizeOwner(value.claim), generation: value.claim.generation },
	};
}

export function createSpecialistContextOwnership(owner: SpecialistContextOwner): SpecialistContextOwnership {
	return { schemaVersion: 1, state: "busy", claim: { ...normalizeOwner(owner), generation: 1 } };
}

/** Must run inside the adapter's same critical section as its actual mutation. */
export function assertSpecialistContextClaim(
	ownership: SpecialistContextOwnership,
	claim?: SpecialistContextClaim,
): void {
	if (
		ownership.state !== "busy" ||
		!claim ||
		ownership.claim.generation !== claim.generation ||
		ownership.claim.parentSessionId !== claim.parentSessionId ||
		ownership.claim.incarnation !== claim.incarnation
	)
		throw new Error("Specialist context claim is stale or unavailable.");
}

/** A time limit or an unresponsive owner never proves cleanup. Only explicit idle state transfers. */
export function acquireSpecialistContext(
	ownership: SpecialistContextOwnership,
	owner: SpecialistContextOwner,
): SpecialistContextOwnership {
	const current = normalizeSpecialistContextOwnership(ownership);
	if (current.state !== "idle") throw new Error(`Specialist context is ${current.state}.`);
	if (current.claim.generation === Number.MAX_SAFE_INTEGER)
		throw new Error("Specialist context generation is exhausted.");
	return {
		schemaVersion: 1,
		state: "busy",
		claim: { ...normalizeOwner(owner), generation: current.claim.generation + 1 },
	};
}

/** Call only after the task executor, tool cleanup, and all executable obligations have settled. */
export function releaseSpecialistContext(
	ownership: SpecialistContextOwnership,
	claim: SpecialistContextClaim,
): SpecialistContextOwnership {
	assertSpecialistContextClaim(ownership, claim);
	return { ...normalizeSpecialistContextOwnership(ownership), state: "idle" };
}

export function retireSpecialistContext(
	ownership: SpecialistContextOwnership,
	claim: SpecialistContextClaim,
): SpecialistContextOwnership {
	assertSpecialistContextClaim(ownership, claim);
	return { ...normalizeSpecialistContextOwnership(ownership), state: "retired" };
}
