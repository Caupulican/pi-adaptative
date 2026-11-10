/**
 * Prove a goal's checked requirements by rerunning their checks: the one implementation both the
 * goal tool's completion and the objective loop's completion candidate use.
 *
 * Every result is recorded on the goal as host-verified `check` evidence and persisted before
 * anything is judged, so the proof trail survives a refusal. A passing check satisfies its
 * requirement; a failing one reopens a requirement that was marked satisfied. A requirement without
 * a check is untouched: it is judged on evidence by System One. The escalation's host check (E12)
 * records its pass through the same path: a check the host ran and saw pass closes the requirement
 * it checked.
 */
import { createHash } from "node:crypto";
import { redactKnownSecrets, redactTokenShapes } from "../security/secret-text.ts";
import { type GoalStateRevision, getGoalStateRevision } from "./goal-lifecycle.ts";
import { applyGoalEvent, type GoalState, type RequirementCheck } from "./goal-state.ts";
import { applyGoalAction, type GoalAction } from "./goal-tool-core.ts";
import type { RequirementCheckResult } from "./requirement-checks.ts";

const MAX_CHECK_OUTPUT_IN_EVIDENCE = 600;

/** One requirement of the goal, as the goal state lists it. */
type GoalRequirement = GoalState["requirements"][number];

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
		const at = input.now();
		const summary = checkSummary(result);
		const evidenceId = checkEvidenceId({ check: requirement.id, at, summary });
		next = recordCheckResult({
			state: next,
			requirement,
			evidenceId,
			summary,
			passed: result.passed,
			at,
			requireVerifiedEvidenceForCompletion: input.requireVerifiedEvidenceForCompletion,
		});
		if (!result.passed)
			failures.push({ requirementId: requirement.id, text: requirement.text, reason: result.reason });
	}
	input.save(next, getGoalStateRevision(input.state));
	return { state: next, checked: checked.length, failures };
}

/** The evidence id a check's result is recorded under, from what identifies that run. */
function checkEvidenceId(material: Record<string, string>): string {
	return `ev-${createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16)}`;
}

/** The one-line record of what a check observed: its reason, then the redacted tail of its output. */
function checkSummary(result: RequirementCheckResult): string {
	// Redacted before the tail is cut: a secret the cut splits would no longer match the redaction pattern.
	const output = redactTokenShapes(redactKnownSecrets(result.output.trim()));
	return `${result.reason}${output ? ` Output: ${output.slice(-MAX_CHECK_OUTPUT_IN_EVIDENCE)}` : ""}`;
}

/**
 * Record one host check result on the goal as verified `check` evidence: a pass satisfies the requirement it checked, and a
 * failure reopens a requirement the agent had marked satisfied.
 */
function recordCheckResult(input: {
	state: GoalState;
	requirement: GoalRequirement;
	evidenceId: string;
	summary: string;
	passed: boolean;
	at: string;
	requireVerifiedEvidenceForCompletion: boolean;
}): GoalState {
	const steps: GoalAction[] = [
		{
			action: "add_evidence",
			evidenceId: input.evidenceId,
			kind: "check",
			summary: input.summary,
			uri: input.requirement.id,
			verified: true,
			outcome: input.passed ? "succeeded" : "failed",
		},
	];
	if (input.passed && input.requirement.status !== "satisfied")
		steps.push({
			action: "satisfy_requirement",
			requirementId: input.requirement.id,
			evidenceIds: [input.evidenceId],
		});
	let next = input.state;
	for (const step of steps) {
		const applied = applyGoalAction(next, step, input.at, {
			requireVerifiedEvidenceForCompletion: input.requireVerifiedEvidenceForCompletion,
		});
		if (!applied.ok)
			throw new Error(`Recording the check for requirement '${input.requirement.id}' failed: ${applied.error}`);
		next = applied.state;
	}
	// The host's own check disproves the requirement, whatever the agent marked. The model-facing reopen action only reopens
	// blocked requirements; this is the reducer's event, not that action.
	if (!input.passed && input.requirement.status !== "open")
		next = applyGoalEvent(next, { type: "reopen_requirement", id: input.requirement.id, now: input.at });
	return next;
}

/** Where a host check's proof is written: the goal state, saved against the revision it was read at, and the warning sink. */
export interface GoalProofWriter {
	getGoalState(): GoalState | undefined;
	saveGoalState(state: GoalState, expected: GoalStateRevision): void;
	warn(message: string): void;
}

/**
 * Record the host's own check of one requirement, run for one worker attempt, on the goal: the same verified `check` evidence
 * a completion proof writes, and the requirement satisfied by it. It writes exactly once per attempt and requirement, because
 * the entry's id names both. Returns whether the goal changed.
 */
export function recordHostRequirementCheckProof(
	writer: GoalProofWriter,
	input: { attemptId: string; requirementId: string; result: RequirementCheckResult; now?: () => string },
): boolean {
	const state = writer.getGoalState();
	const requirement = state?.requirements.find((entry) => entry.id === input.requirementId);
	if (!state || !requirement || requirement.status === "satisfied" || !input.result.passed) return false;
	const evidenceId = checkEvidenceId({ check: requirement.id, attempt: input.attemptId });
	if (state.evidence.some((entry) => entry.id === evidenceId)) return false;
	try {
		const next = recordCheckResult({
			state,
			requirement,
			evidenceId,
			summary: checkSummary(input.result),
			passed: true,
			at: (input.now ?? (() => new Date().toISOString()))(),
			requireVerifiedEvidenceForCompletion: true,
		});
		writer.saveGoalState(next, getGoalStateRevision(state));
		return true;
	} catch (error) {
		writer.warn(
			`The host check's proof for requirement '${input.requirementId}' was not recorded: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
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
