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
import { interfaceText } from "../language/interface-text.ts";
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
	return { label: file, description: interfaceText().autonomyCommands.quiz.aChangedFile };
}

function uncheckedFileQuestion(record: ProofSheetRecord, key: string): ChangeQuizQuestion | undefined {
	const words = interfaceText().autonomyCommands.quiz;
	const unchecked = record.uncheckedFiles[0];
	const checked = record.changedFiles.filter((file) => !record.uncheckedFiles.includes(file));
	if (!unchecked || checked.length === 0) return undefined;
	return question(key, {
		id: "unchecked-file",
		header: words.headerUncheckedFile,
		question: words.questionUncheckedFile,
		answer: fileOption(unchecked),
		wrong: checked.map(fileOption),
		why: words.whyUncheckedFile(unchecked),
	});
}

function requirementOption(id: string): ChangeQuizOption {
	return { label: id, description: interfaceText().autonomyCommands.quiz.aRequirement };
}

function uncoveredRequirementQuestion(record: ProofSheetRecord, key: string): ChangeQuizQuestion | undefined {
	const words = interfaceText().autonomyCommands.quiz;
	const uncovered = record.uncoveredRequirementIds[0];
	if (!uncovered || record.coveredRequirementIds.length === 0) return undefined;
	return question(key, {
		id: "uncovered-requirement",
		header: words.headerOpenRequirement,
		question: words.questionOpenRequirement,
		answer: requirementOption(uncovered),
		wrong: record.coveredRequirementIds.map(requirementOption),
		why: words.whyOpenRequirement(uncovered),
	});
}

function assumptionQuestion(record: ProofSheetRecord, key: string): ChangeQuizQuestion | undefined {
	const words = interfaceText().autonomyCommands.quiz;
	const assumption = record.assumptions[0];
	if (!assumption || record.checks.length === 0) return undefined;
	return question(key, {
		id: "assumption",
		header: words.headerAssumed,
		question: words.questionAssumed,
		answer: { label: assumption, description: words.anItem },
		wrong: record.checks.map((check) => ({ label: check.label, description: words.anItem })),
		why: words.whyAssumed,
	});
}

function coveringCheckQuestion(record: ProofSheetRecord, key: string): ChangeQuizQuestion | undefined {
	const words = interfaceText().autonomyCommands.quiz;
	// Which checks cover a requirement is asked only from a record that kept every check and every covers list in full.
	if (!record.coversComplete) return undefined;
	for (const check of record.checks) {
		if (!check.passed) continue;
		for (const requirement of check.covers) {
			const others = record.checks.filter((other) => !other.covers.includes(requirement));
			if (others.length === 0) continue;
			return question(key, {
				id: "covering-check",
				header: words.headerCoveringCheck,
				question: words.questionCoveringCheck(requirement),
				answer: { label: check.label, description: words.aCheck },
				wrong: others.map((other) => ({ label: other.label, description: words.aCheck })),
				why: words.whyCoveringCheck(check.label, requirement),
			});
		}
	}
	return undefined;
}

function failedCommandsQuestion(record: ProofSheetRecord, key: string): ChangeQuizQuestion | undefined {
	const words = interfaceText().autonomyCommands.quiz;
	if (record.commandCount === 0) return undefined;
	const count = record.failedCommands;
	const label = (value: number) => words.countOf(value, record.commandCount);
	const candidates = [count + 1, count + 2, count - 1, count - 2].filter(
		(value) => value >= 0 && value <= record.commandCount,
	);
	return question(key, {
		id: "failed-commands",
		header: words.headerFailedCommands,
		question: words.questionFailedCommands(record.commandCount),
		answer: { label: label(count), description: words.aCount },
		wrong: candidates.map((value) => ({ label: label(value), description: words.aCount })),
		why: words.whyFailedCommands(count, record.commandCount),
	});
}

/**
 * Plain statements with their truth read from the record; each comes with its negation, so one of a pair is always true.
 * A pair about requirements or files is asked only when the result has some, so no statement is vacuously true; the file
 * pair is not asked when file coverage is judged on other results (a plan result's steps).
 */
function statements(record: ProofSheetRecord): { readonly label: string; readonly holds: boolean }[] {
	const words = interfaceText().autonomyCommands.quiz;
	const requirements = record.coveredRequirementIds.length + record.uncoveredRequirementIds.length;
	return [
		...(requirements > 0
			? [
					{ label: words.statementAllRequirementsChecked, holds: record.uncoveredRequirementIds.length === 0 },
					{ label: words.statementRequirementUnchecked, holds: record.uncoveredRequirementIds.length > 0 },
				]
			: []),
		...(record.changedFileCount > 0 && record.fileChecksElsewhere === undefined
			? [
					{ label: words.statementAllFilesChecked, holds: record.uncheckedFileCount === 0 },
					{ label: words.statementFileUnchecked, holds: record.uncheckedFileCount > 0 },
				]
			: []),
		{ label: words.statementCommandFailed, holds: record.failedCommands > 0 },
		{ label: words.statementNoCommandFailed, holds: record.failedCommands === 0 },
		{ label: words.statementStakesHigh, holds: record.level === "high" },
		{ label: words.statementStakesLow, holds: record.level === "low" },
	];
}

function trueStatementQuestion(record: ProofSheetRecord, key: string): ChangeQuizQuestion | undefined {
	const words = interfaceText().autonomyCommands.quiz;
	const all = statements(record);
	const truth = all.find((statement) => statement.holds);
	if (!truth) return undefined;
	return question(key, {
		id: "true-statement",
		header: words.headerWhatHolds,
		question: words.questionWhatHolds,
		answer: { label: truth.label, description: words.aStatement },
		wrong: all
			.filter((statement) => !statement.holds)
			.map((statement) => ({ label: statement.label, description: words.aStatement })),
		why: words.whyWhatHolds,
	});
}

/** The quiz for one proof sheet record: 3-6 questions, or the plain reason none can be built. */
export function buildChangeQuiz(record: ProofSheetRecord | undefined): ChangeQuiz {
	if (!record) return { ok: false, reason: interfaceText().autonomyCommands.quiz.noRecord };
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
			reason: interfaceText().autonomyCommands.quiz.tooFewFacts(questions.length, CHANGE_QUIZ_MIN_QUESTIONS),
		};
	return { ok: true, subject: record.subject.title, questions };
}

/** The owner's score and each answer explained, from the labels the owner picked (undefined for a skipped question). */
export function scoreChangeQuiz(
	questions: readonly ChangeQuizQuestion[],
	picked: readonly (string | undefined)[],
): string {
	const words = interfaceText().autonomyCommands.quiz;
	const right = questions.filter((entry, index) => picked[index] === entry.answer).length;
	return [
		words.score(right, questions.length),
		...questions.map((entry, index) => {
			const choice = picked[index];
			const verdict =
				choice === undefined ? words.skipped : choice === entry.answer ? words.right : words.choseInstead(choice);
			return words.answerLine(index + 1, entry.question, verdict, entry.answer, entry.why);
		}),
	].join("\n");
}
