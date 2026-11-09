/**
 * Change quiz: three to six multiple-choice questions about the newest finished result, built from its proof sheet
 * record, with every answer known by code.
 *
 * Each question is drawn from a recorded fact (which changed file no check touched, which requirement has no passing
 * check, which item was assumed rather than checked, which check covers a requirement, how many commands failed, which
 * statement the record makes true) and its wrong options are other recorded values the fact rules out. Nothing is asked
 * of a model and nothing is scored by one. The quiz reads the record only: it cannot ask what a default or a branch in the
 * diff does, because the record does not hold the diff.
 */

import { createHash } from "node:crypto";
import type { ProofSheetRecord } from "./proof-sheet.ts";

export const CHANGE_QUIZ_MIN_QUESTIONS = 3;
export const CHANGE_QUIZ_MAX_QUESTIONS = 6;
const MAX_OPTIONS = 4;

export interface ChangeQuizOption {
	readonly label: string;
	readonly description: string;
}

export interface ChangeQuizQuestion {
	readonly id: string;
	readonly header: string;
	readonly question: string;
	readonly options: readonly ChangeQuizOption[];
	/** The label of the right option. */
	readonly answer: string;
	/** Why it is right, from the record. */
	readonly why: string;
}

export type ChangeQuiz =
	| { readonly ok: true; readonly subject: string; readonly questions: readonly ChangeQuizQuestion[] }
	| { readonly ok: false; readonly reason: string };

/** A stable order for the options, keyed by the question, so the right answer is not always first and a rerun matches. */
function ordered(options: readonly ChangeQuizOption[], key: string): ChangeQuizOption[] {
	const rank = (option: ChangeQuizOption) =>
		createHash("sha256").update(`${key}\0${option.label}`).digest("hex").slice(0, 12);
	return [...options].sort((left, right) => rank(left).localeCompare(rank(right)));
}

/**
 * Gives every option its own label. Two options that read the same (two paths cut to the same tail, two identical
 * commands) get index letters, so neither is dropped as a copy and each stays a choice the owner can tell apart.
 */
function distinctLabels(options: readonly ChangeQuizOption[]): ChangeQuizOption[] {
	const counts = new Map<string, number>();
	for (const option of options) counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
	const seen = new Map<string, number>();
	return options.map((option) => {
		if ((counts.get(option.label) ?? 0) < 2) return option;
		const index = seen.get(option.label) ?? 0;
		seen.set(option.label, index + 1);
		return { ...option, label: `${option.label} (${String.fromCharCode(65 + index)})` };
	});
}

function question(
	key: string,
	input: Omit<ChangeQuizQuestion, "options" | "answer"> & {
		readonly answer: ChangeQuizOption;
		readonly wrong: readonly ChangeQuizOption[];
	},
): ChangeQuizQuestion | undefined {
	const labelled = distinctLabels([input.answer, ...input.wrong]);
	const answer = labelled[0];
	const wrong = labelled.slice(1, MAX_OPTIONS);
	if (!answer || wrong.length === 0) return undefined;
	return {
		id: input.id,
		header: input.header,
		question: input.question,
		options: ordered([answer, ...wrong], `${key}\0${input.id}`),
		answer: answer.label,
		why: input.why,
	};
}

function fileOption(file: string): ChangeQuizOption {
	return { label: file, description: "A changed file." };
}

function uncheckedFileQuestion(record: ProofSheetRecord, key: string): ChangeQuizQuestion | undefined {
	const unchecked = record.uncheckedFiles[0];
	const checked = record.changedFiles.filter((file) => !record.uncheckedFiles.includes(file));
	if (!unchecked || checked.length === 0) return undefined;
	return question(key, {
		id: "unchecked-file",
		header: "Unchecked file",
		question: "Which changed file did no recorded check touch?",
		answer: fileOption(unchecked),
		wrong: checked.map(fileOption),
		why: `No passing check names ${unchecked} or covers a requirement it serves; the other files are named or covered.`,
	});
}

function requirementOption(id: string): ChangeQuizOption {
	return { label: id, description: "A requirement of the task." };
}

function uncoveredRequirementQuestion(record: ProofSheetRecord, key: string): ChangeQuizQuestion | undefined {
	const uncovered = record.uncoveredRequirementIds[0];
	if (!uncovered || record.coveredRequirementIds.length === 0) return undefined;
	return question(key, {
		id: "uncovered-requirement",
		header: "Open requirement",
		question: "Which requirement has no passing check behind it?",
		answer: requirementOption(uncovered),
		wrong: record.coveredRequirementIds.map(requirementOption),
		why: `${uncovered} has no passing check or host coverage; the others do.`,
	});
}

function assumptionQuestion(record: ProofSheetRecord, key: string): ChangeQuizQuestion | undefined {
	const assumption = record.assumptions[0];
	if (!assumption || record.checks.length === 0) return undefined;
	return question(key, {
		id: "assumption",
		header: "Assumed",
		question: "Which of these did the work record as decided or assumed, rather than as a check that ran?",
		answer: { label: assumption, description: "An item of the result." },
		wrong: record.checks.map((check) => ({ label: check.label, description: "An item of the result." })),
		why: "It is listed under decided or assumed; the others are checks that ran.",
	});
}

function coveringCheckQuestion(record: ProofSheetRecord, key: string): ChangeQuizQuestion | undefined {
	// Which checks cover a requirement is asked only from a record that kept every check and every covers list in full.
	if (!record.coversComplete) return undefined;
	for (const check of record.checks) {
		if (!check.passed) continue;
		for (const requirement of check.covers) {
			const others = record.checks.filter((other) => !other.covers.includes(requirement));
			if (others.length === 0) continue;
			return question(key, {
				id: "covering-check",
				header: "Covering check",
				question: `Which check covers requirement ${requirement}?`,
				answer: { label: check.label, description: "A check that ran." },
				wrong: others.map((other) => ({ label: other.label, description: "A check that ran." })),
				why: `The check "${check.label}" passed and covers ${requirement}; the others do not cover it.`,
			});
		}
	}
	return undefined;
}

function failedCommandsQuestion(record: ProofSheetRecord, key: string): ChangeQuizQuestion | undefined {
	if (record.commandCount === 0) return undefined;
	const count = record.failedCommands;
	const label = (value: number) => `${value} of ${record.commandCount}`;
	const candidates = [count + 1, count + 2, count - 1, count - 2].filter(
		(value) => value >= 0 && value <= record.commandCount,
	);
	return question(key, {
		id: "failed-commands",
		header: "Failed commands",
		question: `How many of the ${record.commandCount} recorded commands failed?`,
		answer: { label: label(count), description: "A count of failed commands." },
		wrong: candidates.map((value) => ({ label: label(value), description: "A count of failed commands." })),
		why: `The host recorded ${count} failed command(s) out of ${record.commandCount}.`,
	});
}

/**
 * Plain statements with their truth read from the record; each comes with its negation, so one of a pair is always true.
 * A pair about requirements or files is asked only when the result has some, so no statement is vacuously true; the file
 * pair is not asked when file coverage is judged on other results (a plan result's steps).
 */
function statements(record: ProofSheetRecord): { readonly label: string; readonly holds: boolean }[] {
	const requirements = record.coveredRequirementIds.length + record.uncoveredRequirementIds.length;
	return [
		...(requirements > 0
			? [
					{ label: "Every requirement has a passing check.", holds: record.uncoveredRequirementIds.length === 0 },
					{ label: "Some requirement has no passing check.", holds: record.uncoveredRequirementIds.length > 0 },
				]
			: []),
		...(record.changedFileCount > 0 && record.fileChecksElsewhere === undefined
			? [
					{ label: "Every changed file was touched by a check.", holds: record.uncheckedFileCount === 0 },
					{ label: "Some changed file was touched by no check.", holds: record.uncheckedFileCount > 0 },
				]
			: []),
		{ label: "At least one command failed.", holds: record.failedCommands > 0 },
		{ label: "No recorded command failed.", holds: record.failedCommands === 0 },
		{ label: "The stakes were rated high.", holds: record.level === "high" },
		{ label: "The stakes were rated low.", holds: record.level === "low" },
	];
}

function trueStatementQuestion(record: ProofSheetRecord, key: string): ChangeQuizQuestion | undefined {
	const all = statements(record);
	const truth = all.find((statement) => statement.holds);
	if (!truth) return undefined;
	return question(key, {
		id: "true-statement",
		header: "What holds",
		question: "Which statement is true of this result, by its proof sheet?",
		answer: { label: truth.label, description: "A statement about the result." },
		wrong: all
			.filter((statement) => !statement.holds)
			.map((statement) => ({ label: statement.label, description: "A statement about the result." })),
		why: "The proof sheet's counts make it true and rule out the others.",
	});
}

/** The quiz for one proof sheet record: 3-6 questions, or the plain reason none can be built. */
export function buildChangeQuiz(record: ProofSheetRecord | undefined): ChangeQuiz {
	if (!record) return { ok: false, reason: "No finished result with a proof sheet is on this branch yet." };
	const key = `${record.subject.kind}\0${record.subject.id}`;
	const questions = [
		uncheckedFileQuestion(record, key),
		uncoveredRequirementQuestion(record, key),
		coveringCheckQuestion(record, key),
		assumptionQuestion(record, key),
		failedCommandsQuestion(record, key),
		trueStatementQuestion(record, key),
	]
		.filter((entry): entry is ChangeQuizQuestion => entry !== undefined)
		.slice(0, CHANGE_QUIZ_MAX_QUESTIONS);
	if (questions.length < CHANGE_QUIZ_MIN_QUESTIONS)
		return {
			ok: false,
			reason: `The newest result's proof sheet records too few facts for a quiz (${questions.length} question(s), at least ${CHANGE_QUIZ_MIN_QUESTIONS} needed); read the sheet itself.`,
		};
	return { ok: true, subject: record.subject.title, questions };
}

/** The owner's score and each answer explained, from the labels the owner picked (undefined for a skipped question). */
export function scoreChangeQuiz(
	questions: readonly ChangeQuizQuestion[],
	picked: readonly (string | undefined)[],
): string {
	const right = questions.filter((entry, index) => picked[index] === entry.answer).length;
	return [
		`Quiz score: ${right} of ${questions.length}.`,
		...questions.map((entry, index) => {
			const choice = picked[index];
			const verdict =
				choice === undefined ? "skipped" : choice === entry.answer ? "right" : `not quite (you chose "${choice}")`;
			return `${index + 1}. ${entry.question} ${verdict}. Answer: ${entry.answer}. ${entry.why}`;
		}),
	].join("\n");
}
