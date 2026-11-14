/**
 * What a goal's completion refusal records beside its reasons: the set of gates it failed (the key its repeat count is
 * kept under), the findings of the judgment that refused it, bounded previews whose full text is in the retained
 * evidence, and that evidence's identity. Each has its bounded copy and its guard for a persisted record.
 */

import { isPlainRecord } from "../util/value-guards.ts";

const MAX_GATE_SET_IDS = 16;
const MAX_GATE_ID_CHARS = 200;

/** The set of failed gate ids a completion refusal is counted under: sorted, unique and bounded. */
export function completionGateSet(failedGates: readonly { readonly id: string }[]): string[] {
	return [...new Set(failedGates.map((gate) => gate.id.slice(0, MAX_GATE_ID_CHARS)))]
		.sort()
		.slice(0, MAX_GATE_SET_IDS);
}

export function isGateSet(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length <= MAX_GATE_SET_IDS &&
		value.every((id) => typeof id === "string" && id.length <= MAX_GATE_ID_CHARS)
	);
}

export function sameGateSet(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
	return left !== undefined && right !== undefined && left.join("\n") === right.join("\n");
}

export interface GoalCompletionFinding {
	id: string;
	reason: string;
	required_next_proof?: string;
	/** The full field values are in the retained evidence, never inferred from this preview. */
	truncated?: true;
}

export interface GoalCompletionEvidence {
	id: string;
	sha256: string;
	bytes: number;
}

export const MAX_COMPLETION_FINDINGS = 12;

export function copyCompletionFindings(findings: readonly GoalCompletionFinding[]): GoalCompletionFinding[] {
	return findings.slice(0, MAX_COMPLETION_FINDINGS).map((finding) => ({
		id: finding.id.slice(0, 128),
		reason: finding.reason.slice(0, 500),
		...(finding.required_next_proof ? { required_next_proof: finding.required_next_proof.slice(0, 1000) } : {}),
		...(finding.truncated ||
		finding.id.length > 128 ||
		finding.reason.length > 500 ||
		(finding.required_next_proof?.length ?? 0) > 1000
			? { truncated: true as const }
			: {}),
	}));
}

export function isCompletionFindings(value: unknown): value is readonly GoalCompletionFinding[] {
	return (
		Array.isArray(value) &&
		value.length <= MAX_COMPLETION_FINDINGS &&
		value.every(
			(finding) =>
				isPlainRecord(finding) &&
				typeof finding.id === "string" &&
				finding.id.length <= 128 &&
				typeof finding.reason === "string" &&
				finding.reason.length <= 500 &&
				(finding.required_next_proof === undefined ||
					(typeof finding.required_next_proof === "string" && finding.required_next_proof.length <= 1000)) &&
				(finding.truncated === undefined || finding.truncated === true),
		)
	);
}

export function hasCompletionEvidence(value: Record<string, unknown>): boolean {
	if (value.evidence === undefined) return true;
	return (
		isPlainRecord(value.evidence) &&
		typeof value.evidence.id === "string" &&
		/^[a-f0-9]{24}$/.test(value.evidence.id) &&
		typeof value.evidence.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(value.evidence.sha256) &&
		Number.isSafeInteger(value.evidence.bytes) &&
		Number(value.evidence.bytes) >= 0
	);
}
