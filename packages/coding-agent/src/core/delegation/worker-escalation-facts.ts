import { ORCHESTRATION_THINKING_LEVELS, type OrchestrationThinkingLevel } from "../orchestration/contracts.ts";
import { reviewRunVerdict } from "../orchestration/review-verdict.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { currentTaskOf } from "../orchestration/task-successor.ts";
import { DEFAULT_WORKER_OUTCOME_SETTINGS } from "../settings/worker-outcome-settings.ts";
import type { LadderCandidate, LadderFacts } from "./worker-escalation-policy.ts";
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

/**
 * Whether the task's attempt ceiling, spent cost and cumulative wall-clock ceiling leave room for one more attempt like the
 * last one. Task/objective ceilings bind a non-completed task only (a completed source's rung is a successor with its own
 * budget), while `authority.budget.maxWallClockMs` is the per-attempt wall-clock cap rather than a cumulative task sum.
 */
function budgetLeft(snapshot: TaskRuntimeProjection, attempt: AttemptRuntimeState): boolean {
	const task = snapshot.tasks[attempt.taskId];
	const objective = task ? snapshot.objectives[task.task.objectiveId] : undefined;
	const completed = task?.task.status === "completed";
	const ceilings = [task?.task.riskBudget.maxAttempts, objective?.objective.riskBudget.maxAttempts].filter(
		(value): value is number => value !== undefined,
	);
	if (task && !completed && ceilings.length > 0 && task.attemptIds.length >= Math.min(...ceilings)) return false;
	const timeCeilings = [task?.task.riskBudget.maxWallClockMs, objective?.objective.riskBudget.maxWallClockMs].filter(
		(value): value is number => value !== undefined && value > 0,
	);
	const budget = attempt.dispatch.executionContract?.worker.authority.budget;
	if (!budget?.maxCostUsd && (completed || timeCeilings.length === 0)) return true;
	const attempts = (task?.attemptIds ?? [])
		.map((attemptId) => snapshot.attempts[attemptId]?.usageAccounting?.total)
		.filter((total) => total !== undefined);
	const spentUsd = attempts.reduce((sum, total) => sum + total.costUsd, 0);
	const spentMs = attempts.reduce((sum, total) => sum + total.activeWallClockMs, 0);
	const last = attempt.usageAccounting?.total;
	const costRoom = !budget?.maxCostUsd || spentUsd + (last?.costUsd ?? 0) <= budget.maxCostUsd;
	const timeRoom =
		completed || timeCeilings.length === 0 || spentMs + (last?.activeWallClockMs ?? 0) <= Math.min(...timeCeilings);
	return costRoom && timeRoom;
}

/** The linked machine a plan step was released to, when `taskId` is that step's release task (a remote-placement fact). */
function remoteMachineOf(snapshot: TaskRuntimeProjection, taskId: string): string | undefined {
	for (const plan of Object.values(snapshot.plans))
		for (const node of Object.values(plan.nodes)) {
			const placement = node.release?.placement;
			if (node.release?.taskId === taskId && placement?.kind === "remote_machine") return placement.machineId;
		}
	return undefined;
}

/**
 * Whether `taskId` carries a work step of an open plan (the step's release task, or the task a rerun moved it to). Such a
 * step's unverified result is checked by the plan: its verify step reviews it, or the plan adds one.
 */
function runsPlanWorkStep(snapshot: TaskRuntimeProjection, taskId: string): boolean {
	for (const plan of Object.values(snapshot.plans)) {
		if (plan.closed || "unsupported" in plan.record) continue;
		for (const [nodeId, node] of Object.entries(plan.nodes)) {
			if (!node.release || currentTaskOf(snapshot, node.release.taskId) !== taskId) continue;
			return plan.record.nodes.find((spec) => spec.id === nodeId)?.kind === "work";
		}
	}
	return false;
}

/** The most characters of a rejected review's reason codes a remedy quotes. */
const REVIEW_REASON_CHARS = 240;

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
	/** A rerun the original authority could not be rebuilt into: the owner decides, the ladder does not retry it. */
	readonly rungRefusal?: string;
}): LadderFacts {
	const { snapshot, attempt, context } = args;
	const task = snapshot.tasks[attempt.taskId];
	const escalations = task?.escalations ?? [];
	const originTaskId = escalations.find((entry) => entry.supersedesTaskId !== undefined)?.supersedesTaskId;
	const firstAttemptId =
		(originTaskId ? snapshot.tasks[originTaskId]?.attemptIds[0] : undefined) ??
		args.previous?.attempts[0]?.attemptId ??
		task?.attemptIds[0] ??
		attempt.attemptId;
	const originAttempt = snapshot.attempts[firstAttemptId] ?? attempt;
	const contract = attempt.dispatch.executionContract?.worker;
	const originContract = originAttempt.dispatch.executionContract?.worker ?? contract;
	const modelRef = args.lane.modelRef ?? (contract ? modelRefOf(contract.modelBinding) : "unknown");
	const thinking = isThinkingLevel(args.lane.thinkingLevel) ? args.lane.thinkingLevel : undefined;
	const policy = originContract?.profile.modelPolicy;
	const candidates: LadderCandidate[] =
		policy?.mode === "ordered-fallback"
			? policy.candidates.map((candidate) => ({
					modelRef: modelRefOf(candidate),
					...(candidate.thinkingLevel ? { thinking: candidate.thinkingLevel } : {}),
				}))
			: [];
	const checkable = context?.requirementCheckIds?.() ?? new Set<string>();
	const hostCheckable = args.coverage.uncovered
		.filter((entry) => checkable.has(entry.id) && !args.checkedIds.has(entry.id))
		.map((entry) => entry.id);
	const route = originAttempt.dispatch.modelRouteSource;
	const remoteMachineId = remoteMachineOf(snapshot, attempt.taskId);
	const review = reviewRunVerdict(snapshot, attempt);
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
		hostCheckable,
		budgetLeft: budgetLeft(snapshot, attempt),
		...(remoteMachineId !== undefined ? { remoteMachineId } : {}),
		...(args.rungRefusal !== undefined ? { rungRefusal: args.rungRefusal } : {}),
		...(review?.kind === "rejected" ? { reviewRejection: boundedReasonCodes(review.reasonCodes) } : {}),
		...(runsPlanWorkStep(snapshot, attempt.taskId) ? { planChecksResult: true } : {}),
	};
}

/** The reason codes a rejected review named, as one bounded line for the remedy. */
function boundedReasonCodes(codes: readonly string[]): string {
	return (codes.join(", ") || "no reason given").slice(0, REVIEW_REASON_CHARS);
}
