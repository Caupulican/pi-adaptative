/**
 * Prove a goal's checked requirements by rerunning their checks: the one implementation both the
 * goal tool's completion and the objective loop's completion candidate use.
 *
 * Every result is recorded on the goal as host-verified `check` evidence and persisted before
 * anything is judged, so the proof trail survives a refusal. A passing check satisfies its
 * requirement; a failing one reopens a requirement that was marked satisfied. A requirement without
 * a check is untouched: it is judged on evidence by System One.
 */
import { createHash } from "node:crypto";
import { type GoalStateRevision, getGoalStateRevision } from "./goal-lifecycle.ts";
import { applyGoalEvent, type GoalState, type RequirementCheck } from "./goal-state.ts";
import { applyGoalAction, type GoalAction } from "./goal-tool-core.ts";
import type { RequirementCheckResult } from "./requirement-checks.ts";

const MAX_CHECK_OUTPUT_IN_EVIDENCE = 600;

export interface RequirementCheckFailure {
	requirementId: string;
	text: string;
	reason: string;
}

export interface RequirementCheckProof {
	/** The goal with every check result recorded. */
	state: GoalState;
	/** How many requirements carry a check. */
	checked: number;
	failures: readonly RequirementCheckFailure[];
	/** Set when checks exist but this host cannot run them: nothing is proven. */
	unrunnable?: string;
}

export async function proveRequirementChecks(input: {
	state: GoalState;
	runCheck: ((check: RequirementCheck, signal?: AbortSignal) => Promise<RequirementCheckResult>) | undefined;
	now: () => string;
	save: (state: GoalState, expected: GoalStateRevision) => void;
	requireVerifiedEvidenceForCompletion: boolean;
	signal?: AbortSignal;
}): Promise<RequirementCheckProof> {
	const checked = input.state.requirements.filter((requirement) => requirement.check);
	if (checked.length === 0) return { state: input.state, checked: 0, failures: [] };
	if (!input.runCheck) {
		return {
			state: input.state,
			checked: checked.length,
			failures: [],
			unrunnable: `requirement check(s) for ${checked.map((requirement) => requirement.id).join(", ")} cannot run in this session, so they cannot be proven`,
		};
	}
	let next = input.state;
	const failures: RequirementCheckFailure[] = [];
	for (const requirement of checked) {
		input.signal?.throwIfAborted();
		const result = await input.runCheck(requirement.check as RequirementCheck, input.signal);
		const output = result.output.trim();
		const summary = `${result.reason}${output ? ` Output: ${output.slice(-MAX_CHECK_OUTPUT_IN_EVIDENCE)}` : ""}`;
		const at = input.now();
		const evidenceId = `ev-${createHash("sha256")
			.update(JSON.stringify({ check: requirement.id, at, summary }))
			.digest("hex")
			.slice(0, 16)}`;
		const steps: GoalAction[] = [
			{
				action: "add_evidence",
				evidenceId,
				kind: "check",
				summary,
				uri: requirement.id,
				verified: true,
				outcome: result.passed ? "succeeded" : "failed",
			},
		];
		if (result.passed && requirement.status !== "satisfied") {
			steps.push({ action: "satisfy_requirement", requirementId: requirement.id, evidenceIds: [evidenceId] });
		}
		for (const step of steps) {
			const applied = applyGoalAction(next, step, at, {
				requireVerifiedEvidenceForCompletion: input.requireVerifiedEvidenceForCompletion,
			});
			if (!applied.ok) {
				throw new Error(`Recording the check for requirement '${requirement.id}' failed: ${applied.error}`);
			}
			next = applied.state;
		}
		// The host's own check disproves the requirement, whatever the agent marked. The model-facing
		// reopen action only reopens blocked requirements; this is the reducer's event, not that action.
		if (!result.passed && requirement.status !== "open") {
			next = applyGoalEvent(next, { type: "reopen_requirement", id: requirement.id, now: at });
		}
		if (!result.passed)
			failures.push({ requirementId: requirement.id, text: requirement.text, reason: result.reason });
	}
	input.save(next, getGoalStateRevision(input.state));
	return { state: next, checked: checked.length, failures };
}

/** The refusal sentence(s) for a proof that did not pass, or undefined when every check passed. */
export function describeRequirementCheckRefusal(proof: RequirementCheckProof): string | undefined {
	if (proof.unrunnable) return `Completion refused: ${proof.unrunnable}.`;
	if (proof.failures.length === 0) return undefined;
	return [
		`Completion refused: ${proof.failures.length} of ${proof.checked} requirement check(s) failed.`,
		...proof.failures.map((failure) => `- ${failure.requirementId} (${failure.text}): ${failure.reason}`),
		"Fix the outcome, then complete again; the harness reruns every check.",
	].join("\n");
}
