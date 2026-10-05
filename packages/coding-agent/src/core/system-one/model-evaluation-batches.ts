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

export interface EvaluationBatch<State> {
	readonly state: State;
	readonly questions: QuestionPack;
	readonly indexes: readonly number[];
}

/**
 * Plan complete evidence before any request. A batch takes the next item while its serialized request fits
 * the byte budget (and the optional question cap); evidence is never truncated to make it fit, so one item
 * that cannot fit alone is an error.
 */
export function planEvaluationBatches<State>(plan: {
	readonly count: number;
	readonly model: string;
	/** The state a batch starts from: the evidence every question of that batch shares. */
	readonly empty: () => State;
	/** The state with item `index`'s own evidence added. */
	readonly withItem: (state: State, index: number) => State;
	readonly questionId: (index: number) => string;
	readonly question: (index: number) => QuestionDefinition;
	readonly maxQuestions?: number;
}): readonly EvaluationBatch<State>[] {
	const batches: EvaluationBatch<State>[] = [];
	let state = plan.empty();
	let questions: QuestionPack = {};
	let indexes: number[] = [];
	for (let index = 0; index < plan.count; index++) {
		const id = plan.questionId(index);
		const definition = plan.question(index);
		let fits = false;
		// Try the current batch, then a fresh batch.
		for (let attempt = 0; attempt < 2; attempt++) {
			const nextState = plan.withItem(state, index);
			const nextQuestions = { ...questions, [id]: definition };
			const bytes = Buffer.byteLength(
				JSON.stringify({
					model: plan.model,
					state: nextState,
					questions: toTypeSafeEvaluationQuestions(nextQuestions),
				}),
			);
			if (
				bytes <= MODEL_EVALUATION_REQUEST_BYTES &&
				indexes.length < (plan.maxQuestions ?? Number.POSITIVE_INFINITY)
			) {
				state = nextState;
				questions = nextQuestions;
				indexes.push(index);
				fits = true;
				break;
			}
			if (indexes.length === 0) throw new ModelEvaluationBudgetError();
			batches.push({ state, questions, indexes });
			state = plan.empty();
			questions = {};
			indexes = [];
		}
		if (!fits) throw new ModelEvaluationBudgetError();
	}
	if (indexes.length > 0) batches.push({ state, questions, indexes });
	return batches;
}

/** Plan complete evidence before any request: independent targets split, comparison evidence never does. */
export function planModelEvaluations(
	models: readonly { description: string }[],
	model: string,
	comparison: boolean,
	questionId: (index: number) => string,
	question: (index: number) => QuestionDefinition,
): readonly EvaluationBatch<{ models: Record<string, string> }>[] {
	const universe = comparison
		? Object.fromEntries(models.map((entry, index) => [`m${index}`, entry.description]))
		: undefined;
	return planEvaluationBatches({
		count: models.length,
		model,
		empty: () => ({ models: universe ?? {} }),
		withItem: (state, index) =>
			universe ? state : { models: { ...state.models, [`m${index}`]: models[index]!.description } },
		questionId,
		question,
	});
}
