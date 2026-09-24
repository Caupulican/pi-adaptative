import { wrapUntrustedText } from "./security/untrusted-boundary.ts";

/**
 * Minions: read-only workers that gather what a retrieve route needs, each on a small brief, instead of
 * the talker reading on its whole prefix (KV-cache rule 3: a subagent gets a brief, never the context).
 * Their reports pass the same acceptance every worker report passes (claims checked against the
 * worker's own transcript), and only accepted reports reach the talker, as one bounded evidence record.
 */

/** Session record carrying gathered evidence into the talker's next turn. */
export const GATHERED_EVIDENCE_CUSTOM_TYPE = "gathered_evidence";

/**
 * The atomic questions a retrieve route asks: one per requirement System One targeted, or the objective
 * itself when the route targets none.
 */
export function gatheringQuestions(objective: string, targetRequirementIds: readonly string[]): string[] {
	if (targetRequirementIds.length === 0) {
		return [`Gather what the repository shows that this objective needs: ${objective}`];
	}
	return targetRequirementIds.map(
		(id) => `For requirement ${id} of this objective, gather what the repository shows about it: ${objective}`,
	);
}

/** Instructions a minion runs with: read, report findings with where they came from, change nothing. */
export function minionInstructions(question: string): string {
	return [
		question,
		"",
		"Read only; change nothing. Report each finding with the file path (and line) or command output it came from, and say plainly what you could not find.",
	].join("\n");
}

export interface MinionReport {
	readonly question: string;
	readonly accepted: boolean;
	/** The worker's own summary; untrusted until accepted. */
	readonly summary?: string;
	/** Why the report was not accepted, or why the worker did not start. */
	readonly reason?: string;
}

/** Run one minion per question, all at once; the worker admission bounds how many run concurrently. */
export async function gatherWithMinions(
	questions: readonly string[],
	run: (question: string) => Promise<MinionReport>,
): Promise<MinionReport[]> {
	return Promise.all(questions.map((question) => run(question)));
}

/**
 * One bounded evidence record: every accepted report, source-labeled as untrusted worker output, and a
 * line for each question that produced nothing accepted. Bounded by `maxChars`; later reports are cut
 * first, and the cut is stated.
 */
export function formatGatheredEvidence(reports: readonly MinionReport[], maxChars: number): string {
	const header = `Gathered evidence: ${reports.filter((report) => report.accepted).length} of ${reports.length} read-only workers returned accepted reports (each checked against its own transcript).`;
	const parts = [header];
	let used = header.length;
	let omitted = 0;
	for (const [index, report] of reports.entries()) {
		const body = report.accepted
			? wrapUntrustedText(report.summary ?? "(empty report)", `minion:${index + 1}`)
			: `(no accepted report: ${report.reason ?? "unknown"})`;
		const part = `\n\n### ${index + 1}. ${report.question}\n${body}`;
		if (used + part.length > maxChars) {
			omitted++;
			continue;
		}
		parts.push(part);
		used += part.length;
	}
	if (omitted > 0)
		parts.push(`\n\n(${omitted} report${omitted === 1 ? "" : "s"} omitted to stay within the record's bound)`);
	return parts.join("");
}
