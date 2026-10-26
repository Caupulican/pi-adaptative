import type { CompletionRejectionDetail } from "./policy.ts";
import type { AcceptanceCriterionStatus, VerificationStatus } from "./types.ts";

/** One required outcome with what shows it, as the completion projection reports it. */
export interface OutcomeEvidenceRow {
	readonly criterion_id: string;
	readonly text: string;
	readonly required: boolean;
	readonly status: AcceptanceCriterionStatus;
	readonly checks: readonly { readonly command: string | null; readonly status: VerificationStatus }[];
	readonly evidence: readonly unknown[];
}

/** The completion questions that judge outcome evidence as a whole and so name no outcome themselves. */
const OUTCOME_FINDING_IDS: ReadonlySet<string> = new Set(["JEV-outcomes_achieved", "JEV-required_behavior_unverified"]);

const MAX_LISTED_OUTCOMES = 6;
const MAX_OUTCOME_TEXT = 140;

function oneLine(text: string, limit: number): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Why a required outcome is not shown, or undefined when a passed check or cited evidence shows it. */
function gapOf(row: OutcomeEvidenceRow): string | undefined {
	if (row.status === "waived") return undefined;
	const passed = row.checks.some((check) => check.status === "passed");
	if (passed) return undefined;
	const failed = row.checks.find((check) => check.status === "failed" || check.status === "inconclusive");
	if (failed) return `its check ${failed.command ? `\`${oneLine(failed.command, 80)}\` ` : ""}is ${failed.status}`;
	if (row.evidence.length > 0) return undefined;
	return "no check covers it and no evidence is cited for it";
}

/**
 * The required outcomes the evidence does not show. Completion asks one question over all of them, so the finding it raises
 * names none; this names each, so the next proof is a specific check or evidence rather than a search for what was meant.
 */
export function unshownOutcomes(
	rows: readonly OutcomeEvidenceRow[],
): readonly { id: string; text: string; gap: string }[] {
	const gaps: { id: string; text: string; gap: string }[] = [];
	for (const row of rows) {
		if (!row.required) continue;
		const gap = gapOf(row);
		if (gap) gaps.push({ id: row.criterion_id, text: row.text, gap });
	}
	return gaps;
}

/**
 * Makes an outcome finding concrete. Other findings pass through unchanged. When every required outcome already has a passed
 * check or cited evidence, the judgment is that this evidence does not show the outcome, and the finding says so.
 */
export function concretizeOutcomeFinding(
	finding: CompletionRejectionDetail,
	rows: readonly OutcomeEvidenceRow[],
): CompletionRejectionDetail {
	if (!OUTCOME_FINDING_IDS.has(finding.id)) return finding;
	const gaps = unshownOutcomes(rows);
	if (gaps.length === 0) {
		return {
			...finding,
			reason: `${finding.reason} Every required outcome has a passed check or cited evidence, and System One judged that evidence does not show the outcome; the outcomes are ${rows
				.filter((row) => row.required)
				.slice(0, MAX_LISTED_OUTCOMES)
				.map((row) => `${row.criterion_id} "${oneLine(row.text, MAX_OUTCOME_TEXT)}"`)
				.join("; ")}.`,
			required_next_proof:
				"Add evidence that observes the outcome itself (the observed behavior, not that a check ran), or show a failed outcome is repaired.",
		};
	}
	const listed = gaps.slice(0, MAX_LISTED_OUTCOMES);
	const omitted = gaps.length - listed.length;
	return {
		...finding,
		reason: `${finding.reason} Not shown: ${listed.map((gap) => `${gap.id} "${oneLine(gap.text, MAX_OUTCOME_TEXT)}" (${gap.gap})`).join("; ")}${omitted > 0 ? `; and ${omitted} more` : ""}.`,
		required_next_proof: `For ${listed.map((gap) => gap.id).join(", ")}: cite verified evidence with goal add_evidence (requirementIds) that shows the outcome, or give the requirement a passing check, then retry completion.`,
	};
}
