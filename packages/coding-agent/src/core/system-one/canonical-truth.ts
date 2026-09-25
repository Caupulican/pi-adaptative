/**
 * Session-owned projection of canonical goal + durable task + verification into ExecutionStore shape.
 * ExecutionStore is not a second authority: hydrate it from this before every System One stage.
 */

import type { VerificationObligationView } from "@caupulican/pi-agent-core/verification-obligations";
import type { GoalState } from "../goals/goal-state.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { goalObjectiveId } from "../orchestration/work-state-projection.ts";
import type { CanonicalHydration } from "./execution-state.ts";
import type {
	AcceptanceCriterion,
	AcceptanceCriterionStatus,
	Constraint,
	Observation,
	PlanActionClass,
	PlanStep,
	SourceKind,
	VerificationKind,
	VerificationRun,
} from "./types.ts";

export interface CanonicalTruthInput {
	goal?: GoalState;
	runtime?: TaskRuntimeProjection;
	verificationObligations?: readonly VerificationObligationView[];
	lastRoute?: { route: string; objective_id?: string };
	currentRevision: string;
}

const EMPTY_HYDRATION: Omit<CanonicalHydration, "current_revision"> = {
	request: "",
	normalized_goal: "",
	acceptance_criteria: [],
	constraints: [],
	non_goals: [],
	plan_steps: [],
	observations: [],
	verification: [],
};

export function emptyCanonicalHydration(currentRevision: string): CanonicalHydration {
	return { ...EMPTY_HYDRATION, current_revision: currentRevision };
}

function criterionStatus(status: string): AcceptanceCriterionStatus {
	if (status === "satisfied") return "satisfied";
	if (status === "blocked") return "failed";
	return "unverified";
}

function actionClassForRoute(route: string): PlanActionClass {
	switch (route) {
		case "retrieve":
			return "retrieve";
		case "investigate":
			return "inspect";
		case "implement":
			return "edit";
		case "deterministic_test":
			return "test";
		case "verify":
		case "review":
			return "verify";
		case "replan":
			return "replan";
		default:
			return "inspect";
	}
}

function sourceKindForEvidence(kind: string): SourceKind {
	if (kind === "test" || kind === "command") return "test";
	if (kind === "review") return "log";
	if (kind === "external") return "external_doc";
	return "user";
}

function verificationKindForCommand(command: string | undefined): VerificationKind {
	if (command && /test|vitest|jest|mocha|pytest/i.test(command)) return "unit_test";
	if (command && /build|tsc|compile/i.test(command)) return "compile";
	return "semantic_check";
}

/** Fold live goal, durable objective, and open verifications into one ExecutionStore hydration. */
export function projectCanonicalTruth(input: CanonicalTruthInput): CanonicalHydration {
	const revision = input.currentRevision || "unversioned";
	const goal = input.goal;
	const objectiveId = goal ? goalObjectiveId(goal.goalId) : input.lastRoute?.objective_id;
	const runtimeObjective = objectiveId ? input.runtime?.objectives[objectiveId] : undefined;

	if (!goal && !runtimeObjective) {
		return emptyCanonicalHydration(revision);
	}

	const request = goal?.userGoal ?? runtimeObjective?.objective.title ?? "";
	const normalized_goal = runtimeObjective?.objective.description ?? goal?.userGoal ?? "";

	let acceptance_criteria: AcceptanceCriterion[];
	if (goal && goal.requirements.length > 0) {
		acceptance_criteria = goal.requirements.map((requirement) => ({
			id: requirement.id,
			text: requirement.text,
			required: true,
			status: criterionStatus(requirement.status),
			evidence_ids: [...requirement.evidenceIds],
			waiver_id: null,
		}));
	} else {
		acceptance_criteria = (runtimeObjective?.objective.acceptanceCriteria ?? []).map((criterion) => ({
			id: criterion.id,
			text: criterion.description,
			required: criterion.required,
			status: "unverified" as const,
			evidence_ids: [],
			waiver_id: null,
		}));
	}

	const constraints: Constraint[] = (runtimeObjective?.objective.constraints ?? []).map((text, index) => ({
		id: `C-${index + 1}`,
		text,
		severity: "hard",
		source: "user",
		verified: false,
	}));

	const now = new Date().toISOString();
	const observations: Observation[] = [];
	if (goal) {
		for (const evidence of goal.evidence) {
			observations.push({
				id: `OBS-${evidence.id}`,
				text: evidence.summary,
				source: {
					kind: sourceKindForEvidence(evidence.kind),
					locator: evidence.uri ?? evidence.id,
					content_hash: evidence.id,
					revision,
					line_start: null,
					line_end: null,
					trust: evidence.verified ? "authoritative" : "repository_untrusted_text",
				},
				freshness: evidence.verified === false ? "stale" : "fresh",
				status: "observed",
			});
		}
	}
	for (const item of runtimeObjective?.evidence ?? []) {
		if (observations.some((observation) => observation.id === `OBS-${item.evidenceId}`)) continue;
		observations.push({
			id: `OBS-${item.evidenceId}`,
			text: item.summary,
			source: {
				kind: sourceKindForEvidence(item.kind),
				locator: item.artifactIds[0] ?? item.evidenceId,
				content_hash: item.evidenceId,
				revision,
				line_start: null,
				line_end: null,
				trust: item.trusted ? "authoritative" : "repository_untrusted_text",
			},
			freshness: "fresh",
			status: "observed",
		});
	}

	const verification: VerificationRun[] = (input.verificationObligations ?? []).map((obligation) => ({
		id: `VR-${obligation.id}`,
		kind: verificationKindForCommand(obligation.command),
		status: "failed",
		timestamp: now,
		command: obligation.command ?? null,
		artifact_ref: null,
		covers_acceptance_ids: [],
		observation_ids: [],
	}));
	// A requirement's check is the harness's own proof: its latest rerun, passed or failed, covers it.
	for (const requirement of goal?.requirements ?? []) {
		if (!requirement.check) continue;
		const latest = goal?.evidence.findLast(
			(evidence) => evidence.kind === "check" && evidence.uri === requirement.id,
		);
		verification.push({
			id: `VR-check-${requirement.id}`,
			kind: verificationKindForCommand(requirement.check.command),
			status: latest ? (latest.outcome === "succeeded" ? "passed" : "failed") : "failed",
			timestamp: latest?.createdAt ?? now,
			command: requirement.check.command,
			artifact_ref: null,
			covers_acceptance_ids: [requirement.id],
			observation_ids: latest ? [latest.id] : [],
		});
	}

	const plan_steps: PlanStep[] = [];
	if (input.lastRoute?.route) {
		plan_steps.push({
			id: input.lastRoute.route,
			goal: input.lastRoute.route,
			status: "active",
			action_class: actionClassForRoute(input.lastRoute.route),
			dependencies: [],
			proof_obligations: [],
		});
	} else {
		const open = goal?.requirements.find((requirement) => requirement.status === "open");
		if (open) {
			plan_steps.push({
				id: open.id,
				goal: open.text,
				status: "active",
				action_class: "edit",
				dependencies: [],
				proof_obligations: [],
			});
		}
	}

	return {
		request,
		normalized_goal,
		acceptance_criteria,
		constraints,
		non_goals: [],
		current_revision: revision,
		plan_steps,
		observations,
		verification,
	};
}
