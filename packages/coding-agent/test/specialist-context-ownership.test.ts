import { expect, it } from "vitest";
import {
	acquireSpecialistContext,
	assertSpecialistContextClaim,
	createSpecialistContextOwnership,
	normalizeSpecialistContextOwnership,
	releaseSpecialistContext,
	retireSpecialistContext,
} from "../src/core/orchestration/specialist-context-ownership.ts";

const first = { parentSessionId: "parent-a", incarnation: "process-a" };
const second = { parentSessionId: "parent-b", incarnation: "process-b" };

it("transfers only a released context and rejects the previous generation even for the same parent", () => {
	const original = createSpecialistContextOwnership(first);
	expect(() => acquireSpecialistContext(original, second)).toThrow(/busy/i);
	const idle = releaseSpecialistContext(original, original.claim);
	expect(() => assertSpecialistContextClaim(idle, original.claim)).toThrow();
	const current = acquireSpecialistContext(idle, second);
	expect(current.claim.generation).toBe(2);
	expect(() => assertSpecialistContextClaim(current, original.claim)).toThrow();
	expect(() => releaseSpecialistContext(current, original.claim)).toThrow();
	expect(() => assertSpecialistContextClaim(current, current.claim)).not.toThrow();
	const next = acquireSpecialistContext(releaseSpecialistContext(current, current.claim), second);
	expect(() => assertSpecialistContextClaim(next, current.claim)).toThrow();
	expect(next.claim.generation).toBe(3);
});

it("never revives a retired context and does not confuse another process incarnation with its owner", () => {
	const original = createSpecialistContextOwnership(first);
	const replacement = { ...original.claim, incarnation: "replacement-process" };
	expect(() => assertSpecialistContextClaim(original, replacement)).toThrow();
	expect(() => retireSpecialistContext(original, replacement)).toThrow();
	const retired = retireSpecialistContext(original, original.claim);
	expect(() => acquireSpecialistContext(retired, first)).toThrow(/retired/i);
	expect(() => assertSpecialistContextClaim(retired, original.claim)).toThrow();
});

it("normalization returns a detached bounded value and rejects malformed durable authority", () => {
	const original = createSpecialistContextOwnership(first);
	const normalized = normalizeSpecialistContextOwnership(original);
	expect(normalized).toEqual(original);
	expect(normalized.claim).not.toBe(original.claim);
	for (const value of [
		null,
		{ ...original, schemaVersion: 2 },
		{ ...original, state: "available_after_timeout" },
		{ ...original, expiresAt: "already-expired" },
		{ ...original, claim: { ...original.claim, generation: 0 } },
		{ ...original, claim: { ...original.claim, generation: 1.5 } },
		{ ...original, claim: { ...original.claim, parentSessionId: " " } },
		{ ...original, claim: { ...original.claim, incarnation: "x".repeat(513) } },
	])
		expect(() => normalizeSpecialistContextOwnership(value)).toThrow();
	const exhausted = {
		...original,
		state: "idle" as const,
		claim: { ...original.claim, generation: Number.MAX_SAFE_INTEGER },
	};
	expect(() => acquireSpecialistContext(exhausted, second)).toThrow();
});

it("adversarial action sequences keep exactly one current claim and never mutate earlier receipts", () => {
	let current = createSpecialistContextOwnership(first);
	const receipts = [structuredClone(current.claim)];
	for (let index = 0; index < 100; index++) {
		const before = structuredClone(current);
		const idle = releaseSpecialistContext(current, current.claim);
		expect(current).toEqual(before);
		current = acquireSpecialistContext(idle, index % 2 ? first : second);
		for (const stale of receipts) expect(() => assertSpecialistContextClaim(current, stale)).toThrow();
		expect(() => assertSpecialistContextClaim(current, current.claim)).not.toThrow();
		receipts.push(structuredClone(current.claim));
	}
});
