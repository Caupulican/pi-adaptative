import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import {
	type EscalationPinnedAuthority,
	type FleetDispatch,
	type FleetRefusal,
	type FleetScheduler,
	laneSubtreeId,
} from "../fleet/fleet-types.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { runRequirementCheck } from "../goals/requirement-checks.ts";
import { nativeAgentIdForAttempt } from "../orchestration/attempt-agent-identity.ts";
import {
	ORCHESTRATION_THINKING_LEVELS,
	type OrchestrationDispatchRequest,
	type WorkerExecutionAuthorityContract,
	type WorkerProfileExecutionContract,
} from "../orchestration/contracts.ts";
import { RUNG_REFUSAL_REASONS, type RungRefusalReason } from "../orchestration/delegation-ledger.ts";
import type { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import type {
	TaskEscalationRecord,
	TaskRuntimeProjection,
	TaskRuntimeState,
} from "../orchestration/task-runtime-state.ts";
import type { Placement } from "../placement/placement-types.ts";
import { boundedText } from "../util/bounded-line.ts";
import { isAdaptiveProfileId } from "./worker-authority-resolver.ts";
import type { HostRequirementCheck } from "./worker-escalation-facts.ts";
import { escalationSignature } from "./worker-escalation-policy.ts";
import type { NextAction, Outcome } from "./worker-outcome-contract.ts";

/** At most 16 KiB of instructions per fleet dispatch. */
const MAX_DISPATCH_INSTRUCTIONS_CHARS = 16 * 1024;
const MAX_LISTED_REQUIREMENT_CHARS = 400;
const LOCAL_PLACEMENT: Placement = { kind: "local_worker" };

/**
 * Where a worker's writes land: its cwd relative to the session cwd ("." for the session root, or an absolute path outside
 * it), and the isolation it runs under. A worktree lane is not a location a rerun can be placed into, so it is `lane`.
 */
export interface RerunPlacement {
	readonly location: string;
	readonly isolation: "shared" | "worktree";
}

/** The placement of a worker's cwd: a lane directory is `lane` under `worktree`; any other cwd is `shared` where it sits. */
export function placementOf(cwd: string, sessionCwd: string, isLaneDirectory: boolean): RerunPlacement {
	if (isLaneDirectory) return { location: "lane", isolation: "worktree" };
	const inside = relative(sessionCwd, cwd);
	if (inside === "") return { location: ".", isolation: "shared" };
	return { location: inside.startsWith("..") || isAbsolute(inside) ? cwd : inside, isolation: "shared" };
}

/**
 * A stable digest of the authority a worker was admitted with and the placement it runs at. Scopes are compared relative to
 * the worker's cwd, so a path under it reads the same wherever the cwd sits; the placement itself is part of the digest, so a
 * rerun that lands elsewhere, or in another isolation, digests differently.
 */
export function authorityDigest(authority: WorkerExecutionAuthorityContract, placement: RerunPlacement): string {
	const cwd = authority.cwd;
	const location = (path: string): string => {
		if (cwd === undefined || !isAbsolute(path)) return path;
		const inside = relative(cwd, path);
		if (inside === "") return ".";
		return inside.startsWith("..") || isAbsolute(inside) ? path : inside;
	};
	const sorted = (values: readonly string[]) => values.map(location).sort();
	const material = JSON.stringify({
		placement: { location: placement.location, isolation: placement.isolation },
		capabilities: [...authority.capabilities].sort(),
		toolNames: [...authority.toolNames].sort(),
		readPaths: sorted(authority.readPaths),
		writePaths: sorted(authority.writePaths),
		deniedPaths: sorted(authority.deniedPaths),
		budget: Object.entries(authority.budget).sort(([left], [right]) => left.localeCompare(right)),
	});
	return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/** Paths relative to a directory, the directory itself as "."; a path outside it stays absolute. */
function relativeToDirectory(directory: string, paths: readonly string[]): string[] {
	return paths.map((path) => {
		const inside = relative(directory, path);
		if (inside === "") return ".";
		return inside.startsWith("..") || isAbsolute(inside) ? path : inside;
	});
}

/** The pinned authority of an original attempt: what the rerun's request must restate to compile the same authority. */
function pinnedAuthorityOf(
	origin: OrchestrationDispatchRequest,
	contract: WorkerProfileExecutionContract,
	placement: RerunPlacement,
	originCwd: string,
): EscalationPinnedAuthority {
	const profileId = contract.profile.profileId;
	const readPaths = contract.profile.readPaths;
	return {
		...(isAdaptiveProfileId(profileId) ? {} : { profileId }),
		...(origin.parentAgentId ? { parentAgentId: origin.parentAgentId } : {}),
		...(contract.botSoul !== undefined ? { botSoul: contract.botSoul } : {}),
		readOnly: contract.profile.readOnly === true,
		...(contract.profile.shellReadOnly === true ? { shellReadOnly: true } : {}),
		location: placement.location,
		...(readPaths !== undefined ? { readScope: relativeToDirectory(originCwd, readPaths) } : {}),
		budget: { ...contract.profile.budget },
		// The rerun keeps who wrote its words and where its results go: a third party's taint is never laundered by a rerun.
		...(origin.turnOrigin ? { turnOrigin: origin.turnOrigin } : {}),
		...(origin.receiptOrigin ? { receiptOrigin: origin.receiptOrigin } : {}),
	};
}

/**
 * How a rung's source task relates to its rerun, read from the snapshot. X1: a completed source keeps a successor that
 * supersedes it. X2: a failed or blocked source whose worker is still registered reruns as a new attempt of the same task,
 * in the same worker conversation; its last attempt's agent must resolve, or the rerun cannot continue that conversation.
 * X3: any other source keeps the unlinked rerun it has always had.
 */
function sourceRelationOf(snapshot: TaskRuntimeProjection, source: TaskRuntimeState): "X1" | "X2" | "X3" {
	if (source.task.status === "completed") return "X1";
	const last = snapshot.attempts[source.attemptIds.at(-1) ?? ""];
	const agentId = last ? nativeAgentIdForAttempt(last) : undefined;
	const agent = agentId === undefined ? undefined : snapshot.agents[agentId];
	const rerunnable =
		(source.task.status === "failed" || source.task.status === "blocked") &&
		agent?.status === "registered" &&
		last?.dispatch.birthContextForkReference !== undefined;
	return rerunnable ? "X2" : "X3";
}

/**
 * The plain words the owner reads for each refusal that asks the owner, one per reason. The transient reasons carry no
 * words: a refused rung for them is logged and the next outcome pass places it again.
 */
const RUNG_REFUSAL_WORDS: Readonly<Record<RungRefusalReason, string | undefined>> = {
	identity_mismatch: "the task's recorded identity no longer matches the rerun",
	authority_digest_mismatch: "the rerun would run under different authority than the original",
	acceptance_criteria_mismatch: "the task's acceptance criteria no longer match the rerun",
	source_state_changed: "the task changed state after its outcome was recorded",
	attempt_ceiling: "the task has spent its attempt budget",
	capacity: undefined,
	other: undefined,
};

/** The ledger's reason token at the start of a refusal detail, bare or behind the start's `worker_start_error:` prefix. */
const RUNG_REFUSAL_TOKEN = /^(?:worker_start_error:)?rung_refused:([a-z_]+)(?::|$)/;

/** The reason a refused rung carries, or undefined when the refusal is not a rung refusal the ladder knows. */
export function rungRefusalReasonOf(refusal: FleetRefusal): RungRefusalReason | undefined {
	if (refusal.reason === "authority_digest_mismatch") return "authority_digest_mismatch";
	const token = RUNG_REFUSAL_TOKEN.exec(refusal.detail)?.[1];
	return RUNG_REFUSAL_REASONS.find((reason) => reason === token);
}

export interface WorkerEscalationDeps {
	/** Whether a directory is a worktree lane: a rerun of a lane's original cannot be placed back into that lane yet. */
	isLaneDirectory(directory: string): boolean;
	readonly runtime: DurableTaskRuntime;
	readonly fleet: Pick<FleetScheduler, "prepare" | "admit">;
	goalState(): GoalState | undefined;
	cwd(): string;
	/** Re-record the attempt's outcome with the host checks just run. */
	recordChecks(attemptId: string, checks: readonly HostRequirementCheck[]): void;
	/** Record that a rung could not start under the original authority: the ladder then asks the owner. */
	recordRefusal(attemptId: string, detail: string): void;
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
		const firstAttemptId = outcome.attempts[0]?.attemptId;
		const originCwd = firstAttemptId
			? snapshot.attempts[firstAttemptId]?.dispatch.executionContract?.worker.authority.cwd
			: undefined;
		if (originCwd !== undefined && this.deps.isLaneDirectory(originCwd)) {
			const refusedAttemptId = outcome.attempts.at(-1)?.attemptId;
			if (refusedAttemptId !== undefined)
				this.deps.recordRefusal(
					refusedAttemptId,
					"the original ran in its own worktree lane, and a rerun cannot be placed back into that lane yet",
				);
			return;
		}
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
				const refusedAttemptId = outcome.attempts.at(-1)?.attemptId;
				const rungReason = rungRefusalReasonOf(decision);
				const words = rungReason === undefined ? undefined : RUNG_REFUSAL_WORDS[rungReason];
				if (words !== undefined && refusedAttemptId !== undefined) this.deps.recordRefusal(refusedAttemptId, words);
				harnessLog.info("escalation", "the fleet refused an escalation rung", {
					outcomeId: outcome.outcomeId,
					rung: action.rung,
					reason: decision.reason,
					rungReason,
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
		const relation = sourceRelationOf(snapshot, task);
		harnessLog.debug("escalation", "an escalation rung's source relation", {
			exit: relation,
			sourceTaskId: task.task.taskId,
		});
		const writes = contract.authority.writePaths.length > 0 && contract.profile.readOnly !== true;
		// The rerun is rebuilt from the attempt the outcome was recorded under: its authority, scope, placement and origin.
		const firstAttemptId = outcome.attempts[0]?.attemptId ?? attempt.attemptId;
		const origin = snapshot.attempts[firstAttemptId]?.dispatch ?? attempt.dispatch;
		const originContract = origin.executionContract?.worker ?? contract;
		const originCwd = originContract.authority.cwd ?? this.deps.cwd();
		const placement = placementOf(originCwd, this.deps.cwd(), this.deps.isLaneDirectory(originCwd));
		return {
			idempotencyKey,
			demand: {
				nodeId: outcome.nodeId,
				objectiveId: outcome.objectiveId,
				subtreeId: laneSubtreeId(origin.parentAgentId),
				priority: 1,
				onCriticalPath: false,
				writes,
				heavy: false,
			},
			instructions: this.narrowedInstructions(outcome, action, attempt.dispatch.instructions),
			...(attempt.dispatch.brief ? { brief: attempt.dispatch.brief } : {}),
			writeScope: relativeToDirectory(originCwd, originContract.authority.writePaths),
			isolation: "shared",
			requirementIds: action.requirementIds,
			dependsOnTaskIds: [],
			thinking,
			model: { provider, modelId: rest.join("/") },
			escalation: {
				outcomeId: outcome.outcomeId,
				rung: action.rung,
				authorityDigest: authorityDigest(originContract.authority, placement),
				previousPlacement: LOCAL_PLACEMENT,
				requirementIds: [...action.requirementIds],
				pinned: pinnedAuthorityOf(origin, originContract, placement, originCwd),
				...(relation === "X1" ? { supersedesTaskId: task.task.taskId } : {}),
				...(relation === "X2"
					? { attemptOfTaskId: task.task.taskId, acceptanceCriterionIds: [...task.task.acceptanceCriterionIds] }
					: {}),
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
