/**
 * System One validates a plan when the model publishes or changes it (`task_steps` set, intake or
 * add), over the whole current plan and the owner's request. Three atomic questions: does the plan
 * cover the request, does its order work, does it check its result. A decisive "no" steers the model
 * in the same tool result, so it revises the plan before working from it; an unsettled answer or a
 * System One that cannot answer is a visible doubt and the work goes on (reversible work never waits
 * on System One).
 */

import type { OperationEffectEngine } from "./operation-classifier.ts";

/**
 * Each question names one defect. Two ask for the defect itself, which live System One separates far
 * better than the positive form (probed: a missing requested part 0.92 vs 0.18 for a sound plan; an
 * order that uses a later step's result 0.62 vs at most 0.2); the result check reads best positive
 * (0.97 vs 0.04), so its defect is the answer's complement.
 */
export const PLAN_REVIEW_PROGRAM = {
	schema_version: "2.0",
	program_id: "JEV-PLAN-REVIEW",
	description: "Whether a published plan delivers the owner's request in a workable order and checks its result.",
	decisions: [
		{
			id: "misses_request_part",
			instruction: "Does `request` ask for something that no item of `steps` does?",
			criteria: {
				true: "A part of the request (a feature, a change, a document) has no step that does it.",
				false: "Every part of the request is done by at least one step.",
			},
		},
		{
			id: "needs_later_step",
			instruction: "Does some item of `steps` need a result that only a later item of `steps` produces?",
			criteria: {
				true: "An earlier step cannot be done yet because it uses something a later step creates.",
				false: "Every step uses only what earlier steps produce or what already exists.",
			},
		},
		{
			id: "checks_result",
			instruction:
				"Does some item of `steps` check the result, for example by running tests, a build or the program?",
		},
	],
} as const;

/** Plan actions that publish or change the plan; status updates do not. */
const PLAN_CHANGING_ACTIONS: ReadonlySet<string> = new Set(["set", "intake", "add"]);

export function changesPlan(toolName: string, args: unknown): boolean {
	if (toolName !== "task_steps") return false;
	const action = (args as { action?: unknown } | undefined)?.action;
	return typeof action === "string" && PLAN_CHANGING_ACTIONS.has(action);
}

/** Each question's defect, and how the defect's probability reads off the answer. */
const DEFECTS: readonly {
	readonly id: string;
	readonly steer: string;
	readonly doubt: string;
	readonly positive: boolean;
}[] = [
	{
		id: "misses_request_part",
		steer: "the plan does not cover everything the request asks for; add the missing steps",
		doubt: "whether the plan covers the whole request",
		positive: false,
	},
	{
		id: "needs_later_step",
		steer: "a step needs what a later step produces; reorder the plan",
		doubt: "whether the plan's order works",
		positive: false,
	},
	{
		id: "checks_result",
		steer: "no step checks the result; add one that runs the tests, the build or the program",
		doubt: "whether the plan checks its result",
		positive: true,
	},
];

/** A defect this likely steers the model (the noul hard-fail band); above an even chance it is a doubt. */
const STEER_AT = 0.8;
const DOUBT_ABOVE = 0.5;

export interface PlanReview {
	/** Appended to the task_steps result: what the model must fix in the plan now. */
	readonly steer?: string;
	/** For the operator: what System One could not settle about the plan. */
	readonly doubt?: string;
}

function probability(answer: unknown): number | undefined {
	const noul = (answer as { noul?: unknown } | undefined)?.noul;
	return typeof noul === "number" && Number.isFinite(noul) && noul >= 0 && noul <= 1 ? noul : undefined;
}

export async function reviewPlan(
	engine: OperationEffectEngine | undefined,
	input: { readonly request: string; readonly steps: readonly string[]; readonly signal?: AbortSignal },
): Promise<PlanReview> {
	if (input.steps.length === 0) return {};
	// A session without System One has no judge to consult; its plans are the model's own.
	if (!engine) return {};
	let answers: Record<string, unknown>;
	try {
		answers =
			(
				await engine.evaluate(
					PLAN_REVIEW_PROGRAM,
					{ request: input.request || "(no request recorded)", steps: input.steps },
					{ consequence: "medium", signal: input.signal },
				)
			).answers ?? {};
	} catch (error) {
		input.signal?.throwIfAborted();
		return {
			doubt: `System One could not check the plan (${error instanceof Error ? error.message : String(error)})`,
		};
	}
	const steers: string[] = [];
	const doubts: string[] = [];
	for (const defect of DEFECTS) {
		const answered = probability(answers[defect.id]);
		if (answered === undefined) {
			doubts.push(defect.doubt);
			continue;
		}
		const defectProbability = defect.positive ? 1 - answered : answered;
		if (defectProbability >= STEER_AT) steers.push(defect.steer);
		else if (defectProbability > DOUBT_ABOVE) doubts.push(defect.doubt);
	}
	return {
		...(steers.length > 0 ? { steer: `System One checked the plan: ${steers.join("; ")}.` } : {}),
		...(doubts.length > 0 ? { doubt: `System One doubts ${doubts.join(", and ")}` } : {}),
	};
}
