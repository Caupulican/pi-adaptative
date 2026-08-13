import { ACTIVE_TASK_SOURCE_MAX_CHARS, type CompactionFacts, splitSentenceLines } from "./extraction.ts";
import {
	COMPACTION_WORKED_EXAMPLE_SENTINEL,
	SUMMARIZATION_PROMPT,
	SUMMARIZATION_SYSTEM_PROMPT,
	UPDATE_SUMMARIZATION_PROMPT,
} from "./utils.ts";

export interface VerificationFailure {
	check: string;
	detail: string;
	score?: number;
	threshold?: number;
	comparator?: "minimum" | "maximum";
	matched?: number;
	demanded?: number;
}

export interface VerificationReport {
	ok: boolean;
	failures: VerificationFailure[];
}

/** A failed verification attempt with its structured reports preserved for the retry ladder. */
export class CompactionVerificationError extends Error {
	readonly reports: VerificationReport[];

	constructor(reports: readonly VerificationReport[]) {
		super(`gate-failed: ${formatVerificationReports(reports)}`);
		this.name = "CompactionVerificationError";
		this.reports = reports.map((report) => ({
			ok: report.ok,
			failures: report.failures.map((failure) => ({ ...failure })),
		}));
	}
}

export interface DeterministicGapFillResult {
	summary: string;
	verification: VerificationReport;
	changed: boolean;
}

export const FILES_READ_RECALL_THRESHOLD = 0.8;
export const ACTIVE_TASK_CONTAINMENT_THRESHOLD = 1;
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
	const failures: VerificationFailure[] = [];
	if (!isCompactionSummaryStructurallyUsable(summary)) {
		failures.push({
			check: "summary-structure",
			detail: "Checkpoint must contain at least one recognized checkpoint section",
			score: 0,
			threshold: 1,
			comparator: "minimum",
		});
	}
	// Mandatory Rules is the one section the deterministic fill unconditionally scrubs of the
	// sentinel (reconcileMandatoryRules), so its presence there is self-healing, not a failure. Any
	// OTHER section is contamination the fill never touches and cannot safely repair — fail loudly
	// rather than silently persist harness instruction/example text as if it were real content.
	if (textContainsCompactionSentinel(removeSection(summary, SECTION_MANDATORY_RULES))) {
		failures.push({
			check: "compaction-control-sentinel",
			detail: `Checkpoint must never carry the harness's own worked-example sentinel "${COMPACTION_WORKED_EXAMPLE_SENTINEL}" outside ### Mandatory Rules — the model echoed instruction/example text into a persisted section`,
			score: 0,
			threshold: 1,
			comparator: "minimum",
		});
	}
	if (factsAreEmpty(facts)) {
		return { ok: failures.length === 0, failures };
	}

	const sections = extractSections(summary);
	const filesSection = sections[SECTION_FILES] ?? "";
	const workingSetSection = sections[SECTION_WORKING_SET] ?? "";
	const openProblemsSection = sections[SECTION_OPEN_PROBLEMS] ?? "";
	const doneSection = sections[SECTION_DONE] ?? "";
	const activeTaskSection = sections[SECTION_ACTIVE_TASK] ?? "";
	const mandatoryRulesSection = sections[SECTION_MANDATORY_RULES] ?? "";

	const modifiedFiles = facts.files.filter((file) => file.kind !== "read");
	const missingModifiedFiles = modifiedFiles
		.map((file) => file.path)
		.filter((path) => !sectionContainsExactPath(filesSection, path));
	if (missingModifiedFiles.length > 0) {
		const matched = modifiedFiles.length - missingModifiedFiles.length;
		failures.push({
			check: "files-modified-recall",
			detail: `Modified/created file recall ${formatScore(matched / modifiedFiles.length)} (${matched}/${modifiedFiles.length} exact paths); missing: ${formatMissingValues(missingModifiedFiles)}`,
			score: matched / modifiedFiles.length,
			threshold: 1,
			comparator: "minimum",
			matched,
			demanded: modifiedFiles.length,
		});
	}

	const workingSetPaths = facts.workingSet.map((file) => file.path);
	const missingWorkingSetPaths = workingSetPaths.filter((path) => !sectionContainsExactPath(workingSetSection, path));
	if (missingWorkingSetPaths.length > 0) {
		const matched = workingSetPaths.length - missingWorkingSetPaths.length;
		failures.push({
			check: "working-set-recall",
			detail: `Working-set recall ${formatScore(matched / workingSetPaths.length)} (${matched}/${workingSetPaths.length} exact paths); missing: ${formatMissingValues(missingWorkingSetPaths)}`,
			score: matched / workingSetPaths.length,
			threshold: 1,
			comparator: "minimum",
			matched,
			demanded: workingSetPaths.length,
		});
	}

	const readPaths = facts.files.filter((file) => file.kind === "read").map((file) => file.path);
	if (readPaths.length > 0) {
		// Paths are atomic identities. A global token bag over-credits shared directory prefixes and
		// makes the score impossible to interpret as "how many files survived".
		const missingReadPaths = readPaths.filter((path) => !sectionContainsExactPath(filesSection, path));
		const matched = readPaths.length - missingReadPaths.length;
		const score = matched / readPaths.length;
		if (score < FILES_READ_RECALL_THRESHOLD) {
			failures.push({
				check: "files-read-recall",
				detail: `Read file recall ${formatScore(score)} (${matched}/${readPaths.length} exact paths) below ${FILES_READ_RECALL_THRESHOLD}; missing: ${formatMissingValues(missingReadPaths)}`,
				score,
				threshold: FILES_READ_RECALL_THRESHOLD,
				comparator: "minimum",
				matched,
				demanded: readPaths.length,
			});
		}
	}

	if (facts.activeTaskSource) {
		const source = facts.activeTaskSource.slice(0, ACTIVE_TASK_SOURCE_MAX_CHARS);
		const score = activeTaskMatchesVerbatim(activeTaskSection, source) ? 1 : 0;
		if (score < ACTIVE_TASK_CONTAINMENT_THRESHOLD) {
			failures.push({
				check: "active-task-containment",
				detail: "Active task must copy the latest user request verbatim without added intent",
				score,
				threshold: ACTIVE_TASK_CONTAINMENT_THRESHOLD,
				comparator: "minimum",
			});
		}
	}

	for (const prohibition of facts.prohibitions) {
		const score = containment(tokenSet(prohibition), tokenSet(mandatoryRulesSection));
		if (score < MANDATORY_RULES_RECALL_THRESHOLD) {
			failures.push({
				check: "mandatory-rules-recall",
				detail: `Mandatory rule recall ${formatScore(score)} below ${MANDATORY_RULES_RECALL_THRESHOLD}: ${prohibition}`,
				score,
				threshold: MANDATORY_RULES_RECALL_THRESHOLD,
				comparator: "minimum",
			});
		}
	}

	if (facts.cancelledText) {
		const summaryOutsideMandatoryRules = removeSection(summary, SECTION_MANDATORY_RULES);
		// File paths from the facts are REQUIRED elsewhere (files-modified/read-recall demand them
		// in ## Files), so counting them as cancelled-work leakage would make the two gates
		// unsatisfiable together whenever a reversal message references a touched file.
		const cancelledTokens = cancelledWorkTokens(facts);
		const score = containment(cancelledTokens, tokenSet(summaryOutsideMandatoryRules));
		if (score > CANCELLED_WORK_DROPPED_THRESHOLD) {
			failures.push({
				check: "cancelled-work-dropped",
				detail: `Cancelled work leakage ${formatScore(score)} above ${CANCELLED_WORK_DROPPED_THRESHOLD}`,
				score,
				threshold: CANCELLED_WORK_DROPPED_THRESHOLD,
				comparator: "maximum",
			});
		}
	}

	for (const error of facts.errorFacts) {
		// Command strings can be much longer than their failure signal. Weight the operation and the
		// error identity equally so command flags cannot drown out a faithfully preserved failure (or
		// let a generic error phrase hide a missing operation).
		const openProblemTokens = tokenSet(openProblemsSection);
		const operationScore = containment(tokenSet(error.operation), openProblemTokens);
		const errorScore = containment(tokenSet(error.error), openProblemTokens);
		const score = (operationScore + errorScore) / 2;
		if (score < OPEN_ERRORS_RECALL_THRESHOLD) {
			failures.push({
				check: "open-errors-recall",
				detail: `Open error recall ${formatScore(score)} (operation ${formatScore(operationScore)}, error ${formatScore(errorScore)}) below ${OPEN_ERRORS_RECALL_THRESHOLD}: ${error.operation}`,
				score,
				threshold: OPEN_ERRORS_RECALL_THRESHOLD,
				comparator: "minimum",
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
				score,
				threshold: ACTIONS_RECALL_THRESHOLD,
				comparator: "minimum",
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

	const activeTask = sectionByName.get(SECTION_ACTIVE_TASK)!;
	activeTask.lines = facts.activeTaskSource ? buildActiveTaskLines(facts.activeTaskSource) : ["(none)"];

	const mandatoryRules = sectionByName.get(SECTION_MANDATORY_RULES)!;
	mandatoryRules.lines = reconcileMandatoryRules(mandatoryRules.lines, facts.prohibitions);

	const workingSet = sectionByName.get(SECTION_WORKING_SET)!;
	for (const file of facts.workingSet) {
		if (!sectionContainsExactPath(workingSet.lines.join("\n"), file.path)) {
			appendContentLine(workingSet.lines, `- ${file.path} — ${file.note || file.kind}`);
		}
	}

	const files = sectionByName.get(SECTION_FILES)!;
	for (const file of facts.files) {
		if (!sectionContainsExactPath(files.lines.join("\n"), file.path)) {
			appendContentLine(files.lines, `- ${file.path}`);
		}
	}

	const openProblems = sectionByName.get(SECTION_OPEN_PROBLEMS)!;
	for (const error of facts.errorFacts) {
		const required = `${error.operation}: ${error.error}`;
		if (containment(tokenSet(required), tokenSetFromLines(openProblems.lines)) < OPEN_ERRORS_RECALL_THRESHOLD) {
			appendContentLine(openProblems.lines, `- ${required}`);
		}
	}

	const done = sectionByName.get(SECTION_DONE)!;
	if (
		facts.actions.length > 0 &&
		containment(tokenSet(facts.actions.join("\n")), tokenSetFromLines(done.lines)) < ACTIONS_RECALL_THRESHOLD
	) {
		let nextNumber = findNextDoneNumber(done.lines);
		for (const action of facts.actions) {
			if (sectionLinesContain(done.lines, action)) {
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
	const previous = previousAttempt ? `\n\nPREVIOUS CHECKPOINT\n${previousAttempt}` : "";
	return `Checkpoint failed verification: ${failures}. Fix only listed omissions.${previous}`;
}

export function formatVerificationReports(reports: readonly VerificationReport[]): string {
	return reports
		.flatMap((report) => report.failures)
		.map((failure) => `${failure.check}: ${failure.detail}`)
		.join(", ");
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
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") start++;
	while (end > start && lines[end - 1].trim() === "") end--;
	if (start === end) return ["(none)"];
	return lines.slice(start, end).map((line) => line.trimEnd());
}

function sectionLinesContain(lines: readonly string[], value: string): boolean {
	return lines.some((line) => line.includes(value));
}

function sectionContainsExactPath(section: string, path: string): boolean {
	let fromIndex = 0;
	while (fromIndex <= section.length - path.length) {
		const index = section.indexOf(path, fromIndex);
		if (index < 0) return false;
		const before = index > 0 ? section[index - 1] : undefined;
		const afterIndex = index + path.length;
		const after = afterIndex < section.length ? section[afterIndex] : undefined;
		const boundary = (character: string | undefined): boolean =>
			character === undefined || /[\s`'"()[\]{}<>,:;|—]/.test(character);
		if (boundary(before) && boundary(after)) return true;
		fromIndex = index + 1;
	}
	return false;
}

function tokenSetFromLines(lines: readonly string[]): Set<string> {
	const tokens = new Set<string>();
	for (const line of lines) {
		for (const token of tokenSet(line)) tokens.add(token);
	}
	return tokens;
}

function appendContentLine(lines: string[], line: string): void {
	const normalized = normalizeSectionLines(lines).filter((existing) => existing.trim() !== "(none)");
	normalized.push(line);
	lines.length = 0;
	lines.push(...normalized);
}

/**
 * The exact instruction sentences the harness itself injects into the summarization prompts —
 * SUMMARIZATION_SYSTEM_PROMPT, SUMMARIZATION_PROMPT, and UPDATE_SUMMARIZATION_PROMPT. All three
 * sources single-sourced from utils.ts so this never drifts from what was actually sent; not a
 * heuristic guess at what "looks like" an instruction. Sentences below a minimum length are
 * dropped — a lone heading fragment like "## Files" would otherwise sit in the set as a
 * near-universal 1-2 token match.
 *
 * SUMMARIZATION_SYSTEM_PROMPT was previously excluded here: its worked example used to read
 * `Mandatory Rules contains "DO NOT touch legacy client"`, generic enough to false-positive-match a
 * real extractor-owned prohibition about a "legacy client". The example's subject is now the
 * synthetic COMPACTION_WORKED_EXAMPLE_SENTINEL token instead (see utils.ts), so that specific
 * collision is gone; the isCompactionControlEcho regression tests below (including the canonical "do
 * not touch the legacy client" fixture used throughout this file) are the evidence that re-including
 * it is safe.
 */
const COMPACTION_CONTROL_ECHO_MIN_SENTENCE_TOKENS = 4;
/** A line must share at least this many tokens with a single control sentence, not spread thinly
 * across several, before it is treated as an echo — mirrors lineShouldBeDroppedAsCancelledWork's
 * "overlap >= N and overlap ratio >= threshold" dual guard below. */
const COMPACTION_CONTROL_ECHO_MIN_OVERLAP = 3;
/** Stricter than MANDATORY_RULES_RECALL_THRESHOLD on purpose: dropping model content is destructive,
 * so the bar for "this line basically IS the harness's own sentence" is set high. */
const COMPACTION_CONTROL_ECHO_THRESHOLD = 0.8;

const COMPACTION_CONTROL_SENTENCE_TOKEN_SETS: readonly Set<string>[] = [
	SUMMARIZATION_SYSTEM_PROMPT,
	SUMMARIZATION_PROMPT,
	UPDATE_SUMMARIZATION_PROMPT,
]
	.flatMap((prompt) => splitSentenceLines(prompt))
	.map((sentence) => tokenSet(sentence))
	.filter((tokens) => tokens.size >= COMPACTION_CONTROL_ECHO_MIN_SENTENCE_TOKENS);

/** True when `line` is substantially reconstructed from a single harness-injected instruction
 * sentence — i.e. the model echoed the prompt back instead of writing a checkpoint fact. Direction
 * matters: containment is measured with the LINE as the needle and one sentence as the haystack, so
 * a short prompt fragment can never "explain away" a longer, mostly-unrelated user rule that merely
 * shares a couple of words with it. This is the fuzzy backstop for paraphrased echoes; a line
 * carrying COMPACTION_WORKED_EXAMPLE_SENTINEL is a separate, unconditional (non-heuristic) drop —
 * see textContainsCompactionSentinel below. */
function isCompactionControlEcho(line: string): boolean {
	const lineTokens = tokenSet(line);
	if (lineTokens.size === 0) return false;
	for (const sentenceTokens of COMPACTION_CONTROL_SENTENCE_TOKEN_SETS) {
		let hits = 0;
		for (const token of lineTokens) {
			if (sentenceTokens.has(token)) hits++;
		}
		if (hits >= COMPACTION_CONTROL_ECHO_MIN_OVERLAP && hits / lineTokens.size >= COMPACTION_CONTROL_ECHO_THRESHOLD) {
			return true;
		}
	}
	return false;
}

/** True when `text` carries the harness's worked-example sentinel — deterministic, not
 * model-dependent: no containment threshold, no token overlap, just a literal substring check
 * against a token no real content could plausibly contain. */
function textContainsCompactionSentinel(text: string): boolean {
	return text.includes(COMPACTION_WORKED_EXAMPLE_SENTINEL);
}

/**
 * Force each extractor-owned prohibition to appear verbatim (anti-paraphrase), while preserving every
 * model-carried line the extractor does not own. A rule replaces the first existing line that already
 * paraphrases it (by the same recall threshold the gate uses); otherwise it is appended. The harness owns
 * only the facts it extracted — it must never delete model content it never extracted, and it must never
 * stamp "(none)" over a non-empty section (2026-08 incident: unconditional overwrite silently dropped
 * user rules that don't match PROHIBITION_PATTERN, e.g. positive instructions like "always run tests from
 * packages/coding-agent", permanently across every later checkpoint). Two things it MUST still drop:
 * a line that echoes the harness's own injected instructions (isCompactionControlEcho), and a line
 * carrying the worked-example sentinel by definition (textContainsCompactionSentinel) — the latter is
 * exact and unconditional, since that token can only ever have come from the harness's own prompt.
 */
function reconcileMandatoryRules(lines: readonly string[], prohibitions: readonly string[]): string[] {
	const result = lines.filter(
		(line) =>
			line.trim() !== "(none)" &&
			line.trim() !== "" &&
			!isCompactionControlEcho(line) &&
			!textContainsCompactionSentinel(line),
	);
	for (const rule of prohibitions) {
		const canonical = `- ${rule}`;
		const ruleTokens = tokenSet(rule);
		let bestIndex = -1;
		let bestScore = 0;
		for (let i = 0; i < result.length; i++) {
			const score = containment(ruleTokens, tokenSet(result[i]));
			if (score > bestScore) {
				bestScore = score;
				bestIndex = i;
			}
		}
		if (bestIndex >= 0 && bestScore >= MANDATORY_RULES_RECALL_THRESHOLD) {
			result[bestIndex] = canonical;
		} else {
			result.push(canonical);
		}
	}
	return result.length > 0 ? result : ["(none)"];
}

/** Markdown-style escape: a line starting with `##`/`###` gains one leading backslash so the harness's
 * own heading parser (`^(?:##|###)\s`) can never re-split the Active Task section on it. Lines that
 * already start with a backslash before the heading marker gain one more, so decode (below) always
 * strips exactly one and the transform is a bijection — no other line is touched. */
const ACTIVE_TASK_HEADING_LIKE = /^\\*(?:##|###)\s/;
const ACTIVE_TASK_ESCAPED_HEADING = /^\\(?:\\*(?:##|###)\s)/;

function escapeActiveTaskHeadingLine(line: string): string {
	return ACTIVE_TASK_HEADING_LIKE.test(line) ? `\\${line}` : line;
}

function unescapeActiveTaskHeadingLine(line: string): string {
	return ACTIVE_TASK_ESCAPED_HEADING.test(line) ? line.slice(1) : line;
}

/**
 * Render the Active Task body so it survives being re-parsed by extractSections/parseSummarySections:
 * a user request that itself contains a `##`/`###` line (e.g. a pasted "## Steps" list) must not be
 * mistaken for a checkpoint heading, or the section gets truncated and verbatim verification can never
 * pass (2026-08 incident: permanently broken compaction for any conversation whose request had a
 * markdown heading). Only offending lines are touched, so plain requests render exactly as before.
 */
function buildActiveTaskLines(source: string): string[] {
	return `User: ${source}`.replaceAll("\r\n", "\n").split("\n").map(escapeActiveTaskHeadingLine);
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
	const cancelledTokens = cancelledWorkTokens(facts);
	if (cancelledTokens.size === 0) return;

	for (const section of sectionByName.values()) {
		if (section.normalized === SECTION_MANDATORY_RULES) continue;
		section.lines = section.lines.filter((line) => !lineShouldBeDroppedAsCancelledWork(line, cancelledTokens));
	}
}

function cancelledWorkTokens(facts: CompactionFacts): Set<string> {
	const factPathTokens = tokenSet(facts.files.map((file) => file.path).join("\n"));
	return new Set([...tokenSet(facts.cancelledText)].filter((token) => !factPathTokens.has(token)));
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

/** Trailing whitespace per line and leading/trailing blank lines are lost in the render pipeline
 * (normalizeSectionLines trims both); normalize both sides identically so the comparison is a fixed
 * point regardless of that lossy step, while leading whitespace on interior lines is preserved. */
function normalizeActiveTaskText(text: string): string {
	return text
		.replaceAll("\r\n", "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function activeTaskMatchesVerbatim(section: string, source: string): boolean {
	const decodedSection = section.replaceAll("\r\n", "\n").split("\n").map(unescapeActiveTaskHeadingLine).join("\n");
	const normalizedSection = normalizeActiveTaskText(decodedSection);
	const normalizedSource = normalizeActiveTaskText(source);
	const normalizedWithPrefix = normalizeActiveTaskText(`User: ${source}`);
	return normalizedSection === normalizedSource || normalizedSection === normalizedWithPrefix;
}

function formatScore(score: number): string {
	return score.toFixed(2);
}

function formatMissingValues(values: readonly string[]): string {
	const visible = values.slice(0, 5).join(", ");
	return values.length > 5 ? `${visible} (+${values.length - 5} more)` : visible;
}
