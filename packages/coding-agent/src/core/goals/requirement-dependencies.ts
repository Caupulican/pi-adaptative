import { harnessLog } from "../../kernel/harness-log.ts";
import {
	projectRequirementRollup,
	type RequirementRollup,
	type RollupClaim,
	rollupAttemptsFromSnapshot,
} from "../delegation/requirement-rollup.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { goalObjectiveId } from "../orchestration/work-state-projection.ts";
import { requirementKey } from "./goal-acceptance.ts";
import type { GoalEvent, GoalState, Requirement } from "./goal-state.ts";
import { currentGoalRequirements } from "./requirement-proof.ts";

type DependencyRequirement = Pick<Requirement, "id" | "status" | "dependencies">;

type RequirementDefinitions = Pick<GoalState, "goalId" | "requirements" | "events">;

/** A keyless dispatch needs a retained creation event and a complete, unamended definition history. */
function legacyRequirementStarts(goal: RequirementDefinitions): ReadonlyMap<string, number> {
	const latest = new Map<string, Extract<GoalEvent, { type: "add_requirement" }> | undefined>();
	for (const event of goal.events) {
		if (event.type === "add_requirement" || event.type === "set_requirement_check")
			latest.set(event.id, event.type === "add_requirement" && !latest.has(event.id) ? event : undefined);
	}
	const starts = new Map<string, number>();
	for (const requirement of goal.requirements) {
		const event = latest.get(requirement.id);
		if (!event || requirement.definitionAt !== undefined || event.now !== requirement.createdAt) continue;
		if (
			requirementKey({ ...requirement, text: event.text, dependencies: event.dependencies, check: event.check }) ===
			requirementKey(requirement)
		)
			starts.set(requirement.id, Date.parse(event.now));
	}
	return starts;
}

/** A wait binding is applicable only to the exact retained requirement definition. */
export function matchesRequirementBinding(
	goal: GoalState | undefined,
	binding: { goalId: string; requirementId: string; definitionKey?: string },
): boolean {
	if (!goal || goal.goalId !== binding.goalId) return false;
	const requirement = currentGoalRequirements(goal).find((item) => item.id === binding.requirementId);
	if (requirement?.status !== "open") return false;
	return binding.definitionKey !== undefined
		? binding.definitionKey === requirementKey(requirement)
		: legacyRequirementStarts(goal).has(requirement.id);
}

export function projectGoalRequirementRollup(
	snapshot: TaskRuntimeProjection,
	claims: readonly RollupClaim[],
	goal: RequirementDefinitions,
): RequirementRollup {
	const { requirements } = goal;
	const byId = new Map(requirements.map((item) => [item.id, item]));
	const objectiveId = goalObjectiveId(goal.goalId);
	let legacyStarts: ReadonlyMap<string, number> | undefined;
	const attempts = rollupAttemptsFromSnapshot(snapshot, claims, objectiveId);
	return projectRequirementRollup(
		attempts,
		requirements.map(({ id }) => id),
		(attempt, id) => {
			const requirement = byId.get(id);
			if (!requirement || requirement.check) return false;
			const durableAttempt = snapshot.attempts[attempt.attemptId]!;
			const keys = durableAttempt.dispatch.goalRequirementKeys;
			if (keys !== undefined) return keys.includes(requirementKey(requirement));
			legacyStarts ??= legacyRequirementStarts(goal);
			const declaredAt = legacyStarts.get(id);
			const task = snapshot.tasks[durableAttempt.taskId]!.task;
			return declaredAt !== undefined && Date.parse(task.createdAt) >= declaredAt;
		},
	);
}

/**
 * Whether an accepted, reviewed worker result covers a requirement (`projectRequirementRollup`), read lazily: the
 * rollup is projected on first use only, so a dependency already marked satisfied costs nothing. A missing runtime
 * snapshot covers nothing.
 */
export function requirementCoverageProbe(input: {
	readonly goal: RequirementDefinitions;
	readonly snapshot: () => TaskRuntimeProjection | undefined;
	/** Persisted worker claims in persistence order. */
	readonly claims: () => readonly RollupClaim[];
}): (requirementId: string) => boolean {
	let rollup: RequirementRollup | undefined;
	return (requirementId) => {
		if (!rollup) {
			const snapshot = input.snapshot();
			if (!snapshot) return false;
			rollup = projectGoalRequirementRollup(snapshot, input.claims(), input.goal);
		}
		return rollup.byRequirement[requirementId]?.covered === true;
	};
}

/**
 * The one rule for "a requirement's dependencies are met": a dependency is met when the goal marks it satisfied or an
 * accepted, reviewed worker result covers it; satisfaction itself stays the completion transaction's decision. A
 * requirement listing itself as a dependency (stored by an earlier version) never waits on itself. Returns the ids of
 * the dependencies still unmet.
 */
export function unmetRequirementDependencies(
	requirements: readonly DependencyRequirement[],
	requirement: DependencyRequirement,
	isCovered: (requirementId: string) => boolean,
): string[] {
	return (requirement.dependencies ?? []).filter((dependencyId) => {
		if (dependencyId === requirement.id) {
			harnessLog.info("goals", "a stored self-dependency was ignored", { requirementId: requirement.id });
			return false;
		}
		const dependency = requirements.find((candidate) => candidate.id === dependencyId);
		return dependency === undefined || (dependency.status !== "satisfied" && !isCovered(dependencyId));
	});
}

/** Definitive admission refusal waits for its declared retry, independently of attempt churn. */
export function currentExecutorRefusal(requirement: Requirement, nowMs: number): Requirement["executorRefusal"] {
	const refusal = requirement.executorRefusal;
	return refusal &&
		refusal.definitionKey === requirementKey(requirement) &&
		(refusal.attempts >= 3 || Date.parse(refusal.retryAt) > nowMs)
		? refusal
		: undefined;
}

/** Propagates a wait only along dependencies whose current coverage is still missing. */
export function projectRequirementWaits(
	requirements: readonly Requirement[],
	seeds: ReadonlySet<string>,
	isCovered: (requirementId: string) => boolean = () => false,
): ReadonlySet<string> {
	const waiting = new Set(seeds);
	let priorSize: number;
	do {
		priorSize = waiting.size;
		for (const requirement of requirements) {
			if (
				requirement.status === "open" &&
				unmetRequirementDependencies(requirements, requirement, isCovered).some((id) => waiting.has(id))
			)
				waiting.add(requirement.id);
		}
	} while (waiting.size !== priorSize);
	return waiting;
}

/** One readiness projection for continuation and objective routing, using the same dependency rule as dispatch. */
export function projectRunnableRequirements(
	requirements: readonly Requirement[],
	liveWatchIds: ReadonlySet<string>,
	isCovered: (requirementId: string) => boolean,
	nowMs = Date.now(),
): { runnable: string[]; waitingOnWatch: ReadonlySet<string>; waitingOnExecutor: ReadonlySet<string> } {
	const open = requirements.filter((requirement) => requirement.status === "open");
	const unmet = new Map(
		open.map((requirement) => [requirement.id, unmetRequirementDependencies(requirements, requirement, isCovered)]),
	);
	const waitingOnWatch = projectRequirementWaits(requirements, liveWatchIds, isCovered);
	const waitingOnExecutor = projectRequirementWaits(
		requirements,
		new Set(
			requirements
				.filter((item) => item.status !== "satisfied" && currentExecutorRefusal(item, nowMs))
				.map((item) => item.id),
		),
		isCovered,
	);
	return {
		runnable: open
			.filter(
				(requirement) =>
					!waitingOnWatch.has(requirement.id) &&
					!waitingOnExecutor.has(requirement.id) &&
					unmet.get(requirement.id)?.length === 0,
			)
			.map(({ id }) => id),
		waitingOnWatch,
		waitingOnExecutor,
	};
}
