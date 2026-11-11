/**
 * Proof sheet: the bounded, code-rendered account of what a delivered result proved and what it did not.
 *
 * Built from host receipts only (commands the host recorded, checks it ran or accepted, requirement coverage it computed,
 * changed files it observed, what the work recorded as decided or assumed) and shown to the owner before the model's prose
 * summary. Everything in "not checked" is computed: requirement ids no passing check covers, changed files no check names
 * or covers through a requirement, inconclusive items. Depth follows the stakes; nothing here holds or refuses work.
 */

import { isDeepStrictEqual } from "node:util";
import { stripAnsi } from "../../utils/ansi.ts";
import { GOAL_LIFECYCLE_TOOL_NAMES, LEGACY_GOAL_TOOL_NAME } from "../goals/goal-tool-names.ts";
import { redactKnownSecrets, redactTokenShapes } from "../security/secret-text.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { isCheckCommand, type ProofStakes, type ScriptStakes } from "./proof-stakes.ts";

export const PROOF_SHEET_CUSTOM_TYPE = "proof-sheet";
export const PROOF_SHEET_MAX_BYTES = 6 * 1024;
/** The text bound one delivery's sheets share when it carries several (a batched worker handoff): each gets its share. */
export const PROOF_SHEET_BATCH_MAX_BYTES = 24 * 1024;
/** The customType a worker result's handoff is written under; the foreground terminal handoff writes it. */
export const BACKGROUND_WORKER_COMPLETION_CUSTOM_TYPE = "background-worker-completion";
/** The customType a plan update is written under; `plan-update.ts` re-exports it. */
export const PLAN_UPDATE_CUSTOM_TYPE = "plan-update";
/** The host-written custom messages that may carry a proof sheet. Goal results carry theirs on the goal tools' results. */
const SHEET_CUSTOM_TYPES: ReadonlySet<string> = new Set([
	BACKGROUND_WORKER_COMPLETION_CUSTOM_TYPE,
	PLAN_UPDATE_CUSTOM_TYPE,
]);
/** The host tools whose results carry a proof sheet (the goal tools). An extension may not register a tool under these names. */
export const PROOF_SHEET_TOOL_NAMES: ReadonlySet<string> = new Set([
	LEGACY_GOAL_TOOL_NAME,
	...GOAL_LIFECYCLE_TOOL_NAMES,
]);
const MAX_LINE_CHARS = 240;
const MAX_TAIL_CHARS = 160;
const MAX_LISTED = 8;
/** The bound of one record line and of one file path in a record (a path keeps its tail, so its file name survives). */
const RECORD_LINE_MAX = 120;

export type ProofSubjectKind = "goal" | "worker" | "plan";

/** A command the host recorded for the result, with the tail of its output when the host kept it. */
export interface ProofCommand {
	readonly command: string;
	readonly outcome: "passed" | "failed" | "unknown";
	readonly exitCode?: number;
	readonly outputTail?: string;
	/** Receipt id, tool call id or evidence id the line comes from. */
	readonly ref?: string;
	/**
	 * Set for a `python` tool call. `python`: the text is the python source the call ran. `python-file`: the text is the path
	 * of a file it ran; the host reads that file's stakes when the call runs (`details.scriptStakes`), and the stakes reader
	 * takes its facts from `scriptStakes` alone, never from the path.
	 */
	readonly language?: "python" | "python-file";
	/** The stakes the host read from a `python-file` call's script when it ran; absent when the call recorded none. */
	readonly scriptStakes?: ScriptStakes;
}

/** A check that ran: what it covers by requirement id and which changed paths it names. */
export interface ProofCheck {
	readonly label: string;
	readonly passed: boolean;
	/** Requirements this check covers on the host's own evidence (a receipt the host holds, a coverage map the host computed). */
	readonly covers: readonly string[];
	/** Requirements the work claims this check covers. Shown as the work's claim; never counted as covered. */
	readonly claimedCovers?: readonly string[];
	readonly ref?: string;
}

export interface ProofSheetInput {
	readonly subject: { readonly kind: ProofSubjectKind; readonly id: string; readonly title: string };
	readonly stakes: ProofStakes;
	readonly commands: readonly ProofCommand[];
	readonly checks: readonly ProofCheck[];
	/** Every requirement the result was asked to meet. */
	readonly requirementIds: readonly string[];
	/** Requirement ids the host already counts as covered by a check it trusts (a host verdict, a join coverage map). */
	readonly hostCoveredRequirementIds?: readonly string[];
	/** Files the result changed; undefined when this host did not observe them (never read as "nothing changed"). */
	readonly changedFiles?: readonly string[];
	/** Files the work claims it changed, when this host did not observe them: shown as claimed, never as observed. */
	readonly claimedFiles?: readonly string[];
	/** Which requirement ids each changed file serves, as the work recorded it. */
	readonly fileServes?: Readonly<Record<string, readonly string[]>>;
	readonly inconclusive: readonly string[];
	/** What the work recorded as decided or assumed (a completion account's assumptions, a worker report's). */
	readonly assumptions: readonly string[];
	readonly doneWhen?: string;
	readonly outOfScope?: readonly string[];
	/** Finished results delivered and not yet read by the owner, from the review gauge. */
	readonly reviewWaiting?: number;
	/** Where the full record lives (an artifact path, a goal id). */
	readonly sourceRefs?: readonly string[];
	/**
	 * Set when this level records no checks of its own and the checks live on other results (a plan join: each step's
	 * own sheet), in plain words. File coverage is then not judged here, so no changed file is listed as unchecked.
	 */
	readonly fileChecksElsewhere?: string;
}

/** The proof sheet as a delivery carries it under `details.proofSheet`: what the quiz and the review gauge read back. */
export interface ProofSheetRecord {
	readonly v: 1;
	readonly subject: ProofSheetInput["subject"];
	readonly level: ProofSheet["stakes"]["level"];
	readonly stakesFacts: readonly string[];
	readonly changedFiles: readonly string[];
	readonly uncheckedFiles: readonly string[];
	/** The full counts behind the bounded lists above. */
	readonly changedFileCount: number;
	readonly uncheckedFileCount: number;
	readonly commandCount: number;
	readonly coveredRequirementIds: readonly string[];
	readonly uncoveredRequirementIds: readonly string[];
	readonly checks: readonly { readonly label: string; readonly passed: boolean; readonly covers: readonly string[] }[];
	/**
	 * Whether `checks` holds every check and every check's `covers` in full. A record that cut either (or predates this flag)
	 * cannot say which checks cover a requirement, so the quiz asks no covering-check question from it.
	 */
	readonly coversComplete: boolean;
	readonly failedCommands: number;
	readonly assumptions: readonly string[];
	/** Present when file coverage is not judged at this level (see {@link ProofSheetInput.fileChecksElsewhere}). */
	readonly fileChecksElsewhere?: string;
	readonly text: string;
}

/** The key a delivery's `details` carries its proof sheet under; the review gauge and the quiz read it from the branch. */
export const PROOF_SHEET_DETAILS_KEY = "proofSheet";
/** The key a delivery's `details` carries the plain lines of sheets it could not build under (see {@link proofSheetUnavailableLine}). */
export const PROOF_SHEET_FAILURES_DETAILS_KEY = "proofSheetFailures";

export interface ProofSheet extends ProofSheetInput {
	readonly coveredRequirementIds: readonly string[];
	readonly uncoveredRequirementIds: readonly string[];
	readonly uncheckedFiles: readonly string[];
	readonly quizOffered: boolean;
}

/** Separators between the words of a command line: whitespace, quotes and the shell's own punctuation. */
const COMMAND_TOKEN_SEPARATORS = /[\s'"`=;,&|()<>]+/u;

function normalizePath(value: string): string {
	return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

/**
 * Whether a command names a file as a whole path token: the token is the file's path, or a path-segment suffix of it
 * (or the file's path is one of a longer token). A bare file name never matches a longer path (`index.ts` is not
 * `src/index.ts`), and a substring never matches at all.
 */
function commandNamesFile(command: string, file: string): boolean {
	const target = normalizePath(file);
	return command.split(COMMAND_TOKEN_SEPARATORS).some((token) => {
		const candidate = normalizePath(token);
		if (candidate.length === 0) return false;
		if (candidate === target) return true;
		const [shorter, longer] = candidate.length < target.length ? [candidate, target] : [target, candidate];
		return shorter.includes("/") && longer.endsWith(`/${shorter}`);
	});
}

/** Computes the coverage lists from the input: nothing here is read from model prose. */
export function buildProofSheet(input: ProofSheetInput): ProofSheet {
	const covered = new Set(input.hostCoveredRequirementIds ?? []);
	for (const check of input.checks) if (check.passed) for (const id of check.covers) covered.add(id);
	const required = [...new Set(input.requirementIds)];
	// Only a check counts toward file coverage: a passing `cat`, `sed -i` or `git add` names a file without checking it.
	const passingLabels = [
		...input.checks.filter((check) => check.passed).map((check) => check.label),
		...input.commands.filter((command) => command.outcome === "passed").map((command) => command.command),
	].filter((label) => isCheckCommand(label));
	const uncheckedFiles = (input.fileChecksElsewhere !== undefined ? [] : (input.changedFiles ?? [])).filter((file) => {
		if (passingLabels.some((label) => commandNamesFile(label, file))) return false;
		const serves = input.fileServes?.[file] ?? [];
		return !serves.some((id) => covered.has(id));
	});
	return {
		...input,
		coveredRequirementIds: required.filter((id) => covered.has(id)),
		uncoveredRequirementIds: required.filter((id) => !covered.has(id)),
		uncheckedFiles,
		quizOffered: input.stakes.level === "high" && (input.changedFiles?.length ?? 0) > 0,
	};
}

/**
 * The text as the owner reads it: terminal sequences and control characters removed, redacted, one line, whitespace collapsed.
 * A control character that is whitespace (tab, newline, carriage return) becomes a space; every other one, ESC included, is dropped.
 */
function plainLine(text: string): string {
	const visible = stripAnsi(text).replace(/\p{Cc}/gu, (char) => (/\s/u.test(char) ? " " : ""));
	return redactTokenShapes(redactKnownSecrets(visible)).replace(/\s+/g, " ").trim();
}

function clip(text: string, max = MAX_LINE_CHARS): string {
	const line = plainLine(text);
	return line.length <= max ? line : `${line.slice(0, max - 3)}...`;
}

/** A file path cut to its tail, so the file name survives the bound (the start of a long path is what goes). */
function pathLabel(path: string, max = RECORD_LINE_MAX): string {
	const line = plainLine(path);
	return line.length <= max ? line : `...${line.slice(-(max - 3))}`;
}

function listed(items: readonly string[], max = MAX_LISTED): string {
	const shown = items.slice(0, max).join(", ");
	return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/** What a check covers on the host's evidence, or what the work claims it covers (which no count includes). */
function checkCoverWords(check: ProofCheck): string {
	if (check.covers.length > 0) return `covers ${listed(check.covers)}`;
	if (check.claimedCovers && check.claimedCovers.length > 0)
		return `claimed by the work to cover ${listed(check.claimedCovers)}, not counted as covered`;
	return "covers no named requirement";
}

const SUBJECT_WORDS: Readonly<Record<ProofSubjectKind, string>> = {
	goal: "Goal",
	worker: "Worker result",
	plan: "Plan result",
};

function commandLine(command: ProofCommand): string {
	const result =
		command.outcome === "unknown"
			? "result not recorded"
			: `${command.outcome}${command.exitCode !== undefined ? ` (exit ${command.exitCode})` : ""}`;
	const tail = command.outputTail ? `; tail: ${clip(command.outputTail, MAX_TAIL_CHARS)}` : "";
	return clip(`- ${command.command} -> ${result}${tail}`);
}

function bounded(lines: readonly string[], maxBytes: number): string {
	const kept: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (bytes + size > maxBytes) {
			kept.push("(proof sheet cut to its size bound)");
			break;
		}
		kept.push(line);
		bytes += size;
	}
	return kept.join("\n");
}

/** The not-checked part of a sheet in one line, or undefined when every requirement and file is covered. */
export function proofSheetGapLine(sheet: ProofSheet): string | undefined {
	const parts = [
		sheet.uncoveredRequirementIds.length > 0
			? `requirements with no passing check: ${listed(sheet.uncoveredRequirementIds)}`
			: undefined,
		sheet.uncheckedFiles.length > 0
			? `changed files no check touched: ${listed(sheet.uncheckedFiles.map((file) => pathLabel(file)))}`
			: undefined,
		sheet.inconclusive.length > 0 ? `${sheet.inconclusive.length} inconclusive item(s)` : undefined,
	].filter((part): part is string => part !== undefined);
	return parts.length > 0 ? clip(`Not checked: ${parts.join("; ")}.`, 600) : undefined;
}

/** The files the work claims it changed, when this host did not observe them; undefined when none are claimed. */
function claimedFilesLine(sheet: ProofSheet): string | undefined {
	if (!sheet.claimedFiles || sheet.claimedFiles.length === 0) return undefined;
	return clip(`Claimed by the work, not observed: ${listed(sheet.claimedFiles.map((file) => pathLabel(file)))}.`, 600);
}

/** The review-gauge line, or undefined when nothing waits. */
export function reviewWaitingLine(waiting: number | undefined): string | undefined {
	if (!waiting || waiting <= 0) return undefined;
	return waiting === 1
		? "1 finished result is waiting for your review."
		: `${waiting} finished results are waiting for your review.`;
}

/**
 * The owner-facing text. Low stakes: a headline and the not-checked line. Elevated: commands, checks and what was decided or assumed.
 * High: everything, plus the quiz offer in one plain sentence.
 */
export function renderProofSheet(
	sheet: ProofSheet,
	maxBytes = PROOF_SHEET_MAX_BYTES,
	options?: { readonly includeQuizOffer?: boolean },
): string {
	const passed = sheet.checks.filter((check) => check.passed).length;
	const failed = sheet.checks.length - passed;
	const headline = clip(
		`Proof sheet, ${SUBJECT_WORDS[sheet.subject.kind].toLowerCase()} "${sheet.subject.title}": ${sheet.stakes.level} stakes; ${sheet.commands.length} command(s), ${passed} check(s) passed${failed > 0 ? `, ${failed} failed` : ""}; ${sheet.coveredRequirementIds.length} of ${new Set(sheet.requirementIds).size} requirement(s) covered.`,
		400,
	);
	const gap =
		proofSheetGapLine(sheet) ??
		(sheet.changedFiles === undefined
			? "Not checked: every requirement has a passing check; changed files were not observed for this result."
			: sheet.fileChecksElsewhere !== undefined
				? "Not checked: every requirement is covered."
				: "Not checked: nothing found uncovered by the recorded checks.");
	const elsewhere = sheet.fileChecksElsewhere !== undefined ? clip(sheet.fileChecksElsewhere) : undefined;
	const claimed = claimedFilesLine(sheet);
	const waiting = reviewWaitingLine(sheet.reviewWaiting);
	if (sheet.stakes.level === "low")
		return bounded(
			[
				headline,
				gap,
				...(claimed ? [claimed] : []),
				...(elsewhere ? [elsewhere] : []),
				...(waiting ? [waiting] : []),
			],
			maxBytes,
		);
	const lines: string[] = [headline];
	if (sheet.stakes.facts.length > 0) lines.push(clip(`Stakes: ${sheet.stakes.facts.join("; ")}.`, 600));
	if (sheet.doneWhen) lines.push(clip(`Done when: ${sheet.doneWhen}`));
	if (sheet.outOfScope && sheet.outOfScope.length > 0) lines.push(clip(`Out of scope: ${listed(sheet.outOfScope)}`));
	if (sheet.commands.length > 0) {
		lines.push("Commands that ran:");
		const shown = sheet.stakes.level === "high" ? sheet.commands.slice(-12) : sheet.commands.slice(-5);
		lines.push(...shown.map(commandLine));
		if (shown.length < sheet.commands.length)
			lines.push(`- and ${sheet.commands.length - shown.length} earlier command(s)`);
	}
	if (sheet.checks.length > 0) {
		lines.push("Checks and what each covers:");
		for (const check of sheet.checks.slice(0, MAX_LISTED * 2)) {
			lines.push(clip(`- ${check.passed ? "passed" : "failed"}: ${check.label}; ${checkCoverWords(check)}`));
		}
	}
	lines.push(gap);
	if (claimed) lines.push(claimed);
	if (elsewhere) lines.push(elsewhere);
	for (const item of sheet.inconclusive.slice(0, MAX_LISTED)) lines.push(clip(`- inconclusive: ${item}`));
	if (sheet.assumptions.length > 0) {
		lines.push("Decided or assumed:");
		lines.push(...sheet.assumptions.slice(0, MAX_LISTED).map((assumption) => clip(`- ${assumption}`)));
	}
	if (sheet.sourceRefs && sheet.sourceRefs.length > 0) lines.push(clip(`Full record: ${listed(sheet.sourceRefs, 4)}`));
	if (waiting) lines.push(waiting);
	if ((options?.includeQuizOffer ?? true) && sheet.quizOffered) {
		lines.push("This change is high stakes: type /quiz for a short quiz on what it changed before you rely on it.");
	}
	return bounded(lines, maxBytes);
}

const RECORD_LIST_MAX = 8;
/**
 * The covers entries a record keeps in all, across its checks: each entry is one requirement id (at most 120 characters), so
 * the record stays far under the parent-input payload bound. A check past this budget is recorded without its later covers.
 */
const RECORD_COVERS_BUDGET = 64;

function recordLine(text: string): string {
	return clip(text, 120);
}

/**
 * The checks a record keeps, each with its covers in full while the covers budget lasts, and whether nothing was cut: every check
 * kept and every covers list whole. Only a complete record can say which checks cover a requirement.
 */
function recordChecks(checks: readonly ProofCheck[]): { checks: ProofSheetRecord["checks"]; complete: boolean } {
	let budget = RECORD_COVERS_BUDGET;
	let complete = checks.length <= RECORD_LIST_MAX;
	const kept = checks.slice(0, RECORD_LIST_MAX).map((check) => {
		const covers = check.covers.slice(0, budget);
		if (covers.length < check.covers.length) complete = false;
		budget -= covers.length;
		return { label: recordLine(check.label), passed: check.passed, covers: covers.map(recordLine) };
	});
	return { checks: kept, complete };
}

/** The bounded record a delivery stores beside its text, with the rendered text itself. */
export function proofSheetRecord(sheet: ProofSheet, text = renderProofSheet(sheet)): ProofSheetRecord {
	const recorded = recordChecks(sheet.checks);
	return {
		v: 1,
		subject: { kind: sheet.subject.kind, id: recordLine(sheet.subject.id), title: recordLine(sheet.subject.title) },
		level: sheet.stakes.level,
		stakesFacts: sheet.stakes.facts.slice(0, RECORD_LIST_MAX).map(recordLine),
		changedFiles: (sheet.changedFiles ?? []).slice(0, RECORD_LIST_MAX).map((file) => pathLabel(file)),
		uncheckedFiles: sheet.uncheckedFiles.slice(0, RECORD_LIST_MAX).map((file) => pathLabel(file)),
		changedFileCount: sheet.changedFiles?.length ?? 0,
		uncheckedFileCount: sheet.uncheckedFiles.length,
		commandCount: sheet.commands.length,
		coveredRequirementIds: sheet.coveredRequirementIds.slice(0, RECORD_LIST_MAX).map(recordLine),
		uncoveredRequirementIds: sheet.uncoveredRequirementIds.slice(0, RECORD_LIST_MAX).map(recordLine),
		checks: recorded.checks,
		coversComplete: recorded.complete,
		failedCommands: sheet.commands.filter((command) => command.outcome === "failed").length,
		assumptions: sheet.assumptions.slice(0, RECORD_LIST_MAX).map(recordLine),
		...(sheet.fileChecksElsewhere !== undefined
			? { fileChecksElsewhere: recordLine(sheet.fileChecksElsewhere) }
			: {}),
		text,
	};
}

function stringsOf(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function countOf(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** Where a delivery came from: a host custom message by its customType, or a host tool result by its tool name. */
export type ProofSheetCarrier =
	| { readonly kind: "custom-message"; readonly customType: string }
	| { readonly kind: "tool-result"; readonly toolName: string };

/** Only a host-written carrier may hold a sheet: an extension or a worker writing `details` under another name is ignored. */
function carrierHoldsSheets(carrier: ProofSheetCarrier): boolean {
	return carrier.kind === "custom-message"
		? SHEET_CUSTOM_TYPES.has(carrier.customType)
		: PROOF_SHEET_TOOL_NAMES.has(carrier.toolName);
}

/**
 * The details a delivery keeps its own keys in. A delivered parent input (a plan update) keeps the caller's details under the
 * ledger's wrapper (`{ parentInput, originalDetails }`, see `parentInputMessage`), on the live message and its entry alike, so
 * the wrapper is opened first. Any other details are their own.
 */
function ownDetailsOf(details: unknown): Record<string, unknown> | undefined {
	const delivered = isPlainRecord(details) && "parentInput" in details ? details.originalDetails : details;
	return isPlainRecord(delivered) ? delivered : undefined;
}

/**
 * The proof sheets a host delivery carries, in delivery order: one record (a goal, a plan result) or a list (one per
 * worker in a batched worker handoff). A malformed entry is dropped; an older record missing a field reads with that
 * field's default, so no stored sheet makes the quiz, the gauge or the renderer throw.
 */
export function readProofSheetRecords(details: unknown, carrier: ProofSheetCarrier): ProofSheetRecord[] {
	const own = carrierHoldsSheets(carrier) ? ownDetailsOf(details) : undefined;
	if (!own) return [];
	const value = own[PROOF_SHEET_DETAILS_KEY];
	const candidates: readonly unknown[] = Array.isArray(value) ? value : [value];
	return candidates.flatMap((candidate) => {
		const record = validProofSheetRecord(candidate);
		return record ? [record] : [];
	});
}

/** The last proof sheet a host delivery carries, or undefined when it carries none. */
export function readProofSheetRecord(details: unknown, carrier: ProofSheetCarrier): ProofSheetRecord | undefined {
	return readProofSheetRecords(details, carrier).at(-1);
}

/** The plain lines a host delivery carries for sheets it could not build (see {@link proofSheetUnavailableLine}). */
export function readProofSheetFailures(details: unknown, carrier: ProofSheetCarrier): string[] {
	const own = carrierHoldsSheets(carrier) ? ownDetailsOf(details) : undefined;
	if (!own) return [];
	return stringsOf(own[PROOF_SHEET_FAILURES_DETAILS_KEY]).map((line) => clip(line, MAX_LINE_CHARS));
}

/**
 * Refuses an extension's replacement of a host tool result's details when it would change that result's proof sheet (add,
 * alter or remove it): the sheet is host-written, so an extension keeps it as the host wrote it or its change is refused.
 * Nothing is replaced when it throws.
 */
export function assertToolResultProofUnchanged(
	original: { readonly toolName: string; readonly details?: unknown },
	replacement: { readonly toolName: string; readonly details?: unknown },
): void {
	const carried = [original.toolName, replacement.toolName].some((toolName) =>
		carrierHoldsSheets({ kind: "tool-result", toolName }),
	);
	if (!carried || isDeepStrictEqual(proofKeysOf(original.details), proofKeysOf(replacement.details))) return;
	throw new Error(`Tool "${original.toolName}" carries a host proof sheet; an extension cannot change it.`);
}

/** The two proof keys of a delivery's details, as the host wrote them (a sheet and its failure lines). */
function proofKeysOf(details: unknown): readonly unknown[] {
	const own = ownDetailsOf(details);
	return [own?.[PROOF_SHEET_DETAILS_KEY], own?.[PROOF_SHEET_FAILURES_DETAILS_KEY]];
}

/**
 * The plain-words line a delivery carries when its proof sheet could not be built: the result it was for (its title, when
 * known), and the reason, redacted and bounded.
 */
export function proofSheetUnavailableLine(error: unknown, subject?: string): string {
	const reason = error instanceof Error ? error.message : String(error);
	const about = subject ? ` for "${subject}"` : "";
	return clip(`Proof sheet unavailable${about} (${reason}); the result is delivered without it.`, MAX_LINE_CHARS);
}

/**
 * The closed parser of a stored record: it rebuilds the record from the fields it knows, so an unknown field is dropped
 * and the text is bounded. Lists and counts that an older record lacks are derived from what it does hold.
 */
function validProofSheetRecord(record: unknown): ProofSheetRecord | undefined {
	if (!isPlainRecord(record) || record.v !== 1 || typeof record.text !== "string") return undefined;
	const subject = record.subject;
	if (!isPlainRecord(subject) || typeof subject.id !== "string") return undefined;
	if (subject.kind !== "goal" && subject.kind !== "worker" && subject.kind !== "plan") return undefined;
	const level = record.level === undefined ? "low" : record.level;
	if (level !== "low" && level !== "elevated" && level !== "high") return undefined;
	const changedFiles = stringsOf(record.changedFiles);
	const uncheckedFiles = stringsOf(record.uncheckedFiles);
	const covered = stringsOf(record.coveredRequirementIds);
	const uncovered = stringsOf(record.uncoveredRequirementIds);
	const checks = Array.isArray(record.checks)
		? record.checks.flatMap((check: unknown) => {
				if (!isPlainRecord(check) || typeof check.label !== "string" || typeof check.passed !== "boolean")
					return [];
				return [{ label: check.label, passed: check.passed, covers: stringsOf(check.covers) }];
			})
		: [];
	return {
		v: 1,
		subject: {
			kind: subject.kind,
			id: subject.id,
			title: typeof subject.title === "string" ? subject.title : subject.id,
		},
		level,
		stakesFacts: stringsOf(record.stakesFacts),
		changedFiles,
		uncheckedFiles,
		changedFileCount: countOf(record.changedFileCount, changedFiles.length),
		uncheckedFileCount: countOf(record.uncheckedFileCount, uncheckedFiles.length),
		commandCount: countOf(record.commandCount, 0),
		coveredRequirementIds: covered,
		uncoveredRequirementIds: uncovered,
		checks,
		coversComplete: record.coversComplete === true,
		failedCommands: countOf(record.failedCommands, 0),
		assumptions: stringsOf(record.assumptions),
		...(typeof record.fileChecksElsewhere === "string" ? { fileChecksElsewhere: record.fileChecksElsewhere } : {}),
		text: record.text.slice(0, PROOF_SHEET_BATCH_MAX_BYTES),
	};
}
