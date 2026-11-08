import { harnessLog } from "../../kernel/harness-log.ts";
import type { Requirement } from "../goals/goal-state.ts";
import { requirementCoverageProbe, unmetRequirementDependencies } from "../goals/requirement-dependencies.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import type { RollupClaim } from "./requirement-rollup.ts";

const GOAL_DEPENDENCY_UNSATISFIED = "goal_dependency_unsatisfied";

interface GoalDependencyGateInput {
	readonly requirements: readonly Pick<Requirement, "id" | "status" | "dependencies">[];
	/** The requirement ids the dispatch names. A dispatch that names none binds no requirement and is never gated. */
	readonly requirementIds: readonly string[];
	readonly snapshot: () => TaskRuntimeProjection;
	/** Persisted worker claims in persistence order; read only when a dependency is not yet satisfied. */
	readonly claims: () => readonly RollupClaim[];
}

/**
 * Whether a dispatch that names goal requirements must wait for their dependencies. Only explicitly named ids bind
 * (a brief that merely mentions an id binds nothing); the dependency rule is the goals layer's
 * `unmetRequirementDependencies`, shared with the goal tool's own `dispatch_worker`.
 */
export function unmetGoalDependencyReason(input: GoalDependencyGateInput): string | undefined {
	const named = new Set(input.requirementIds.map((id) => id.trim()).filter((id) => id.length > 0));
	if (named.size === 0) return undefined;
	const isCovered = requirementCoverageProbe(input);
	for (const requirementId of named) {
		const requirement = input.requirements.find((candidate) => candidate.id === requirementId);
		if (!requirement) continue;
		const unmet = unmetRequirementDependencies(input.requirements, requirement, isCovered);
		if (unmet.length > 0) {
			harnessLog.info("delegation", "a worker start was held by unmet goal dependencies", {
				requirementId,
				unmetDependencies: unmet.length,
			});
			return GOAL_DEPENDENCY_UNSATISFIED;
		}
	}
	return undefined;
}
