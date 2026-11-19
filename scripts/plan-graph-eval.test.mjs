// Offline calibration checks against production review outputs, including provider abstention and failure.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	PLAN_GRAPH_EVAL_CASES,
	runPlanGraphEval,
} from "../packages/coding-agent/src/core/system-one/evals/plan-graph-eval.ts";

const cases = PLAN_GRAPH_EVAL_CASES.filter(({ id }) => id === "en-independent" || id === "en-self-brief");

for (const [name, evaluate] of Object.entries({
	ambiguous: async (program) => ({
		answers: Object.fromEntries(program.decisions.map(({ id }) => [id, { type: "noul", noul: 0.5 }])),
	}),
	unavailable: async () => {
		throw new Error("fixture unavailable");
	},
})) {
	test(`a graph left unchanged by an ${name} judgment receives no calibration credit`, async () => {
		const result = await runPlanGraphEval({ evaluate }, cases);
		assert.deepEqual(result.agreement, { coverage: 0, dependency: 0, brief: 0 });
		assert.equal(result.open, 4);
	});
}

test("each independent vote judgment receives the criteria alongside the candidate", async () => {
	const { PLAN_RUBRIC_EVAL_CASES, measurePlanRubric } = await import(
		"../packages/coding-agent/src/core/system-one/evals/plan-rubric-eval-cases.ts"
	);
	const fixture = PLAN_RUBRIC_EVAL_CASES[0];
	let observed;
	const engine = {
		async evaluate(program, state) {
			observed = { program, state };
			return {
				answers: {
					criterion_0: { probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } },
					candidate_evidence_sufficient: { type: "noul", noul: 0.95 },
				},
			};
		},
	};
	const summary = await measurePlanRubric(engine, [fixture]);
	assert.deepEqual(observed.state.criteria, [fixture.criterion]);
	assert.match(observed.program.decisions[0].instruction, /criteria\[0\]/);
	assert.equal(summary.sufficient, 1);
});

test("advisory scores prioritize an independent check while an uncertain vote stays open", async () => {
	const { judgeCandidates } = await import("../packages/coding-agent/src/core/system-one/plan-vote-rubric.ts");
	const { decideVote, voteStep } = await import("../packages/coding-agent/src/core/plan/plan-vote-decision.ts");
	const { PLAN_RUBRIC_EVAL_CASES } = await import(
		"../packages/coding-agent/src/core/system-one/evals/plan-rubric-eval-cases.ts"
	);
	const ids = ["first", "second", "third"];
	const cases = ids.map((memberId, i) => ({ ...PLAN_RUBRIC_EVAL_CASES[i].evidence, memberId }));
	const engine = {
		async evaluate(_program, state) {
			const uncertain = state.candidate.changes[0].what.includes("plan-vote:first");
			return {
				answers: {
					criterion_0: { confidence: uncertain ? 0.4 : 0.8, probabilities: { 0: 0.2, 2: 0.8 } },
					candidate_evidence_sufficient: { type: "noul", noul: 0.55 },
				},
			};
		},
	};
	const readings = (await judgeCandidates(engine, ["implements the feature"], cases)).map(({ reading }) => reading);
	assert.deepEqual(
		readings.map(({ verificationSupport }) => verificationSupport),
		[0, 1, 1],
	);
	const facts = {
		criteria: ["implements the feature"],
		candidates: ids.map((memberId) => ({ memberId, writes: false, changedFiles: [] })),
	};
	const vote = {
		id: "vote",
		kind: "vote",
		intent: "Select an implementation",
		requirementIds: [],
		inputs: [],
		after: [],
		join: { members: ids },
	};
	const record = { version: 1, nodes: [...ids.map((id) => ({ id, inputs: [] })), vote] };
	const exit = decideVote(facts, readings);
	assert.equal(exit.kind, "V2_evidence_open");
	assert.deepEqual(voteStep({ record, vote, facts, readings, exit }), {
		kind: "auto_verify",
		top: ["second", "third"],
		exit: "V2_evidence_open",
	});
});
