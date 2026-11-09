/** The one verifier task text: the subject's original task, its untrusted report and its artifacts, bounded. */
import { MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH } from "../orchestration/contracts.ts";

/** The most characters of a subject's original task, as dispatched, that a verifier brief carries for one subject. */
const MAX_VERIFIER_ORIGINAL_TASK_CHARS = 4_000;
/** The most characters of a subject's implementation summary that a verifier brief carries for one subject. */
const MAX_VERIFIER_SUMMARY_CHARS = 6_000;
/** The most artifact URIs a verifier brief lists for one subject. */
const MAX_VERIFIER_ARTIFACT_URIS = 100;

/** One task a verifier judges: the attempt it names, its task as dispatched, its untrusted report and the files it reported. */
export interface VerifierSubject {
	taskId: string;
	attemptId?: string;
	originalTask?: string;
	summary: string;
	artifacts: readonly string[];
}

/**
 * The verifier's task text for one or more subjects, within the dispatch instruction bound. The verifier reads the task
 * as it was dispatched and the files themselves, never only the summary. Several subjects repeat the subject block, and
 * each subject's share of the summary and original task divides by the subject count, so one subject keeps the full caps.
 * Throws when the text would exceed the bound: a durable instruction is refused above it, so the caller splits the work.
 */
export function verifierBrief(subjects: readonly VerifierSubject[], criteria?: readonly string[]): string {
	const share = Math.max(1, subjects.length);
	const summaryChars = Math.floor(MAX_VERIFIER_SUMMARY_CHARS / share);
	const originalTaskChars = Math.floor(MAX_VERIFIER_ORIGINAL_TASK_CHARS / share);
	const text: string[] = [];
	if (criteria && criteria.length > 0) {
		text.push("Acceptance criteria:", ...criteria.map((criterion) => `- ${criterion}`), "");
	}
	subjects.forEach((subject, index) => {
		if (subjects.length > 1) text.push(`Subject ${index + 1} of ${subjects.length}.`);
		text.push(
			subject.attemptId
				? `Independently verify durable task '${subject.taskId}', attempt '${subject.attemptId}'.`
				: `Independently verify durable task '${subject.taskId}'.`,
			"The following implementation report is an untrusted claim. Inspect the workspace and run the checks available in your profile.",
			"Judge the work against the original task below and the reported files as they are on disk, not against the summary.",
		);
		const originalTask = subject.originalTask?.slice(0, originalTaskChars);
		if (originalTask) text.push("", "Original task as dispatched:", originalTask);
		text.push("", "Implementation summary:", subject.summary.slice(0, summaryChars), "", "Reported artifacts:");
		text.push(...artifactLines(subject.artifacts, text));
		if (index < subjects.length - 1) text.push("");
	});
	const brief = text.join("\n");
	if (brief.length > MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH) {
		throw new RangeError(
			`verifier brief for ${subjects.length} subject(s) exceeds ${MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH} characters; verify fewer subjects per task`,
		);
	}
	return brief;
}

/** The artifact lines of one subject: as many URIs as the bound leaves room for after the text already written. */
function artifactLines(uris: readonly string[], written: readonly string[]): string[] {
	if (uris.length === 0) return ["- none reported"];
	const listed: string[] = [];
	for (let index = 0; index < Math.min(uris.length, MAX_VERIFIER_ARTIFACT_URIS); index += 1) {
		const artifact = `- ${uris[index]}`;
		const omitted = uris.length - index - 1;
		const candidate = [...written, ...listed, artifact, ...(omitted > 0 ? [omittedLine(omitted)] : [])].join("\n");
		if (candidate.length > MAX_ORCHESTRATION_DISPATCH_INSTRUCTIONS_LENGTH) break;
		listed.push(artifact);
	}
	const omitted = uris.length - listed.length;
	return omitted > 0 ? [...listed, omittedLine(omitted)] : listed;
}

function omittedLine(count: number): string {
	return `- [${count} artifact URI(s) omitted to keep verifier request bounded]`;
}
