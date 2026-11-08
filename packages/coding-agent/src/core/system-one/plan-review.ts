/**
 * System One validates a plan when the model publishes or changes it (`task_steps` set, intake or
 * add), over the whole current plan and the owner's request. Three atomic questions: does the plan
 * cover the request, does its order work, does it check its result. A decisive "no" steers the model
 * in the same tool result, so it revises the plan before working from it; an unsettled answer or a
 * System One that cannot answer is a visible doubt and the work goes on (reversible work never waits
 * on System One).
 */

import { type NoulDirection, readNoul } from "../decision/noul.ts";
import { programOverOwnerWords } from "../security/owner-paste-boundary.ts";
import type { OperationEffectEngine, OperationEvaluation } from "./operation-classifier.ts";
import { noteDecisionTrace, type SemanticTraceReading } from "./semantic-evaluation-ledger.ts";

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

/** The question that reads the owner's `request` for what the plan must cover. */
const PLAN_REQUEST_QUESTIONS: ReadonlySet<string> = new Set(["misses_request_part"]);

/** Plan actions that publish or change the plan; status updates do not. */
const PLAN_CHANGING_ACTIONS: ReadonlySet<string> = new Set(["set", "intake", "add"]);

export function changesPlan(toolName: string, args: unknown): boolean {
	if (toolName !== "task_steps") return false;
	const action = (args as { action?: unknown } | undefined)?.action;
	return typeof action === "string" && PLAN_CHANGING_ACTIONS.has(action);
}

/**
 * Each question's defect and the end a sound plan needs: no to a defect asked as such, yes to the result check.
 * The cuts are the `plan_review` family's: a decisive fail steers, an ambiguous reading is a doubt.
 */
const DEFECTS: readonly {
	readonly id: string;
	readonly steer: string;
	readonly doubt: string;
	readonly direction: NoulDirection;
}[] = [
	{
		id: "misses_request_part",
		steer: "the plan does not cover everything the request asks for; add the missing steps",
		doubt: "whether the plan covers the whole request",
		direction: "required_false",
	},
	{
		id: "needs_later_step",
		steer: "a step needs what a later step produces; reorder the plan",
		doubt: "whether the plan's order works",
		direction: "required_false",
	},
	{
		id: "checks_result",
		steer: "no step checks the result; add one that runs the tests, the build or the program",
		doubt: "whether the plan checks its result",
		direction: "required_true",
	},
];

const PLAN_REVIEW_READINGS: ReadonlyMap<string, SemanticTraceReading> = new Map(
	DEFECTS.map((defect) => [defect.id, { family: "plan_review", direction: defect.direction }]),
);

export interface PlanReview {
	/** Appended to the task_steps result: what the model must fix in the plan now. */
	readonly steer?: string;
	/** For the operator: what System One could not settle about the plan. */
	readonly doubt?: string;
}

export async function reviewPlan(
	engine: OperationEffectEngine | undefined,
	input: { readonly request: string; readonly steps: readonly string[]; readonly signal?: AbortSignal },
): Promise<PlanReview> {
	if (input.steps.length === 0) return {};
	// A session without System One has no judge to consult; its plans are the model's own.
	if (!engine) return {};
	let evaluation: OperationEvaluation;
	try {
		evaluation = await engine.evaluate(
			// A pasted directive is not a part of the request a plan must cover; a plan over unpasted words is asked as probed.
			programOverOwnerWords(PLAN_REVIEW_PROGRAM, PLAN_REQUEST_QUESTIONS, input.request, ...input.steps),
			{ request: input.request || "(no request recorded)", steps: input.steps },
			{ consequence: "medium", signal: input.signal },
		);
	} catch (error) {
		input.signal?.throwIfAborted();
		return {
			doubt: `System One could not check the plan (${error instanceof Error ? error.message : String(error)})`,
		};
	}
	const answers = evaluation.answers ?? {};
	const steers: string[] = [];
	const doubts: string[] = [];
	const drove: string[] = [];
	for (const defect of DEFECTS) {
		// An unanswered question settled nothing: it is a doubt, never a default probability.
		const reading = readNoul(answers[defect.id], defect.direction, "plan_review");
		if (reading === "hard_fail") steers.push(defect.steer);
		else if (reading === "ambiguous" || reading === "unasked") doubts.push(defect.doubt);
		else continue;
		drove.push(defect.id);
	}
	noteDecisionTrace(engine, evaluation, {
		decision: `plan review: ${steers.length} steered, ${doubts.length} doubted`,
		drove,
		exit: steers.length > 0 ? "steer" : doubts.length > 0 ? "doubt" : "sound",
		read: (id) => PLAN_REVIEW_READINGS.get(id),
	});
	return {
		...(steers.length > 0 ? { steer: `System One checked the plan: ${steers.join("; ")}.` } : {}),
		...(doubts.length > 0 ? { doubt: `System One doubts ${doubts.join(", and ")}` } : {}),
	};
}
