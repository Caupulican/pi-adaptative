import { ACTIVE_TASK_SOURCE_MAX_CHARS, type CompactionFacts } from "./extraction.ts";

export interface VerificationFailure {
	check: string;
	detail: string;
}

export interface VerificationReport {
	ok: boolean;
	failures: VerificationFailure[];
}

export interface DeterministicGapFillResult {
	summary: string;
	verification: VerificationReport;
	changed: boolean;
}

export const FILES_READ_RECALL_THRESHOLD = 0.8;
export const ACTIVE_TASK_CONTAINMENT_THRESHOLD = 0.9;
export const MANDATORY_RULES_RECALL_THRESHOLD = 0.7;
export const CANCELLED_WORK_DROPPED_THRESHOLD = 0.1;
export const ACTIONS_RECALL_THRESHOLD = 0.6;
export const OPEN_ERRORS_RECALL_THRESHOLD = 0.7;

const SECTION_FILES = "files";
const SECTION_WORKING_SET = "working set";
const SECTION_OPEN_PROBLEMS = "open problems";
const SECTION_DONE = "done";
const SECTION_ACTIVE_TASK = "active task";
const SECTION_MANDATORY_RULES = "mandatory rules";
const SECTION_KEY_DECISIONS = "key decisions";
const SECTION_CONSTRAINTS = "constraints & preferences";
const SECTION_CRITICAL_CONTEXT = "critical context";

interface ParsedSummarySection {
	heading: string;
	normalized: string;
	level: "##" | "###";
	lines: string[];
}

const REQUIRED_SUMMARY_SECTIONS: Array<{ heading: string; normalized: string; level: "##" | "###" }> = [
	{ heading: "Active Task", normalized: SECTION_ACTIVE_TASK, level: "##" },
	{ heading: "Mandatory Rules", normalized: SECTION_MANDATORY_RULES, level: "###" },
	{ heading: "Working Set", normalized: SECTION_WORKING_SET, level: "##" },
	{ heading: "Files", normalized: SECTION_FILES, level: "##" },
	{ heading: "Open Problems", normalized: SECTION_OPEN_PROBLEMS, level: "##" },
	{ heading: "Done", normalized: SECTION_DONE, level: "##" },
	{ heading: "Key Decisions", normalized: SECTION_KEY_DECISIONS, level: "##" },
	{ heading: "Constraints & Preferences", normalized: SECTION_CONSTRAINTS, level: "##" },
	{ heading: "Critical Context", normalized: SECTION_CRITICAL_CONTEXT, level: "##" },
];

export function verifySummary(summary: string, facts: CompactionFacts): VerificationReport {
	if (factsAreEmpty(facts)) {
		return { ok: true, failures: [] };
	}

	const sections = extractSections(summary);
	const failures: VerificationFailure[] = [];
	const filesSection = sections[SECTION_FILES] ?? "";
	const workingSetSection = sections[SECTION_WORKING_SET] ?? "";
	const openProblemsSection = sections[SECTION_OPEN_PROBLEMS] ?? "";
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

	const workingSetPaths = facts.workingSet.map((file) => file.path);
	const missingWorkingSetPaths = workingSetPaths.filter((path) => !workingSetSection.includes(path));
	if (missingWorkingSetPaths.length > 0) {
		failures.push({
			check: "working-set-recall",
			detail: `Missing working-set files in ## Working Set: ${missingWorkingSetPaths.join(", ")}`,
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
		const score = containment(
			tokenSet(facts.activeTaskSource.slice(0, ACTIVE_TASK_SOURCE_MAX_CHARS)),
			tokenSet(activeTaskSection),
		);
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
		// File paths from the facts are REQUIRED elsewhere (files-modified/read-recall demand them
		// in ## Files), so counting them as cancelled-work leakage would make the two gates
		// unsatisfiable together whenever a reversal message references a touched file.
		const factPathTokens = tokenSet(facts.files.map((file) => file.path).join("\n"));
		const cancelledTokens = new Set([...tokenSet(facts.cancelledText)].filter((token) => !factPathTokens.has(token)));
		const score = containment(cancelledTokens, tokenSet(summaryOutsideMandatoryRules));
		if (score > CANCELLED_WORK_DROPPED_THRESHOLD) {
			failures.push({
				check: "cancelled-work-dropped",
				detail: `Cancelled work leakage ${formatScore(score)} above ${CANCELLED_WORK_DROPPED_THRESHOLD}`,
			});
		}
	}

	for (const error of facts.errorFacts) {
		const score = containment(tokenSet(`${error.operation}: ${error.error}`), tokenSet(openProblemsSection));
		if (score < OPEN_ERRORS_RECALL_THRESHOLD) {
			failures.push({
				check: "open-errors-recall",
				detail: `Open error recall ${formatScore(score)} below ${OPEN_ERRORS_RECALL_THRESHOLD}: ${error.operation}`,
			});
		}
	}

	if (facts.actions.length > 0) {
		// Asymmetric on purpose: the update path carries prior ## Done items forward (bounded), so a
		// symmetric overlap metric would punish faithful carry-over — the gate demands only that the
		// NEW span's actions are recalled in ## Done, however much history rides alongside them.
		const score = containment(tokenSet(facts.actions.join("\n")), tokenSet(doneSection));
		if (score < ACTIONS_RECALL_THRESHOLD) {
			failures.push({
				check: "actions-recall",
				detail: `New-action recall in ## Done ${formatScore(score)} below ${ACTIONS_RECALL_THRESHOLD}`,
			});
		}
	}

	return { ok: failures.length === 0, failures };
}

export function isCompactionSummaryStructurallyUsable(summary: string): boolean {
	if (summary.trim().length === 0) return false;
	const sections = extractSections(summary);
	return (
		sections[SECTION_ACTIVE_TASK] !== undefined ||
		sections[SECTION_FILES] !== undefined ||
		sections[SECTION_DONE] !== undefined ||
		sections[SECTION_WORKING_SET] !== undefined ||
		sections[SECTION_OPEN_PROBLEMS] !== undefined
	);
}

export function deterministicallyFillSummaryGaps(summary: string, facts: CompactionFacts): DeterministicGapFillResult {
	if (!isCompactionSummaryStructurallyUsable(summary)) {
		return { summary, verification: verifySummary(summary, facts), changed: false };
	}

	const sections = parseSummarySections(summary);
	const sectionByName = new Map<string, ParsedSummarySection>();
	const extraSections: ParsedSummarySection[] = [];
	for (const section of sections) {
		if (REQUIRED_SUMMARY_SECTIONS.some((required) => required.normalized === section.normalized)) {
			const existing = sectionByName.get(section.normalized);
			if (existing) {
				existing.lines.push(...section.lines);
			} else {
				sectionByName.set(section.normalized, section);
			}
		} else {
			extraSections.push(section);
		}
	}

	for (const required of REQUIRED_SUMMARY_SECTIONS) {
		if (!sectionByName.has(required.normalized)) {
			sectionByName.set(required.normalized, {
				heading: required.heading,
				normalized: required.normalized,
				level: required.level,
				lines: ["(none)"],
			});
		}
	}

	removeCancelledWorkLines(sectionByName, facts);

	if (facts.activeTaskSource) {
		const activeTask = sectionByName.get(SECTION_ACTIVE_TASK)!;
		if (
			containment(tokenSet(facts.activeTaskSource), tokenSet(activeTask.lines.join("\n"))) <
			ACTIVE_TASK_CONTAINMENT_THRESHOLD
		) {
			appendContentLine(activeTask.lines, `User: ${facts.activeTaskSource}`);
		}
	}

	const mandatoryRules = sectionByName.get(SECTION_MANDATORY_RULES)!;
	for (const rule of facts.prohibitions) {
		if (containment(tokenSet(rule), tokenSet(mandatoryRules.lines.join("\n"))) < MANDATORY_RULES_RECALL_THRESHOLD) {
			appendContentLine(mandatoryRules.lines, `- ${rule}`);
		}
	}

	const workingSet = sectionByName.get(SECTION_WORKING_SET)!;
	for (const file of facts.workingSet) {
		if (!workingSet.lines.join("\n").includes(file.path)) {
			appendContentLine(workingSet.lines, `- ${file.path} — ${file.note || file.kind}`);
		}
	}

	const files = sectionByName.get(SECTION_FILES)!;
	for (const file of facts.files) {
		if (!files.lines.join("\n").includes(file.path)) {
			appendContentLine(files.lines, `- ${file.path}`);
		}
	}

	const openProblems = sectionByName.get(SECTION_OPEN_PROBLEMS)!;
	for (const error of facts.errorFacts) {
		const required = `${error.operation}: ${error.error}`;
		if (containment(tokenSet(required), tokenSet(openProblems.lines.join("\n"))) < OPEN_ERRORS_RECALL_THRESHOLD) {
			appendContentLine(openProblems.lines, `- ${required}`);
		}
	}

	const done = sectionByName.get(SECTION_DONE)!;
	const doneText = done.lines.join("\n");
	if (
		facts.actions.length > 0 &&
		containment(tokenSet(facts.actions.join("\n")), tokenSet(doneText)) < ACTIONS_RECALL_THRESHOLD
	) {
		let nextNumber = findNextDoneNumber(done.lines);
		for (const action of facts.actions) {
			if (done.lines.join("\n").includes(action)) {
				continue;
			}
			appendContentLine(done.lines, `${nextNumber}. ${action}`);
			nextNumber++;
		}
	}

	const filledSummary = renderSummarySections(sectionByName, extraSections);
	return {
		summary: filledSummary,
		verification: verifySummary(filledSummary, facts),
		changed: filledSummary !== summary,
	};
}

export function buildRetryPrompt(report: VerificationReport, previousAttempt?: string): string {
	const failures = report.failures.map((failure) => `${failure.check}: ${failure.detail}`).join("; ");
	const previous = previousAttempt ? `\n\n<previous-attempt>\n${previousAttempt}\n</previous-attempt>` : "";
	return `Your previous checkpoint failed verification: ${failures}. Fix ONLY these omissions.${previous}`;
}

function parseSummarySections(summary: string): ParsedSummarySection[] {
	const sections: ParsedSummarySection[] = [];
	let current: ParsedSummarySection | undefined;

	for (const line of summary.split(/\r?\n/)) {
		const match = /^(##|###)\s+(.+?)\s*$/.exec(line);
		if (match) {
			current = {
				heading: match[2],
				normalized: normalizeHeading(match[2]),
				level: match[1] as "##" | "###",
				lines: [],
			};
			sections.push(current);
			continue;
		}
		if (current) {
			current.lines.push(line);
		}
	}

	return sections;
}

function renderSummarySections(
	sectionByName: Map<string, ParsedSummarySection>,
	extraSections: ParsedSummarySection[],
): string {
	const rendered: string[] = [];
	for (const required of REQUIRED_SUMMARY_SECTIONS) {
		const section = sectionByName.get(required.normalized)!;
		rendered.push(`${required.level} ${required.heading}`);
		const body = normalizeSectionLines(section.lines);
		rendered.push(...body);
		rendered.push("");
	}
	for (const section of extraSections) {
		rendered.push(`${section.level} ${section.heading}`);
		rendered.push(...normalizeSectionLines(section.lines));
		rendered.push("");
	}
	return rendered.join("\n").trimEnd();
}

function normalizeSectionLines(lines: string[]): string[] {
	const trimmed = lines.map((line) => line.trimEnd());
	while (trimmed.length > 0 && trimmed[0].trim() === "") trimmed.shift();
	while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === "") trimmed.pop();
	return trimmed.length > 0 ? trimmed : ["(none)"];
}

function appendContentLine(lines: string[], line: string): void {
	const normalized = normalizeSectionLines(lines).filter((existing) => existing.trim() !== "(none)");
	normalized.push(line);
	lines.length = 0;
	lines.push(...normalized);
}

function findNextDoneNumber(lines: string[]): number {
	let max = 0;
	for (const line of lines) {
		const match = /^\s*(\d+)\./.exec(line);
		if (!match) continue;
		max = Math.max(max, Number(match[1]));
	}
	return max + 1;
}

function removeCancelledWorkLines(sectionByName: Map<string, ParsedSummarySection>, facts: CompactionFacts): void {
	if (!facts.cancelledText) return;
	const factPathTokens = tokenSet(facts.files.map((file) => file.path).join("\n"));
	const cancelledTokens = new Set([...tokenSet(facts.cancelledText)].filter((token) => !factPathTokens.has(token)));
	if (cancelledTokens.size === 0) return;

	for (const section of sectionByName.values()) {
		if (section.normalized === SECTION_MANDATORY_RULES) continue;
		section.lines = section.lines.filter((line) => !lineShouldBeDroppedAsCancelledWork(line, cancelledTokens));
	}
}

function lineShouldBeDroppedAsCancelledWork(line: string, cancelledTokens: Set<string>): boolean {
	const lineTokens = tokenSet(line);
	if (lineTokens.size === 0) return false;
	let overlap = 0;
	for (const token of lineTokens) {
		if (cancelledTokens.has(token)) overlap++;
	}
	return overlap >= 2 && overlap / lineTokens.size >= 0.6;
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
		facts.workingSet.length === 0 &&
		facts.actions.length === 0 &&
		facts.errorFacts.length === 0 &&
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
