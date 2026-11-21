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

test("inconclusive votes return to the root and only supported winners are selected", async () => {
	const { decideVote, voteStep, verifiedVote } = await import("../packages/coding-agent/src/core/plan/plan-vote-decision.ts");
	const candidates = ["first", "second"].map((memberId) => ({ memberId, writes: false, changedFiles: [] }));
	const facts = { criteria: ["fits the request"], candidates };
	const readings = candidates.map(({ memberId }) => ({ memberId, sufficient: "hard_pass", criteria: ["meets"] }));
	const decision = (answers, choice) => voteStep(decideVote(facts, answers), choice);
	assert.equal(decision(undefined).kind, "read_all");
	assert.equal(decision(readings).kind, "read_all");
	assert.equal(decision(readings, "third").kind, "read_all");
	assert.deepEqual(decision(readings, "second"), { kind: "winner", memberId: "second" });
	assert.deepEqual(decision([readings[0], { ...readings[1], criteria: ["fails"] }]), { kind: "winner", memberId: "first" });
	assert.match(decision([readings[0], { ...readings[1], sufficient: "ambiguous" }]).gaps[0], /second/);
	assert.match(decision([readings[0], { ...readings[1], criteria: ["open"] }]).gaps[0], /fits the request open/);
	const checks = candidates.map(({ memberId }) => ({ memberId, accepted: memberId === "second" }));
	assert.deepEqual(verifiedVote(checks), { kind: "winner", memberId: "second" });
	assert.equal(verifiedVote(checks.map((check) => ({ ...check, accepted: true }))).kind, "read_all");
});

test("a resumed vote recognizes the verification steps already ordered in its graph", async () => {
	const { voteChecksOf } = await import("../packages/coding-agent/src/core/plan/plan-revision.ts");
	const nodes = ["first", "second"].map((id) => ({
		id: `check-${id}`, kind: "verify", inputs: [id], join: { members: [id] },
	}));
	const vote = { after: ["check-first"], join: { members: ["first", "second"] } };
	assert.deepEqual(voteChecksOf({ nodes }, vote), [{ id: "check-first", memberId: "first" }]);
});
