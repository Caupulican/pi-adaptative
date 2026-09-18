import type { JevAdapter } from "../adapter.ts";
import { getQuestionPack, SYSTEM_ONE_PINNED_MODEL } from "../catalog.ts";
import { DEFAULT_SYSTEM_ONE_CONFIG, type SystemOneConfig } from "../config.ts";
import { decideFinalCompletion, decidePreflight, decideToolGate } from "../policy.ts";
import type { ValidationStage } from "../types.ts";

export interface ReplayTestCase {
	id: string;
	stage: ValidationStage;
	description: string;
	state: Record<string, unknown>;
	expectedOutcome: "allow" | "reject" | "rework" | "complete" | "retrieve";
	isBugFix?: boolean;
	groundTruth: {
		isHallucinatedClaim?: boolean;
		isScopeDrift?: boolean;
		isPrematureCompletion?: boolean;
		isSymptomOnly?: boolean;
	};
}

export interface ReplayMetrics {
	totalCases: number;
	passedCases: number;
	falseAllowCount: number;
	falseRejectCount: number;
	missedHallucinationCount: number;
	prematureCompletionCount: number;
	unnecessaryEscalationCount: number;
	falseAllowRate: number;
	falseRejectRate: number;
	prematureCompletionRate: number;
}

/**
 * SystemOneReplayRunner: Replay calibration and regression harness.
 * R-068: Evaluates labeled replay corpus of successful runs, hallucinations, scope drift, premature completions.
 * R-069: Tracks false-allow, false-reject, unnecessary-escalation, missed-hallucination rates.
 * R-070: Supports shadow evaluation against prospective model upgrades.
 */
export class SystemOneReplayRunner {
	private readonly adapter: JevAdapter;
	private readonly config: SystemOneConfig;

	constructor(adapter: JevAdapter, config: SystemOneConfig = DEFAULT_SYSTEM_ONE_CONFIG) {
		this.adapter = adapter;
		this.config = config;
	}

	async runReplay(cases: ReplayTestCase[], targetModel = SYSTEM_ONE_PINNED_MODEL): Promise<ReplayMetrics> {
		let falseAllowCount = 0;
		let falseRejectCount = 0;
		let missedHallucinationCount = 0;
		let prematureCompletionCount = 0;
		let unnecessaryEscalationCount = 0;
		let passedCases = 0;

		for (const testCase of cases) {
			const questions = getQuestionPack(testCase.stage);
			const response = await this.adapter.evaluate({
				model: targetModel,
				state: testCase.state,
				questions,
			});

			let outcome = "allow";
			if (testCase.stage === "preflight") {
				outcome = decidePreflight(response.answers, this.config);
			} else if (testCase.stage === "tool_gate") {
				outcome = decideToolGate(response.answers, "repo_mutation", this.config);
			} else if (testCase.stage === "completion") {
				const verdict = decideFinalCompletion({
					deterministicGates: [],
					primaryAnswers: response.answers,
					challengeAnswers: {
						missing_requirement: { noul: 0.01 },
						hidden_assumption: { noul: 0.01 },
						plausible_regression_not_tested: { noul: 0.01 },
						conclusion_overstates_evidence: { noul: 0.01 },
					},
					isBugFix: testCase.isBugFix ?? false,
					config: this.config,
				});
				outcome = verdict.verdict;
			}

			const isAllowed = outcome === "allow" || outcome === "complete";
			const shouldAllow = testCase.expectedOutcome === "allow" || testCase.expectedOutcome === "complete";

			if (isAllowed && !shouldAllow) {
				falseAllowCount++;
				if (testCase.groundTruth.isHallucinatedClaim) {
					missedHallucinationCount++;
				}
				if (testCase.groundTruth.isPrematureCompletion) {
					prematureCompletionCount++;
				}
			} else if (!isAllowed && shouldAllow) {
				falseRejectCount++;
				if (outcome === "escalate") {
					unnecessaryEscalationCount++;
				}
			} else {
				passedCases++;
			}
		}

		const totalCases = cases.length;
		return {
			totalCases,
			passedCases,
			falseAllowCount,
			falseRejectCount,
			missedHallucinationCount,
			prematureCompletionCount,
			unnecessaryEscalationCount,
			falseAllowRate: totalCases > 0 ? falseAllowCount / totalCases : 0,
			falseRejectRate: totalCases > 0 ? falseRejectCount / totalCases : 0,
			prematureCompletionRate: totalCases > 0 ? prematureCompletionCount / totalCases : 0,
		};
	}
}
