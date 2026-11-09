import { ORCHESTRATION_THINKING_LEVELS, type OrchestrationThinkingLevel } from "../orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { DEFAULT_WORKER_OUTCOME_SETTINGS } from "../settings/worker-outcome-settings.ts";
import type { JudgmentPair, LadderCandidate, LadderFacts } from "./worker-escalation-policy.ts";
import type { BlockerCode, Outcome, OutcomeStatus, RequirementCoverage } from "./worker-outcome-contract.ts";

/**
 * What the ladder reads beyond the durable journal, supplied by the session that owns the worker controller. Every
 * member is optional: without it the ladder runs the hands-off defaults, finds no host requirement checks and treats a
 * model's thinking ceiling as unknown (the admission clamps the requested level).
 */
export interface OutcomeLadderContext {
	/** The owner's live escalation settings (`workerDelegation.outcomes.escalation`). */
	settings?(): { readonly enabled: boolean; readonly maxRungs: number };
	/** The highest thinking level the model supports; undefined when the model is unknown. */
	thinkingCeiling?(modelRef: string): OrchestrationThinkingLevel | undefined;
	/** Requirement ids that carry a host requirement check (an observational command the harness can rerun). */
	requirementCheckIds?(): ReadonlySet<string>;
}

/** The result of one host requirement check run after an attempt ended. */
export interface HostRequirementCheck {
	readonly id: string;
	readonly passed: boolean;
}

/** How a worker's model was chosen at admission decides whether the ladder may move it; legacy dispatches stay put. */
const MOVABLE_ROUTE_SOURCES: ReadonlySet<string> = new Set(["inherited"]);

function isThinkingLevel(value: string | undefined): value is OrchestrationThinkingLevel {
	return ORCHESTRATION_THINKING_LEVELS.some((level) => level === value);
}

function modelRefOf(binding: { provider: string; modelId: string }): string {
	return `${binding.provider}/${binding.modelId}`;
}

/** The rung an attempt ran as: the escalation record that placed it, else 0 (the first placement). */
export function attemptRung(snapshot: TaskRuntimeProjection, attempt: AttemptRuntimeState): number {
	return (
		snapshot.tasks[attempt.taskId]?.escalations?.find((entry) => entry.attemptId === attempt.attemptId)?.rung ?? 0
	);
}

/** Whether the task's spent cost and active time leave room for one more attempt like the last one. */
function budgetLeft(snapshot: TaskRuntimeProjection, attempt: AttemptRuntimeState): boolean {
	const budget = attempt.dispatch.executionContract?.worker.authority.budget;
	if (!budget || (!budget.maxCostUsd && !budget.maxWallClockMs)) return true;
	const attempts = (snapshot.tasks[attempt.taskId]?.attemptIds ?? [])
		.map((attemptId) => snapshot.attempts[attemptId]?.usageAccounting?.total)
		.filter((total) => total !== undefined);
	const spentUsd = attempts.reduce((sum, total) => sum + total.costUsd, 0);
	const spentMs = attempts.reduce((sum, total) => sum + total.activeWallClockMs, 0);
	const last = attempt.usageAccounting?.total;
	const costRoom = !budget.maxCostUsd || spentUsd + (last?.costUsd ?? 0) <= budget.maxCostUsd;
	const timeRoom = !budget.maxWallClockMs || spentMs + (last?.activeWallClockMs ?? 0) <= budget.maxWallClockMs;
	return costRoom && timeRoom;
}

/** The ladder's code facts for one terminal attempt's outcome, read from the durable projection. */
export function outcomeLadderFacts(args: {
	readonly snapshot: TaskRuntimeProjection;
	readonly attempt: AttemptRuntimeState;
	readonly lane: { readonly modelRef?: string; readonly thinkingLevel?: string };
	readonly status: OutcomeStatus;
	readonly blocker: BlockerCode;
	readonly coverage: RequirementCoverage;
	readonly previous: Outcome | undefined;
	readonly checkedIds: ReadonlySet<string>;
	readonly context: OutcomeLadderContext | undefined;
	readonly ownerOnly?: JudgmentPair;
}): LadderFacts {
	const { snapshot, attempt, context } = args;
	const task = snapshot.tasks[attempt.taskId];
	const contract = attempt.dispatch.executionContract?.worker;
	const modelRef = args.lane.modelRef ?? (contract ? modelRefOf(contract.modelBinding) : "unknown");
	const thinking = isThinkingLevel(args.lane.thinkingLevel) ? args.lane.thinkingLevel : undefined;
	const policy = contract?.profile.modelPolicy;
	const candidates: LadderCandidate[] =
		policy?.mode === "ordered-fallback"
			? policy.candidates.map((candidate) => ({
					modelRef: modelRefOf(candidate),
					...(candidate.thinkingLevel ? { thinking: candidate.thinkingLevel } : {}),
				}))
			: [];
	const escalations = task?.escalations ?? [];
	const checkable = context?.requirementCheckIds?.() ?? new Set<string>();
	const hostCheckable = args.coverage.uncovered
		.filter((entry) => checkable.has(entry.id) && !args.checkedIds.has(entry.id))
		.map((entry) => entry.id);
	const route = attempt.dispatch.modelRouteSource;
	return {
		scope: "lane",
		nodeId: attempt.taskId,
		status: args.status,
		blocker: args.blocker,
		coverage: args.coverage,
		writeCapable: (contract?.authority.writePaths.length ?? 0) > 0 && contract?.profile.readOnly !== true,
		modelRef,
		thinking,
		thinkingCeiling: context?.thinkingCeiling?.(modelRef),
		modelBound: route === undefined || !MOVABLE_ROUTE_SOURCES.has(route),
		candidates,
		triedModelRefs: [
			...(args.previous?.attempts ?? []).map((entry) => entry.modelRef),
			...escalations.map((entry) => entry.modelRef),
		],
		escalations,
		settings: context?.settings?.() ?? DEFAULT_WORKER_OUTCOME_SETTINGS.escalation,
		executor: context !== undefined,
		...(attempt.status === "suspended" && attempt.retry ? { retryNotBefore: attempt.retry.notBefore } : {}),
		hostCheckable,
		budgetLeft: budgetLeft(snapshot, attempt),
		...(args.ownerOnly ? { ownerOnly: args.ownerOnly } : {}),
	};
}
