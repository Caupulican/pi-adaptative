#!/usr/bin/env node
import { choiceAct, choiceProbability } from "../packages/coding-agent/src/core/decision/thresholds.ts";
import { CLAIM_QUESTION_IDS } from "../packages/coding-agent/src/core/system-one/claim-delivery.ts";
import { liveSystemOneController } from "./system-one-live.mjs";

const controller = liveSystemOneController("system-one-claim-probe");

const CASES = [
	["All tests passed.", "tests_pass", true],
	["The type check passed.", "checks_pass", true],
	["The type check succeeded.", "checks_pass", true],
	["The build completed successfully.", "checks_pass", true],
	["Lint is clean.", "checks_pass", true],
	["It compiles without errors.", "checks_pass", true],
	["tsc reports no errors.", "checks_pass", true],
	["The build log says: success", "checks_pass", false],
	["The script printed: status report: all green", "checks_pass", false],
	["The tests failed.", "tests_pass", false],
	["I did not run the tests.", "tests_pass", false],
	["The build should succeed.", "checks_pass", false],
	["I expect the tests to pass.", "tests_pass", false],
];

function settledProvenance(answer) {
	if (!answer || typeof answer !== "object") return undefined;
	const choice = answer.choice;
	if (choice !== "current_success" && choice !== "historical_only" && choice !== "no_current_success") {
		return undefined;
	}
	return choiceAct(answer, choice, "consequential") === "act" ? choice : undefined;
}

const results = await Promise.all(
	CASES.map(([answer, kind, want]) =>
		controller.evaluateAnswerClaims(answer).then(
			(answers) => ({ answer, kind, want, answers }),
			(error) => ({ answer, kind, want, error }),
		),
	),
);
let wrong = 0;
let open = 0;
let failed = 0;
for (const { answer, kind, want, answers, error } of results) {
	if (!answers) {
		failed += 1;
		console.log(`${"error".padEnd(6)} ${JSON.stringify(answer)}: ${error instanceof Error ? error.message : String(error)}`);
		continue;
	}
	const questionId = CLAIM_QUESTION_IDS[kind];
	const otherKind = kind === "tests_pass" ? "checks_pass" : "tests_pass";
	const otherQuestionId = CLAIM_QUESTION_IDS[otherKind];
	const raw = answers[questionId];
	const provenance = settledProvenance(raw);
	const claimsCurrentSuccess = provenance === "current_success";
	const otherClaimsCurrentSuccess = settledProvenance(answers[otherQuestionId]) === "current_success";
	const pCurrent = choiceProbability(raw, "current_success");
	const crossBleed = otherClaimsCurrentSuccess;
	const status = crossBleed
		? "WRONG"
		: want
			? claimsCurrentSuccess
				? "ok"
				: choiceAct(raw, "current_success", "consequential") === "unsure"
					? "open"
					: "WRONG"
			: claimsCurrentSuccess
				? "WRONG"
				: "ok";
	if (status === "WRONG") wrong += 1;
	if (status === "open") open += 1;
	const pText = typeof pCurrent === "number" ? pCurrent.toFixed(2) : "undefined";
	const bleedText = crossBleed ? ` bleed(${otherKind}=current_success)` : "";
	console.log(
		`${status.padEnd(6)} [${kind}] ${JSON.stringify(answer)}: settled=${provenance ?? "unsettled"} choice=${raw?.choice} P(current_success)=${pText} expected ${want}${bleedText}`,
	);
}
console.log(`${wrong} wrong, ${open} open, ${failed} failed, ${CASES.length} cases`);
process.exit(wrong + open + failed > 0 ? 1 : 0);
