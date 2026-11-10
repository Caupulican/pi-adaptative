/**
 * `/quiz` — a short multiple-choice quiz on the newest finished result, built by code from its proof sheet and shown in
 * the question panel. The owner's answers are scored by code and each answer is explained from the record. It informs
 * only: taking it, skipping it or failing it changes nothing about the work.
 */
import type { HumanInputPresentationRequest, HumanInputPresentationResult } from "../../core/human-input.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import { buildChangeQuiz, scoreChangeQuiz } from "../../core/proof/change-quiz.ts";
import type { ProofSheetRecord } from "../../core/proof/proof-sheet.ts";

export interface QuizCommandHost {
	/** The newest proof sheet on the active branch. */
	latestProofSheet(): ProofSheetRecord | undefined;
	/** The question panel; undefined when this mode has no owner to ask. */
	askQuestions?(request: HumanInputPresentationRequest): Promise<HumanInputPresentationResult>;
	showError(message: string): void;
	showText(text: string): void;
}

/** What `/quiz` answers with when it is given an argument it does not take. */
export function quizUsage(): string {
	return interfaceText().autonomyCommands.quiz.usage;
}

export async function handleQuizCommand(host: QuizCommandHost, text: string): Promise<void> {
	if (text.replace(/^\/quiz\b/, "").trim().length > 0) {
		host.showError(quizUsage());
		return;
	}
	const quiz = buildChangeQuiz(host.latestProofSheet());
	if (!quiz.ok) {
		host.showText(quiz.reason);
		return;
	}
	if (!host.askQuestions) {
		host.showError(interfaceText().autonomyCommands.quiz.needsPanel);
		return;
	}
	const result = await host.askQuestions({
		requestId: `quiz-${Date.now()}`,
		acceptsImages: false,
		questions: quiz.questions.map((entry) => ({
			id: entry.id,
			header: entry.header,
			question: entry.question,
			options: entry.options.map((option) => ({ label: option.label, description: option.description })),
		})),
	});
	if (result.cancelled) {
		host.showText(interfaceText().autonomyCommands.quiz.closed);
		return;
	}
	const picked = quiz.questions.map((entry) => {
		const answer = result.answers.find((candidate) => candidate.id === entry.id);
		return answer && !answer.skipped ? (answer.selected[0] ?? answer.custom) : undefined;
	});
	host.showText(
		[interfaceText().autonomyCommands.quiz.subject(quiz.subject), scoreChangeQuiz(quiz.questions, picked)].join("\n"),
	);
}
