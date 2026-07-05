import type { CompactionFacts } from "./extraction.ts";

export interface VerificationFailure {
	check: string;
	detail: string;
}

export interface VerificationReport {
	ok: boolean;
	failures: VerificationFailure[];
}

export const FILES_READ_RECALL_THRESHOLD = 0.8;
export const ACTIVE_TASK_CONTAINMENT_THRESHOLD = 0.9;
export const MANDATORY_RULES_RECALL_THRESHOLD = 0.7;
export const CANCELLED_WORK_DROPPED_THRESHOLD = 0.1;
export const ACTIONS_OVERLAP_THRESHOLD = 0.5;

const SECTION_FILES = "files";
const SECTION_DONE = "done";
const SECTION_ACTIVE_TASK = "active task";
const SECTION_MANDATORY_RULES = "mandatory rules";

export function verifySummary(summary: string, facts: CompactionFacts): VerificationReport {
	if (factsAreEmpty(facts)) {
		return { ok: true, failures: [] };
	}

	const sections = extractSections(summary);
	const failures: VerificationFailure[] = [];
	const filesSection = sections[SECTION_FILES] ?? "";
	const doneSection = sections[SECTION_DONE] ?? "";
	const activeTaskSection = sections[SECTION_ACTIVE_TASK] ?? "";
	const mandatoryRulesSection = sections[SECTION_MANDATORY_RULES] ?? "";

	const modifiedFiles = facts.files.filter((file) => file.kind !== "read");
	const missingModifiedFiles = modifiedFiles.map((file) => file.path).filter((path) => !filesSection.includes(path));
	if (missingModifiedFiles.length > 0) {
		failures.push({
			check: "files-modified-recall",
			detail: `Missing modified/created files in ## Files: ${missingModifiedFiles.join(", ")}`,
		});
	}

	const readPaths = facts.files.filter((file) => file.kind === "read").map((file) => file.path);
	if (readPaths.length > 0) {
		const score = containment(tokenSet(readPaths.join("\n")), tokenSet(filesSection));
		if (score < FILES_READ_RECALL_THRESHOLD) {
			failures.push({
				check: "files-read-recall",
				detail: `Read file recall ${formatScore(score)} below ${FILES_READ_RECALL_THRESHOLD}`,
			});
		}
	}

	if (facts.activeTaskSource) {
		const score = containment(tokenSet(facts.activeTaskSource), tokenSet(activeTaskSection));
		if (score < ACTIVE_TASK_CONTAINMENT_THRESHOLD) {
			failures.push({
				check: "active-task-containment",
				detail: `Active task containment ${formatScore(score)} below ${ACTIVE_TASK_CONTAINMENT_THRESHOLD}`,
			});
		}
	}

	for (const prohibition of facts.prohibitions) {
		const score = containment(tokenSet(prohibition), tokenSet(mandatoryRulesSection));
		if (score < MANDATORY_RULES_RECALL_THRESHOLD) {
			failures.push({
				check: "mandatory-rules-recall",
				detail: `Missing mandatory rule: ${prohibition}`,
			});
		}
	}

	if (facts.cancelledText) {
		const summaryOutsideMandatoryRules = removeSection(summary, SECTION_MANDATORY_RULES);
		const score = containment(tokenSet(facts.cancelledText), tokenSet(summaryOutsideMandatoryRules));
		if (score > CANCELLED_WORK_DROPPED_THRESHOLD) {
			failures.push({
				check: "cancelled-work-dropped",
				detail: `Cancelled work leakage ${formatScore(score)} above ${CANCELLED_WORK_DROPPED_THRESHOLD}`,
			});
		}
	}

	if (facts.actions.length > 0) {
		const score = jaccard(tokenSet(facts.actions.join("\n")), tokenSet(doneSection));
		if (score < ACTIONS_OVERLAP_THRESHOLD) {
			failures.push({
				check: "actions-overlap",
				detail: `Done/actions Jaccard ${formatScore(score)} below ${ACTIONS_OVERLAP_THRESHOLD}`,
			});
		}
	}

	return { ok: failures.length === 0, failures };
}

export function buildRetryPrompt(report: VerificationReport, previousAttempt?: string): string {
	const failures = report.failures.map((failure) => `${failure.check}: ${failure.detail}`).join("; ");
	const previous = previousAttempt ? `\n\n<previous-attempt>\n${previousAttempt}\n</previous-attempt>` : "";
	return `Your previous checkpoint failed verification: ${failures}. Fix ONLY these omissions.${previous}`;
}

export function tokenSet(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9_./-]+/)
			.map((token) => token.trim())
			.filter((token) => token.length >= 3),
	);
}

export function containment(needle: Set<string>, hay: Set<string>): number {
	if (needle.size === 0) {
		return 1;
	}
	let hits = 0;
	for (const token of needle) {
		if (hay.has(token)) {
			hits += 1;
		}
	}
	return hits / needle.size;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) {
		return 1;
	}
	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) {
			intersection += 1;
		}
	}
	const union = new Set([...a, ...b]).size;
	return union === 0 ? 1 : intersection / union;
}

function factsAreEmpty(facts: CompactionFacts): boolean {
	return (
		facts.files.length === 0 &&
		facts.actions.length === 0 &&
		facts.prohibitions.length === 0 &&
		facts.cancelledText === "" &&
		facts.activeTaskSource === ""
	);
}

function extractSections(summary: string): Record<string, string> {
	const sections: Record<string, string> = {};
	let current: string | undefined;
	let bucket: string[] = [];

	const flush = (): void => {
		if (current) {
			sections[current] = bucket.join("\n").trim();
		}
		bucket = [];
	};

	for (const line of summary.split(/\r?\n/)) {
		const match = /^(?:##|###)\s+(.+?)\s*$/.exec(line);
		if (match) {
			flush();
			current = normalizeHeading(match[1]);
			continue;
		}
		if (current) {
			bucket.push(line);
		}
	}
	flush();
	return sections;
}

function removeSection(summary: string, heading: string): string {
	const normalizedHeading = normalizeHeading(heading);
	const kept: string[] = [];
	let skipping = false;
	for (const line of summary.split(/\r?\n/)) {
		const match = /^(?:##|###)\s+(.+?)\s*$/.exec(line);
		if (match) {
			skipping = normalizeHeading(match[1]) === normalizedHeading;
			if (skipping) {
				continue;
			}
		}
		if (!skipping) {
			kept.push(line);
		}
	}
	return kept.join("\n");
}

function normalizeHeading(heading: string): string {
	return heading.trim().toLowerCase();
}

function formatScore(score: number): string {
	return score.toFixed(2);
}
