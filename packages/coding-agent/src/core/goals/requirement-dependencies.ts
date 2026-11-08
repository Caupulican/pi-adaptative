import { harnessLog } from "../../kernel/harness-log.ts";
import {
	projectRequirementRollup,
	type RequirementRollup,
	type RollupClaim,
	rollupAttemptsFromSnapshot,
} from "../delegation/requirement-rollup.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import type { Requirement } from "./goal-state.ts";

type DependencyRequirement = Pick<Requirement, "id" | "status" | "dependencies">;

/**
 * Whether an accepted, reviewed worker result covers a requirement (`projectRequirementRollup`), read lazily: the
 * rollup is projected on first use only, so a dependency already marked satisfied costs nothing. A missing runtime
 * snapshot covers nothing.
 */
export function requirementCoverageProbe(input: {
	readonly requirements: readonly Pick<Requirement, "id">[];
	readonly snapshot: () => TaskRuntimeProjection | undefined;
	/** Persisted worker claims in persistence order. */
	readonly claims: () => readonly RollupClaim[];
}): (requirementId: string) => boolean {
	let rollup: RequirementRollup | undefined;
	return (requirementId) => {
		if (!rollup) {
			const snapshot = input.snapshot();
			if (!snapshot) return false;
			rollup = projectRequirementRollup(
				rollupAttemptsFromSnapshot(snapshot, input.claims()),
				input.requirements.map((requirement) => requirement.id),
			);
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
