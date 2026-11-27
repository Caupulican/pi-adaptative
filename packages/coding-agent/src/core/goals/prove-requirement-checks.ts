/**
 * Prove a goal's checked requirements by rerunning their checks: the one implementation both the
 * goal tool's completion and the objective loop's completion candidate use.
 *
 * Every result is recorded on the goal as host-verified `check` evidence and persisted before
 * coverage is judged, so the observation survives a refusal or interruption. A passing check
 * satisfies its requirement once its observation covers every required outcome. A failed check
 * withdraws earlier coverage. Worker checks use this same admission and persistence path.
 */

import { createHash } from "node:crypto";
import { redactKnownSecrets, redactTokenShapes } from "../security/secret-text.ts";
import type { ClarificationDecisionEngine } from "../system-one/clarification.ts";
import {
	currentRequirementCheckEvidence,
	getTrustedRequirementEvidence,
	requirementKey,
	requirementProofKey,
} from "./goal-acceptance.ts";
import { reviewCorrectedGoalOutcome } from "./goal-correction-proof.ts";
import { type GoalStateRevision, getGoalStateRevision, matchesGoalStateRevision } from "./goal-lifecycle.ts";
import {
	applyGoalEvent,
	type GoalEvidenceRef,
	type GoalState,
	isGoalExecutionActive,
	type RequirementCheck,
} from "./goal-state.ts";
import { applyGoalAction, type GoalAction } from "./goal-tool-core.ts";
import type { RequirementCheckResult } from "./requirement-checks.ts";
import { goalEvidenceObservation, reviewGoalCoverage, reviewRenewedCheckCoverage } from "./requirement-coverage.ts";

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
	observeEvidence?: (item: GoalEvidenceRef) => string | undefined;
	runCheck: ((check: RequirementCheck, signal?: AbortSignal) => Promise<RequirementCheckResult>) | undefined;
	now: () => string;
	save: (state: GoalState, expected: GoalStateRevision) => void;
	requireVerifiedEvidenceForCompletion: boolean;
	coverageEngine?: () => ClarificationDecisionEngine | undefined;
	/** The host has verified an owner-specified or built-in contract for this exact definition. */
	isCheckCoverageEstablished?: (requirement: GoalRequirement) => boolean;
	signal?: AbortSignal;
}): Promise<RequirementCheckProof> {
	const checked = input.state.requirements.filter((requirement) => requirement.check);
	if (checked.length === 0 && !input.state.ownerCorrection) return { state: input.state, checked: 0, failures: [] };
	if (checked.length && !input.runCheck) {
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
		const result = await input.runCheck!(requirement.check as RequirementCheck, input.signal);
		input.signal?.throwIfAborted();
		const at = input.now();
		const summary = checkSummary(result);
		const evidenceId = checkEvidenceId({
			check: requirement.id,
			definition: requirementKey(requirement),
			revision: String(next.revision ?? 0),
			at,
			summary,
			passed: String(result.passed),
		});
		next = await recordCheckResult({
			state: next,
			save: input.save,
			requirement,
			evidenceId,
			summary,
			passed: result.passed,
			at,
			requireVerifiedEvidenceForCompletion: input.requireVerifiedEvidenceForCompletion,
			coverageEngine: input.coverageEngine,
			isCheckCoverageEstablished: input.isCheckCoverageEstablished,
			signal: input.signal,
		});
		if (!result.passed)
			failures.push({ requirementId: requirement.id, text: requirement.text, reason: result.reason });
		else if (
			input.requireVerifiedEvidenceForCompletion &&
			getTrustedRequirementEvidence(next, next.requirements.find((item) => item.id === requirement.id)!).length === 0
		)
			failures.push({
				requirementId: requirement.id,
				text: requirement.text,
				reason: "The check passed, but its observation has not established every required outcome.",
			});
	}
	if (failures.length === 0 && input.coverageEngine) {
		const port = {
			engine: input.coverageEngine,
			observe: input.observeEvidence ?? ((item: GoalEvidenceRef) => goalEvidenceObservation(item, undefined)),
		};
		const acceptReview = (reviewed: GoalState) => {
			input.signal?.throwIfAborted();
			if (reviewed !== next) input.save(reviewed, getGoalStateRevision(next));
			next = reviewed;
		};
		if (input.requireVerifiedEvidenceForCompletion)
			acceptReview(await reviewRenewedCheckCoverage(input.state, next, input.now(), port, input.signal));
		acceptReview(await reviewCorrectedGoalOutcome(next, input.now(), port, input.signal));
	}
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
 * Persist the current measurement and withdraw earlier coverage before reviewing its relevance.
 * A second revision records satisfaction only when coverage has been established.
 */
async function recordCheckResult(input: {
	state: GoalState;
	save: (state: GoalState, expected: GoalStateRevision) => void;
	requirement: GoalRequirement;
	evidenceId: string;
	sourceAttemptId?: string;
	readState?: () => GoalState | undefined;
	summary: string;
	passed: boolean;
	at: string;
	requireVerifiedEvidenceForCompletion: boolean;
	coverageEngine?: () => ClarificationDecisionEngine | undefined;
	isCheckCoverageEstablished?: (requirement: GoalRequirement) => boolean;
	signal?: AbortSignal;
}): Promise<GoalState> {
	if (!isGoalExecutionActive(input.state.status) && input.state.status !== "blocked")
		throw new Error(`Cannot record a host check while the goal is ${input.state.status}.`);
	let next = applyGoalEvent(input.state, {
		type: "add_evidence",
		id: input.evidenceId,
		kind: "check",
		summary: input.summary,
		uri: input.requirement.id,
		verified: true,
		outcome: input.passed ? "succeeded" : "failed",
		requirementKey: requirementKey(input.requirement),
		sourceAttemptId: input.sourceAttemptId,
		...(input.sourceAttemptId === undefined ? { directHostCheck: true as const } : {}),
		now: input.at,
	});
	const observedRequirement = next.requirements.find((item) => item.id === input.requirement.id)!;
	if (
		observedRequirement.status === "satisfied" &&
		getTrustedRequirementEvidence(next, observedRequirement).length === 0
	)
		next = applyGoalEvent(next, { type: "reopen_requirement", id: input.requirement.id, now: input.at });
	input.save(next, getGoalStateRevision(input.state));
	if (input.readState) {
		const refreshed = input.readState();
		if (!refreshed || !matchesGoalStateRevision(refreshed, getGoalStateRevision(next))) return next;
		next = refreshed;
	}
	const observed = next;
	if (input.passed) {
		const action: GoalAction = {
			action: "satisfy_requirement",
			requirementId: input.requirement.id,
			evidenceIds: [input.evidenceId],
		};
		const evidence = next.evidence.find((item) => item.id === input.evidenceId)!;
		const coverageProofs = input.isCheckCoverageEstablished?.(input.requirement)
			? new Set([requirementProofKey(input.requirement, [evidence])])
			: await reviewGoalCoverage(
					next,
					action,
					[input.requirement.id],
					input.at,
					{
						engine: () => input.coverageEngine?.(),
						observe: (item) => goalEvidenceObservation(item, undefined),
					},
					input.signal,
				);
		input.signal?.throwIfAborted();
		const applied = applyGoalAction(next, action, input.at, {
			requireVerifiedEvidenceForCompletion: input.requireVerifiedEvidenceForCompletion,
			coverageProofs,
		});
		if (applied.ok) next = applied.state;
	}
	if (next !== observed) input.save(next, getGoalStateRevision(observed));
	return next;
}

/** Where a host check's proof is written: the goal state, saved against the revision it was read at, and the warning sink. */
export interface GoalProofWriter {
	getGoalState(): GoalState | undefined;
	saveGoalState(state: GoalState, expected: GoalStateRevision): void;
	warn(message: string): void;
	/** Checks durable history before accepting a replay of an evicted attempt receipt. */
	hasRecordedEvidence?(state: GoalState, evidenceId: string): boolean;
	coverageEngine?(): ClarificationDecisionEngine | undefined;
	isCheckCoverageEstablished?(requirement: GoalRequirement): boolean;
}

/**
 * Record the host's own check of one requirement, run for one worker attempt, on the goal: the same verified `check` evidence
 * a completion proof writes, and the requirement satisfied by it. It writes exactly once per attempt and requirement, because
 * the entry's id names both. Returns whether the goal changed.
 */
export async function recordHostRequirementCheckProof(
	writer: GoalProofWriter,
	input: {
		attemptId: string;
		goalId: string;
		requirementId: string;
		definition: string;
		result: RequirementCheckResult;
		expectedLatestCheck?: { readonly evidenceId: string | undefined };
		isCurrentAttempt?: () => boolean;
		now?: () => string;
	},
): Promise<boolean> {
	const state = writer.getGoalState();
	const requirement = state?.requirements.find((entry) => entry.id === input.requirementId);
	if (
		state?.goalId !== input.goalId ||
		!requirement ||
		requirementKey(requirement) !== input.definition ||
		!requirement.check ||
		input.isCurrentAttempt?.() === false ||
		(input.expectedLatestCheck !== undefined &&
			currentRequirementCheckEvidence(state, requirement)?.id !== input.expectedLatestCheck.evidenceId)
	)
		return false;
	const evidenceId = checkEvidenceId({ check: requirement.id, attempt: input.attemptId });
	try {
		if (state.evidence.some((entry) => entry.id === evidenceId) || writer.hasRecordedEvidence?.(state, evidenceId))
			return false;
		const next = await recordCheckResult({
			state,
			save: (nextState, expected) => {
				if (input.isCurrentAttempt?.() === false)
					throw new Error("The checked worker generation is no longer current.");
				writer.saveGoalState(nextState, expected);
			},
			requirement,
			evidenceId,
			sourceAttemptId: input.attemptId,
			readState: () => writer.getGoalState(),
			summary: checkSummary(input.result),
			passed: input.result.passed,
			at: (input.now ?? (() => new Date().toISOString()))(),
			requireVerifiedEvidenceForCompletion: true,
			coverageEngine: () => writer.coverageEngine?.(),
			isCheckCoverageEstablished: (item) => writer.isCheckCoverageEstablished?.(item) === true,
		});
		return next !== state;
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
