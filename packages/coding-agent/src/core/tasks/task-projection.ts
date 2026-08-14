import type { TaskStepStatus, TaskStepsState } from "./task-state.ts";

export interface OpenTaskStepProjection {
	id: string;
	status: TaskStepStatus;
	content: string;
	/** Always populated by projectOpenTaskSteps; optional for hand-built/legacy projections. */
	requirementIds?: readonly string[];
	/** Evidence strings attached to the step (tool_task ids, toolCallIds, paths). */
	evidence?: readonly string[];
}

export interface TaskRequirementReference {
	id: string;
	text: string;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Conservative fallback used only for task steps persisted before explicit requirement links existed. */
export function taskStepReferencesRequirement(
	step: Pick<OpenTaskStepProjection, "content" | "requirementIds">,
	requirement: TaskRequirementReference,
): boolean {
	if ((step.requirementIds?.length ?? 0) > 0) return step.requirementIds?.includes(requirement.id) ?? false;
	const idToken = requirement.id.trim();
	if (idToken.length >= 2) {
		const idPattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(idToken.toLocaleLowerCase())}([^a-z0-9]|$)`, "i");
		if (idPattern.test(step.content)) return true;
	}
	const text = requirement.text.trim();
	return text.length >= 8 && step.content.toLocaleLowerCase().includes(text.toLocaleLowerCase());
}

export function projectOpenTaskSteps(state: TaskStepsState | undefined): OpenTaskStepProjection[] {
	return (state?.steps ?? [])
		.filter((step) => step.status !== "completed" && step.status !== "cancelled")
		.map((step) => ({
			id: step.id,
			status: step.status,
			content: step.activeForm || step.content,
			requirementIds: [...(step.requirementIds ?? [])],
			evidence: [...(step.evidence ?? [])],
		}));
}

export function resolveTaskStepRequirementIds(
	step: Pick<OpenTaskStepProjection, "content" | "requirementIds">,
	requirements: readonly TaskRequirementReference[],
): { matchedIds: readonly string[]; unknownIds: readonly string[] } {
	const explicitIds = [...new Set(step.requirementIds ?? [])];
	if (explicitIds.length > 0) {
		const knownIds = new Set(requirements.map((requirement) => requirement.id));
		return {
			matchedIds: explicitIds.filter((id) => knownIds.has(id)),
			unknownIds: explicitIds.filter((id) => !knownIds.has(id)),
		};
	}
	const projected = {
		content: step.content,
		requirementIds: explicitIds,
	};
	return {
		matchedIds: requirements
			.filter((requirement) => taskStepReferencesRequirement(projected, requirement))
			.map((requirement) => requirement.id),
		unknownIds: [],
	};
}
