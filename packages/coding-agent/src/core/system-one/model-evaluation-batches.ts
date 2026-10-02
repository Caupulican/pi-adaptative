import { type QuestionDefinition, type QuestionPack, toTypeSafeEvaluationQuestions } from "./catalog.ts";

/** Conservative serialized-byte admission with headroom; this is not a tokenizer estimate. */
export const MODEL_EVALUATION_REQUEST_BYTES = 24 * 1024;

export class ModelEvaluationBudgetError extends Error {
	readonly kind = "invalid_request";

	constructor() {
		super(`Model classification evidence exceeds the ${MODEL_EVALUATION_REQUEST_BYTES}-byte request budget`);
		this.name = "ModelEvaluationBudgetError";
	}
}

interface ModelEvaluationBatch {
	readonly state: { models: Record<string, string> };
	readonly questions: QuestionPack;
	readonly indexes: readonly number[];
}

/** Plan complete evidence before any request: independent targets split, comparison evidence never does. */
export function planModelEvaluations(
	models: readonly { description: string }[],
	model: string,
	comparison: boolean,
	questionId: (index: number) => string,
	question: (index: number) => QuestionDefinition,
): readonly ModelEvaluationBatch[] {
	const universe = comparison
		? Object.fromEntries(models.map((entry, index) => [`m${index}`, entry.description]))
		: undefined;
	const batches: ModelEvaluationBatch[] = [];
	let state = { models: universe ?? {} };
	let questions: QuestionPack = {};
	let indexes: number[] = [];
	for (const [index, entry] of models.entries()) {
		const id = questionId(index);
		const definition = question(index);
		let fits = false;
		// Try the current batch, then a fresh batch; evidence is never truncated to make it fit.
		for (let attempt = 0; attempt < 2; attempt++) {
			const nextState = universe ? state : { models: { ...state.models, [`m${index}`]: entry.description } };
			const nextQuestions = { ...questions, [id]: definition };
			const bytes = Buffer.byteLength(
				JSON.stringify({ model, state: nextState, questions: toTypeSafeEvaluationQuestions(nextQuestions) }),
			);
			if (bytes <= MODEL_EVALUATION_REQUEST_BYTES) {
				state = nextState;
				questions = nextQuestions;
				indexes.push(index);
				fits = true;
				break;
			}
			if (indexes.length === 0) throw new ModelEvaluationBudgetError();
			batches.push({ state, questions, indexes });
			state = { models: universe ?? {} };
			questions = {};
			indexes = [];
		}
		if (!fits) throw new ModelEvaluationBudgetError();
	}
	if (indexes.length > 0) batches.push({ state, questions, indexes });
	return batches;
}
