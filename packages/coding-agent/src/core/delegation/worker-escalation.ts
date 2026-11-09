import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { FleetDispatch, FleetScheduler } from "../fleet/fleet-types.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { runRequirementCheck } from "../goals/requirement-checks.ts";
import { ORCHESTRATION_THINKING_LEVELS, type WorkerExecutionAuthorityContract } from "../orchestration/contracts.ts";
import type { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import type { TaskEscalationRecord, TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import type { Placement } from "../placement/placement-types.ts";
import { boundedText } from "../util/bounded-line.ts";
import type { HostRequirementCheck } from "./worker-escalation-facts.ts";
import { escalationSignature } from "./worker-escalation-policy.ts";
import type { NextAction, Outcome } from "./worker-outcome-contract.ts";

/** At most 16 KiB of instructions per fleet dispatch. */
const MAX_DISPATCH_INSTRUCTIONS_CHARS = 16 * 1024;
const MAX_LISTED_REQUIREMENT_CHARS = 400;
const LOCAL_PLACEMENT: Placement = { kind: "local_worker" };

/** A stable digest of the authority a worker was admitted with; an escalation must carry its original's. */
export function authorityDigest(authority: WorkerExecutionAuthorityContract): string {
	const sorted = (values: readonly string[]) => [...values].sort();
	const material = JSON.stringify({
		capabilities: sorted(authority.capabilities),
		toolNames: sorted(authority.toolNames),
		readPaths: sorted(authority.readPaths),
		writePaths: sorted(authority.writePaths),
		deniedPaths: sorted(authority.deniedPaths),
		budget: Object.entries(authority.budget).sort(([left], [right]) => left.localeCompare(right)),
		cwd: authority.cwd ?? null,
	});
	return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/**
 * The authority digest of the first attempt behind `outcomeId`: the fleet's `escalationAuthorityDigest` dependency.
 * Undefined when no task of the projection holds that outcome.
 */
export function escalationAuthorityDigest(snapshot: TaskRuntimeProjection, outcomeId: string): string | undefined {
	const task = Object.values(snapshot.tasks).find((candidate) => candidate.outcome?.outcomeId === outcomeId);
	const outcome = task?.outcome;
	if (!task || !outcome || "unsupported" in outcome) return undefined;
	const firstAttemptId = outcome.attempts[0]?.attemptId ?? task.attemptIds[0];
	const authority = firstAttemptId
		? snapshot.attempts[firstAttemptId]?.dispatch.executionContract?.worker.authority
		: undefined;
	return authority ? authorityDigest(authority) : undefined;
}

export interface WorkerEscalationDeps {
	readonly runtime: DurableTaskRuntime;
	readonly fleet: Pick<FleetScheduler, "prepare" | "admit">;
	goalState(): GoalState | undefined;
	cwd(): string;
	/** Re-record the attempt's outcome with the host checks just run. */
	recordChecks(attemptId: string, checks: readonly HostRequirementCheck[]): void;
	readonly signal: AbortSignal;
	now?(): number;
}

type RerunAction = Extract<NextAction, { kind: "rerun_uncovered" }>;

/**
 * Acts on the ladder's next action for one recorded outcome: runs host requirement checks (E12) and places escalation
 * rungs (E6, E14, E15) through the fleet's two-phase start. A placed rung is recorded as `task.escalation_scheduled`,
 * keyed by outcome and rung, so a replay or a repeated notification never places the same work twice.
 */
export class WorkerEscalation {
	private readonly deps: WorkerEscalationDeps;
	private readonly checkedAttempts = new Set<string>();
	private readonly inFlight = new Set<string>();

	constructor(deps: WorkerEscalationDeps) {
		this.deps = deps;
	}

	follow(outcome: Outcome): void {
		if (this.deps.signal.aborted) return;
		if (outcome.nextAction.kind === "host_check") void this.runChecks(outcome, outcome.nextAction.requirementIds);
		else if (outcome.nextAction.kind === "rerun_uncovered") void this.placeRung(outcome, outcome.nextAction);
	}

	/** E12: run each listed requirement's host check once for the attempt, then re-record the outcome with the results. */
	private async runChecks(outcome: Outcome, requirementIds: readonly string[]): Promise<void> {
		const attemptId = outcome.attempts.at(-1)?.attemptId;
		if (!attemptId || this.checkedAttempts.has(attemptId)) return;
		this.checkedAttempts.add(attemptId);
		const requirements = new Map((this.deps.goalState()?.requirements ?? []).map((entry) => [entry.id, entry]));
		const checks: HostRequirementCheck[] = [];
		for (const id of requirementIds) {
			const check = requirements.get(id)?.check;
			if (!check) continue;
			const result = await runRequirementCheck(check, { cwd: this.deps.cwd(), signal: this.deps.signal });
			if (this.deps.signal.aborted) return;
			checks.push({ id, passed: result.passed });
		}
		harnessLog.info("escalation", "host requirement checks ran after a worker attempt", {
			outcomeId: outcome.outcomeId,
			passed: checks.filter((check) => check.passed).length,
			failed: checks.filter((check) => !check.passed).length,
		});
		if (checks.length > 0) this.deps.recordChecks(attemptId, checks);
	}

	/** Place one rung through `prepare` then `admit`; a refusal is logged and nothing is recorded. */
	private async placeRung(outcome: Outcome, action: RerunAction): Promise<void> {
		const taskId = outcome.taskId;
		if (!taskId) return;
		const key = `escalation:${outcome.outcomeId}:r${action.rung}`;
		const snapshot = this.deps.runtime.getSnapshot();
		const task = snapshot.tasks[taskId];
		if (!task || this.inFlight.has(key)) return;
		if (task.escalations?.some((entry) => entry.outcomeId === outcome.outcomeId && entry.rung === action.rung))
			return;
		const dispatch = this.dispatchFor(snapshot, outcome, action, key);
		if (!dispatch) {
			harnessLog.info("escalation", "an escalation rung has no admitted contract to repeat", {
				outcomeId: outcome.outcomeId,
				rung: action.rung,
			});
			return;
		}
		this.inFlight.add(key);
		try {
			const prepared = await this.deps.fleet.prepare(dispatch, LOCAL_PLACEMENT, this.deps.signal);
			if (this.deps.signal.aborted) return;
			const decision = prepared.kind === "prepared" ? this.deps.fleet.admit(dispatch, LOCAL_PLACEMENT) : prepared;
			if (decision.kind === "refused") {
				harnessLog.info("escalation", "the fleet refused an escalation rung", {
					outcomeId: outcome.outcomeId,
					rung: action.rung,
					reason: decision.reason,
					blocker: decision.blocker,
					detail: boundedText(decision.detail, 200),
				});
				return;
			}
			const record: TaskEscalationRecord = {
				outcomeId: outcome.outcomeId,
				rung: action.rung,
				signature: escalationSignature(outcome.nodeId, action.requirementIds, action.modelRef, action.thinking),
				taskId: decision.taskId,
				attemptId: decision.attemptId,
				placement: "local",
				modelRef: action.modelRef,
				thinking: action.thinking,
				nodeId: outcome.nodeId,
				...(dispatch.escalation?.supersedesTaskId
					? { supersedesTaskId: dispatch.escalation.supersedesTaskId }
					: {}),
				scheduledAt: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
			};
			this.deps.runtime.recordEscalationScheduled(taskId, record);
			harnessLog.info("escalation", "an escalation rung was placed", {
				outcomeId: outcome.outcomeId,
				rung: action.rung,
				modelRef: action.modelRef,
				thinking: action.thinking,
				decision: decision.kind,
				successor: record.supersedesTaskId !== undefined,
			});
		} catch (error) {
			harnessLog.warn("escalation", "placing an escalation rung failed", {
				outcomeId: outcome.outcomeId,
				rung: action.rung,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			this.inFlight.delete(key);
		}
	}

	/**
	 * The rung's dispatch: the original attempt's contract and write scope with narrowed instructions. A task whose result
	 * the runtime already completed cannot take another attempt, so its rung runs as a successor task that supersedes it.
	 */
	private dispatchFor(
		snapshot: TaskRuntimeProjection,
		outcome: Outcome,
		action: RerunAction,
		idempotencyKey: string,
	): FleetDispatch | undefined {
		const task = outcome.taskId ? snapshot.tasks[outcome.taskId] : undefined;
		const attemptId = outcome.attempts.at(-1)?.attemptId;
		const attempt = attemptId ? snapshot.attempts[attemptId] : undefined;
		const contract = attempt?.dispatch.executionContract?.worker;
		const [provider, ...rest] = action.modelRef.split("/");
		const thinking = ORCHESTRATION_THINKING_LEVELS.find((level) => level === action.thinking);
		if (!task || !attempt || !contract || !provider || rest.length === 0 || !thinking) return undefined;
		const cwd = this.deps.cwd();
		const writes = contract.authority.writePaths.length > 0 && contract.profile.readOnly !== true;
		const firstAttemptId = outcome.attempts[0]?.attemptId ?? attempt.attemptId;
		const original = snapshot.attempts[firstAttemptId]?.dispatch.executionContract?.worker.authority;
		return {
			idempotencyKey,
			demand: {
				nodeId: outcome.nodeId,
				objectiveId: outcome.objectiveId,
				subtreeId: outcome.objectiveId,
				priority: 1,
				onCriticalPath: false,
				writes,
				heavy: false,
			},
			instructions: this.narrowedInstructions(outcome, action, attempt.dispatch.instructions),
			...(attempt.dispatch.brief ? { brief: attempt.dispatch.brief } : {}),
			writeScope: contract.authority.writePaths.map((path) => {
				const inside = relative(cwd, path);
				return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
			}),
			isolation: "shared",
			requirementIds: action.requirementIds,
			dependsOnTaskIds: [],
			thinking,
			model: { provider, modelId: rest.join("/") },
			escalation: {
				outcomeId: outcome.outcomeId,
				rung: action.rung,
				authorityDigest: authorityDigest(original ?? contract.authority),
				previousPlacement: LOCAL_PLACEMENT,
				requirementIds: [...action.requirementIds],
				...(task.task.status === "completed" ? { supersedesTaskId: task.task.taskId } : {}),
			},
		};
	}

	/** The remaining requirements with their text, the met ones marked as done, then the original task. */
	private narrowedInstructions(outcome: Outcome, action: RerunAction, original: string): string {
		const requirements = new Map((this.deps.goalState()?.requirements ?? []).map((entry) => [entry.id, entry.text]));
		const remaining = action.requirementIds.map(
			(id) =>
				`- ${id}: ${boundedText(requirements.get(id) ?? "(text not available)", MAX_LISTED_REQUIREMENT_CHARS)}`,
		);
		const met = outcome.coverage.covered.map((entry) => entry.id);
		const header = [
			action.rung === 1
				? "An earlier attempt at this task left work unfinished; this run has more thinking."
				: "An earlier attempt at this task left work unfinished; this run is on another model.",
			...(remaining.length > 0
				? ["Requirements still to meet:", ...remaining]
				: ["The whole task is still to be done."]),
			...(met.length > 0 ? [`Already met, do not redo: ${met.join(", ")}`] : []),
			...(outcome.changedFiles.length > 0
				? [`Files the earlier attempt changed: ${outcome.changedFiles.slice(0, 16).join(", ")}`]
				: []),
			"Stay inside the original write scope.",
			"",
			"Original task:",
		].join("\n");
		const room = MAX_DISPATCH_INSTRUCTIONS_CHARS - header.length - 1;
		return `${header}\n${room > 0 ? boundedText(original, room) : ""}`;
	}
}
