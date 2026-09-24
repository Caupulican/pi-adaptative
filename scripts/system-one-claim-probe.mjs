#!/usr/bin/env node
import { noulCertainty, settledAnswer } from "../packages/coding-agent/src/core/decision/noul.ts";
import { CLAIM_QUESTION_IDS } from "../packages/coding-agent/src/core/system-one/claim-delivery.ts";
import { liveSystemOneController } from "./system-one-live.mjs";

const controller = liveSystemOneController("system-one-claim-probe");

const CASES = [
	["All tests passed.", true],
	["The type check passed.", true],
	["The type check succeeded.", true],
	["The build completed successfully.", true],
	["Lint is clean.", true],
	["It compiles without errors.", true],
	["tsc reports no errors.", true],
	["The build log says: success", false],
	["The script printed: status report: all green", false],
	["The tests failed.", false],
	["I did not run the tests.", false],
	["The build should succeed.", false],
	["I expect the tests to pass.", false],
];

const questionId = CLAIM_QUESTION_IDS.tests_pass;
const results = await Promise.all(
	CASES.map(([answer, want]) =>
		controller.evaluateAnswerClaims(answer).then(
			(answers) => ({ answer, want, answers }),
			(error) => ({ answer, want, error }),
		),
	),
);
let wrong = 0;
let open = 0;
let failed = 0;
for (const { answer, want, answers, error } of results) {
	if (!answers) {
		failed += 1;
		console.log(`${"error".padEnd(6)} ${JSON.stringify(answer)}: ${error instanceof Error ? error.message : String(error)}`);
		continue;
	}
	const got = settledAnswer(answers[questionId]);
	const noul = answers[questionId]?.noul;
	const status = got === undefined ? "open" : got === want ? "ok" : "WRONG";
	if (status === "WRONG") wrong += 1;
	if (status === "open") open += 1;
	const certainty = typeof noul === "number" ? ` certainty=${noulCertainty(noul).toFixed(2)}` : "";
	console.log(`${status.padEnd(6)} ${JSON.stringify(answer)}: P(true)=${noul} expected ${want}${certainty}`);
}
console.log(`${wrong} wrong, ${open} open, ${failed} failed, ${CASES.length} cases`);
process.exit(wrong + open + failed > 0 ? 1 : 0);
