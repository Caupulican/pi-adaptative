import type { Finding } from "./contracts.ts";

/** Provider-neutral finding shape after model-output validation and before evidence projection. */
export interface EvidenceFindingDraft {
	summary: string;
	confidence?: number;
}

/** Normalizes one untrusted model finding without retaining its source object. */
export function normalizeEvidenceFinding(value: unknown, maxSummaryChars?: number): EvidenceFindingDraft | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const summaryValue = (value as { summary?: unknown }).summary;
	if (typeof summaryValue !== "string") return undefined;
	const trimmedSummary = summaryValue.trim();
	if (trimmedSummary.length === 0) return undefined;
	const summary =
		maxSummaryChars !== undefined && trimmedSummary.length > maxSummaryChars
			? trimmedSummary.slice(0, maxSummaryChars)
			: trimmedSummary;
	const confidenceValue = (value as { confidence?: unknown }).confidence;
	const confidence =
		typeof confidenceValue === "number" && Number.isFinite(confidenceValue)
			? Math.min(Math.max(confidenceValue, 0), 1)
			: undefined;
	return { summary, confidence };
}

/** Projects normalized drafts into stable bundle records tied to one provenance source. */
export function projectEvidenceFindings(
	findings: readonly EvidenceFindingDraft[],
	evidenceId: string,
	maxFindings = findings.length,
): Finding[] {
	const count = Math.min(findings.length, maxFindings);
	const projected: Finding[] = [];
	for (let index = 0; index < count; index++) {
		const finding = findings[index];
		if (!finding) continue;
		projected.push({
			id: `finding-${index + 1}`,
			summary: finding.summary,
			evidenceIds: [evidenceId],
			...(finding.confidence !== undefined ? { confidence: finding.confidence } : {}),
		});
	}
	return projected;
}
