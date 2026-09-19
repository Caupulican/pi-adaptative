import { isDeepStrictEqual } from "node:util";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { isPlainRecord } from "../util/value-guards.ts";

export const TYPESAFE_PROVIDER = "typesafe";
export const TYPESAFE_MODEL = "jev-latest";
export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const TYPESAFE_MODELS_ENDPOINT = "https://api.typesafe.ai/v1/models";
export const OPENROUTER_PROVIDER = "openrouter";
export const OPENROUTER_DECISIONS_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const OPENROUTER_MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
export const OPENROUTER_TYPESAFE_MODEL = "typesafe/jev-latest";
export const REVIEW_CONFIDENCE = { high: 0.95, max: 0.99 } as const;

const contextSchema = Type.Union([
	Type.String(),
	Type.Record(Type.String(), Type.Unknown()),
	Type.Array(Type.Unknown()),
]);
const entrySchema = Type.Union([contextSchema, Type.Null()]);
const choiceCriteria = Type.Record(Type.String(), entrySchema, {
	minProperties: 2,
	maxProperties: 255,
});
const questionSchema = Type.Union([
	Type.Object(
		{ type: Type.Literal("choice"), instructions: entrySchema, criteria: choiceCriteria },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("noul"),
			instructions: entrySchema,
			criteria: Type.Optional(
				Type.Object(
					{ true: Type.Optional(entrySchema), false: Type.Optional(entrySchema) },
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("score"),
			instructions: entrySchema,
			// The live API rejects null Score levels despite the advanced guide's EntryType table.
			criteria: Type.Array(contextSchema, { minItems: 2, maxItems: 10 }),
		},
		{ additionalProperties: false },
	),
]);

export const evaluationInputSchema = Type.Object(
	{
		model: Type.Optional(Type.String({ minLength: 1 })),
		state: contextSchema,
		questions: Type.Record(Type.String(), questionSchema, { minProperties: 1 }),
	},
	{ additionalProperties: false },
);
export type EvaluationInput = Static<typeof evaluationInputSchema>;

export const reviewInputSchema = Type.Object(
	{
		state: contextSchema,
		questions: Type.Record(
			Type.String(),
			Type.Object(
				{ instructions: entrySchema, criteria: choiceCriteria, expected: Type.String() },
				{ additionalProperties: false },
			),
			{ minProperties: 1 },
		),
		confidence: Type.Optional(
			Type.Union([Type.Literal("high"), Type.Literal("max")], {
				description:
					"Every question must meet high 0.95 (default) or max 0.99 confidence, and select its expected option.",
			}),
		),
	},
	{ additionalProperties: false },
);
export type ReviewInput = Static<typeof reviewInputSchema>;

const probability = Type.Number({ minimum: 0, maximum: 1 });
const distribution = Type.Record(Type.String(), probability);
const answerSchema = Type.Union([
	Type.Object({
		type: Type.Literal("choice"),
		choice: Type.String(),
		confidence: probability,
		probabilities: distribution,
	}),
	Type.Object({ type: Type.Literal("noul"), noul: probability }),
	Type.Object({
		type: Type.Literal("score"),
		score: Type.Number({ minimum: 0 }),
		confidence: probability,
		probabilities: distribution,
		legend: Type.Record(Type.String(), contextSchema),
	}),
]);
const responseSchema = Type.Object({
	model: Type.String({ minLength: 1 }),
	answers: Type.Record(Type.String(), answerSchema),
	usage: Type.Object({
		input_tokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		output_tokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	}),
});
export type EvaluationResponse = Static<typeof responseSchema>;

/** Token accounting survives an invalid answer, but never trusts invalid counters. */
export function getEvaluationUsage(value: unknown): EvaluationResponse["usage"] | undefined {
	if (!isPlainRecord(value) || !Value.Check(responseSchema.properties.usage, value.usage)) return undefined;
	if (!Number.isSafeInteger(value.usage.input_tokens + value.usage.output_tokens)) return undefined;
	return value.usage;
}

/** Reject non-JSON evidence instead of silently deleting or rewriting it during transport. */
export function serializeEvaluation(value: unknown): string {
	const ancestors = new Set<object>();
	const visit = (item: unknown, depth: number): void => {
		if (depth > 64) throw new Error("TypeSafe JSON evidence exceeds 64 nested levels");
		if (item === null || typeof item === "string" || typeof item === "boolean") return;
		if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0)) return;
		if (typeof item !== "object" || (!Array.isArray(item) && !isPlainRecord(item)) || ancestors.has(item))
			throw new Error("TypeSafe evidence must be finite, acyclic JSON");
		ancestors.add(item);
		for (const key of Reflect.ownKeys(item)) {
			if (Array.isArray(item) && key === "length") continue;
			const descriptor = Object.getOwnPropertyDescriptor(item, key);
			if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor))
				throw new Error("TypeSafe evidence must be ordinary JSON data");
			visit(descriptor.value, depth + 1);
		}
		if (
			Array.isArray(item) &&
			(Object.keys(item).length !== item.length || Object.keys(item).some((key, index) => key !== String(index)))
		)
			throw new Error("TypeSafe JSON arrays must not have holes or extra properties");
		ancestors.delete(item);
	};
	visit(value, 0);
	return JSON.stringify(value);
}

export function validateEvaluationResponse(
	value: unknown,
	input: EvaluationInput,
): asserts value is EvaluationResponse {
	if (!Value.Check(responseSchema, value) || !getEvaluationUsage(value))
		throw new Error("Invalid TypeSafe response: schema mismatch");
	const ids = Object.keys(input.questions);
	if (Object.keys(value.answers).length !== ids.length)
		throw new Error("Invalid TypeSafe response: question coverage");
	for (const id of ids) {
		if (!Object.hasOwn(value.answers, id)) throw new Error("Invalid TypeSafe response: missing answer");
		const answer = value.answers[id];
		const question = input.questions[id];
		if (answer.type !== question.type) throw new Error("Invalid TypeSafe response: answer type");
		if (question.type === "noul" || answer.type === "noul") continue;
		const options =
			question.type === "choice"
				? Object.keys(question.criteria)
				: question.criteria.map((_, index) => String(index));
		if (
			Object.keys(answer.probabilities).length !== options.length ||
			options.some((option) => !Object.hasOwn(answer.probabilities, option))
		)
			throw new Error("Invalid TypeSafe response: option coverage");
		const probabilities = Object.values(answer.probabilities);
		const tolerance = options.length * 0.005 + 0.000001;
		if (Math.abs(probabilities.reduce((sum, p) => sum + p, 0) - 1) > Math.min(0.02, tolerance))
			throw new Error("Invalid TypeSafe response: probability sum");
		if (
			answer.type === "choice" &&
			(!options.includes(answer.choice) || probabilities.some((p) => p > answer.probabilities[answer.choice]))
		)
			throw new Error("Invalid TypeSafe response: inconsistent choice");
		if (answer.type === "score" && question.type === "score") {
			const weighted = options.reduce((sum, option) => sum + Number(option) * answer.probabilities[option], 0);
			const meanTolerance = 0.005 * options.reduce((sum, option) => sum + Number(option), 1) + 0.000001;
			if (
				answer.score > options.length - 1 ||
				Math.abs(answer.score - weighted) > meanTolerance ||
				!isDeepStrictEqual(
					answer.legend,
					Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion])),
				)
			)
				throw new Error("Invalid TypeSafe response: inconsistent score or legend");
		}
	}
}
