/**
 * Which closed orchestration work may be released, and what releasing it deletes. Pure over the projection: the units
 * (closed objectives, finished session tasks, and closed session plans with the tasks they name), the projection holds
 * that keep a unit, the planner's selection, the dependents and turn carry a prune writes, and the check the reducer
 * re-runs before it applies a prune. A session task unit shares its objective with every other task of its session, so a
 * pending notice, a pending approval or an open plan on that objective does not hold it: those three holds reach a session
 * task only through a record that names its own task or attempts. A closed session plan is released only together with
 * every task it names (one `session_plan` unit), so no retained plan can name a released task. The external holds
 * (delegation records, mailboxes, goals) come in from the caller, so this module never imports the leader delegation
 * ledger, which would close an import cycle through the reducer. Two check families live here: the structural checks a
 * payload passes wherever it is applied (`assertRetentionPruneWellFormed`, replay included), and the planner's rules that
 * judge a prune before it is appended (`assertRetentionPruneAllowed`). retention.ts states which is which.
 */

import { isPlanFromNewerBuild, type PlanRuntimeState } from "../plan/plan-graph.ts";
import { canonicalDigest } from "../steering/canonical.ts";
import { nativeAgentIdForAttempt } from "./attempt-agent-identity.ts";
import { latestAgentAttemptByDurableOrder, latestAgentAttemptsByDurableOrder } from "./attempt-ordering.ts";
import type { AgentPrunedTurns } from "./contracts.ts";
import { MAX_RETENTION_PRUNE_RECORDS, type RetentionPrunedPayload, retentionArchiveId } from "./retention-event.ts";
import {
	type AttemptRuntimeState,
	attemptTurnOrigin,
	DurableTaskRuntimeError,
	type TaskRuntimeProjection,
	terminalAttemptStatus,
} from "./task-runtime-state.ts";
import { attemptAwaitsParent, taskAwaitsVerification } from "./verification-identity.ts";
import { workerReceiptPublicationPending } from "./worker-receipt-publication.ts";

const SESSION_OBJECTIVE_PREFIX = "session:";
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
const CLOSED_OBJECTIVE_STATUSES: ReadonlySet<string> = new Set(["completed", "cancelled"]);

/** Refuses a prune in plain words; typed `never` so callers narrow after it. */
function refuse(reason: string): never {
	throw new DurableTaskRuntimeError(`Retention prune refused: ${reason}.`);
}

/** Below this many free objective or attempt slots, a closed unit with no hold is released regardless of age. */
export const RETENTION_PRESSURE_HEADROOM = 32;

/**
 * The projection holds, checked in this order; the first true one is the one reported. Checks 1-12 of the spec. Holds 3-5
 * name an objective only for an objective unit (see the module header).
 */
export const RETENTION_HOLD_ORDER = [
	"unfinished_task",
	"live_attempt",
	"pending_notice",
	"pending_approval",
	"open_plan",
	"receipt_outbox",
	"awaiting_parent",
	"host_event_custody",
	"resume_basis",
	"managed_lane",
	"tree_live",
	"referenced",
] as const;
export type RetentionHold = (typeof RETENTION_HOLD_ORDER)[number];

/** Objective-level holds the pass computes from delegation state and passes in. */
export type ExternalHold =
	| "outcome_undelivered"
	| "delegated_message_pending"
	| "follower_open"
	| "current_goal"
	| "delegation_open_parent";

/**
 * One releasable unit. An objective unit is a closed non-session objective with all its tasks, attempts and plans. A
 * `session_task` unit is one finished task of a `session:` objective with its attempts, and no closed session plan names
 * it. A `session_plan` unit is a group of closed session plans that share a named task, with every task and attempt they
 * name: each plan is released only with all of them.
 */
export interface RetentionUnit {
	readonly kind: "objective" | "session_task" | "session_plan";
	/** `objective:<id>`, `task:<id>` or `plan:<lowest planId of the group>`; unique across kinds. */
	readonly key: string;
	readonly objectiveId: string;
	readonly taskIds: readonly string[];
	readonly attemptIds: readonly string[];
	readonly planIds: readonly string[];
	readonly lastActivity: string;
	readonly lastActivityMs: number;
}

export interface RetentionDependents {
	readonly checkpointIds: readonly string[];
	readonly notificationIds: readonly string[];
	readonly approvalIds: readonly string[];
	/** The released session plans, sorted. An objective's plans are released with the objective, not listed here. */
	readonly planIds: readonly string[];
	readonly subscriptionIds: readonly string[];
}

export interface RetentionSelectionInput {
	readonly state: TaskRuntimeProjection;
	readonly cutoff: string;
	readonly externalObjectiveHolds: ReadonlyMap<string, ExternalHold>;
	readonly externalAgentHolds: ReadonlySet<string>;
	readonly externalAttemptHolds: ReadonlySet<string>;
}

export interface RetentionSelection {
	readonly objectiveIds: readonly string[];
	readonly taskIds: readonly string[];
	readonly attemptIds: readonly string[];
	readonly planIds: readonly string[];
	readonly dependents: RetentionDependents;
	readonly carry: ReadonlyMap<string, AgentPrunedTurns>;
	/** The per-list bound stopped selection before every eligible unit was taken. */
	readonly truncated: boolean;
	/** Old units not released because a hold, an external hold or a reference kept them. */
	readonly held: number;
}

/** The ids one prune releases, by kind. */
interface ReleasedIds {
	readonly objectiveIds: readonly string[];
	readonly taskIds: readonly string[];
	readonly attemptIds: readonly string[];
	readonly planIds: readonly string[];
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

function latestIso(values: readonly string[]): string {
	let latest = values[0]!;
	for (const value of values) if (Date.parse(value) > Date.parse(latest)) latest = value;
	return latest;
}

function hasOpaquePlan(state: TaskRuntimeProjection): boolean {
	return Object.values(state.plans).some((plan) => isPlanFromNewerBuild(plan.record));
}

function unitOf(
	kind: RetentionUnit["kind"],
	key: string,
	objectiveId: string,
	taskIds: readonly string[],
	attemptIds: readonly string[],
	planIds: readonly string[],
	lastActivity: string,
): RetentionUnit {
	return {
		kind,
		key,
		objectiveId,
		taskIds: [...taskIds],
		attemptIds: [...attemptIds],
		planIds: [...planIds],
		lastActivity,
		lastActivityMs: Date.parse(lastActivity),
	};
}

/**
 * The successor each superseded task resolves to: the first match in projection order, the rule `successorOf` in
 * task-successor.ts applies. Built once per read, so a plan's names cost one lookup each.
 */
function successorIndex(state: TaskRuntimeProjection): ReadonlyMap<string, string> {
	const successors = new Map<string, string>();
	for (const task of Object.values(state.tasks)) {
		for (const record of task.escalations ?? []) {
			const superseded = record.supersedesTaskId;
			if (superseded !== undefined && record.taskId !== superseded && !successors.has(superseded)) {
				successors.set(superseded, record.taskId);
			}
		}
	}
	return successors;
}

function isSessionTask(state: TaskRuntimeProjection, taskId: string): boolean {
	return state.tasks[taskId]?.task.objectiveId.startsWith(SESSION_OBJECTIVE_PREFIX) ?? false;
}

/**
 * The tasks a plan names: the release of every node and every retired entry, each followed through its successors the way
 * the plan reads its work (`currentTaskOf`). A name the projection no longer holds was released already, so it is skipped:
 * no retained record can name it.
 */
function planTaskNames(
	state: TaskRuntimeProjection,
	plan: PlanRuntimeState,
	successors: ReadonlyMap<string, string>,
): string[] {
	const named = new Set<string>();
	const direct = [
		...Object.values(plan.nodes).flatMap((node) => (node.release ? [node.release.taskId] : [])),
		...plan.retired.map((entry) => entry.taskId),
	];
	for (const taskId of direct) {
		let current: string | undefined = taskId;
		while (current !== undefined && !named.has(current)) {
			named.add(current);
			current = successors.get(current);
		}
	}
	return [...named].filter((taskId) => state.tasks[taskId] !== undefined).sort();
}

interface SessionPlanMember {
	readonly names: readonly string[];
	readonly objectiveId: string;
	readonly activity: readonly string[];
}

/**
 * The closed session plans as units. Plans that name a common task form one group, because each must be released with
 * every task it names. A closed session plan that names a task outside session work is left out: it stays retained, and
 * check 12 keeps the names it reads.
 */
function sessionPlanUnits(state: TaskRuntimeProjection, successors: ReadonlyMap<string, string>): RetentionUnit[] {
	const members = new Map<string, SessionPlanMember>();
	for (const [planId, plan] of Object.entries(state.plans)) {
		const record = plan.record;
		if (isPlanFromNewerBuild(record) || plan.closed === undefined) continue;
		if (!record.objectiveId.startsWith(SESSION_OBJECTIVE_PREFIX)) continue;
		const names = planTaskNames(state, plan, successors);
		if (names.some((taskId) => !isSessionTask(state, taskId))) continue;
		members.set(planId, {
			names,
			objectiveId: record.objectiveId,
			activity: [record.revisedAt, plan.closed.closedAt],
		});
	}
	const plansByTask = new Map<string, string[]>();
	for (const [planId, member] of members) for (const taskId of member.names) pushTo(plansByTask, taskId, planId);
	const seen = new Set<string>();
	const units: RetentionUnit[] = [];
	for (const start of members.keys()) {
		if (seen.has(start)) continue;
		seen.add(start);
		const planIds: string[] = [];
		const taskIds = new Set<string>();
		const pending = [start];
		while (pending.length > 0) {
			const planId = pending.pop()!;
			planIds.push(planId);
			for (const taskId of members.get(planId)!.names) {
				taskIds.add(taskId);
				for (const other of plansByTask.get(taskId)!) {
					if (!seen.has(other)) {
						seen.add(other);
						pending.push(other);
					}
				}
			}
		}
		planIds.sort();
		const tasks = [...taskIds].sort();
		const attemptIds = tasks.flatMap((taskId) => state.tasks[taskId]!.attemptIds);
		const activity = [
			...planIds.flatMap((planId) => members.get(planId)!.activity),
			...tasks.map((taskId) => state.tasks[taskId]!.task.updatedAt),
			...attemptIds.map((id) => state.attempts[id]!.updatedAt),
		];
		units.push(
			unitOf(
				"session_plan",
				`plan:${planIds[0]}`,
				members.get(planIds[0]!)!.objectiveId,
				tasks,
				attemptIds,
				planIds,
				latestIso(activity),
			),
		);
	}
	return units;
}

/** Every releasable unit of the projection, oldest last activity first (ties by key). */
export function retentionUnits(state: TaskRuntimeProjection): RetentionUnit[] {
	const successors = successorIndex(state);
	const plansByObjective = new Map<string, string[]>();
	for (const [planId, plan] of Object.entries(state.plans)) {
		if (!isPlanFromNewerBuild(plan.record)) pushTo(plansByObjective, plan.record.objectiveId, planId);
	}
	const sessionPlans = sessionPlanUnits(state, successors);
	const planned = new Set(sessionPlans.flatMap((unit) => unit.taskIds));
	const units: RetentionUnit[] = [...sessionPlans];
	for (const [objectiveId, runtime] of Object.entries(state.objectives)) {
		if (objectiveId.startsWith(SESSION_OBJECTIVE_PREFIX)) {
			for (const taskId of runtime.taskIds) {
				const task = state.tasks[taskId];
				if (!task || planned.has(taskId) || !TERMINAL_TASK_STATUSES.has(task.task.status)) continue;
				const attempts = task.attemptIds.map((id) => state.attempts[id]!);
				const lastActivity = latestIso([task.task.updatedAt, ...attempts.map((attempt) => attempt.updatedAt)]);
				units.push(
					unitOf("session_task", `task:${taskId}`, objectiveId, [taskId], task.attemptIds, [], lastActivity),
				);
			}
			continue;
		}
		if (!CLOSED_OBJECTIVE_STATUSES.has(runtime.objective.status)) continue;
		const tasks = runtime.taskIds.map((id) => state.tasks[id]!);
		const attemptIds = tasks.flatMap((task) => task.attemptIds);
		const activity = [
			runtime.objective.updatedAt,
			...runtime.evidence.map((evidence) => evidence.createdAt),
			...tasks.map((task) => task.task.updatedAt),
			...attemptIds.map((id) => state.attempts[id]!.updatedAt),
		];
		units.push(
			unitOf(
				"objective",
				`objective:${objectiveId}`,
				objectiveId,
				runtime.taskIds,
				attemptIds,
				plansByObjective.get(objectiveId) ?? [],
				latestIso(activity),
			),
		);
	}
	return units.sort((left, right) => left.lastActivityMs - right.lastActivityMs || compareKeys(left.key, right.key));
}

function compareKeys(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** The ids a set of units releases. A unit's plans leave with it: an objective's plans, or a session plan group's. */
function releasedIdsOf(units: readonly RetentionUnit[]): ReleasedIds {
	return {
		objectiveIds: units.filter((unit) => unit.kind === "objective").map((unit) => unit.objectiveId),
		taskIds: units.flatMap((unit) => unit.taskIds),
		attemptIds: units.flatMap((unit) => unit.attemptIds),
		planIds: units.flatMap((unit) => unit.planIds),
	};
}

/** Native attempts per agent, in projection insertion order: the order the prefix rule reads. */
function nativeAttemptsByAgent(state: TaskRuntimeProjection): Map<string, string[]> {
	const natives = new Map<string, string[]>();
	for (const attempt of Object.values(state.attempts)) {
		const agentId = nativeAgentIdForAttempt(attempt);
		if (agentId !== undefined) pushTo(natives, agentId, attempt.attemptId);
	}
	return natives;
}

/** Every fact the projection holds, read once, so each unit's holds are set lookups. */
interface HoldFacts {
	readonly pendingNoticeObjectives: ReadonlySet<string>;
	readonly pendingNoticeAttempts: ReadonlySet<string>;
	readonly pendingApprovalObjectives: ReadonlySet<string>;
	readonly pendingApprovalTasks: ReadonlySet<string>;
	readonly pendingApprovalAttempts: ReadonlySet<string>;
	readonly openPlanObjectives: ReadonlySet<string>;
	/** The tasks an open plan names: it holds them. A closed plan holds none (see `projectionHoldOf`). */
	readonly openPlanTasks: ReadonlySet<string>;
	/** Latest native attempts whose result still needs the parent, of a binding that is not retired (`attemptAwaitsParent`). */
	readonly awaitingParentAttempts: ReadonlySet<string>;
	readonly custodyTasks: ReadonlySet<string>;
	readonly custodyAttempts: ReadonlySet<string>;
	readonly resumeAttempts: ReadonlySet<string>;
	readonly unretiredLanes: ReadonlySet<string>;
	readonly liveTreeRoots: ReadonlySet<string>;
}

function managedLaneOf(attempt: AttemptRuntimeState): string | undefined {
	return attempt.dispatch.executionKind === "managed-process" ? attempt.dispatch.logicalLaneId : undefined;
}

function holdFacts(state: TaskRuntimeProjection): HoldFacts {
	const pendingNoticeObjectives = new Set<string>();
	const pendingNoticeAttempts = new Set<string>();
	for (const notification of Object.values(state.notifications)) {
		if (notification.status !== "pending") continue;
		pendingNoticeObjectives.add(notification.objectiveId);
		if (notification.attemptId !== undefined) pendingNoticeAttempts.add(notification.attemptId);
	}
	const pendingApprovalObjectives = new Set<string>();
	const pendingApprovalTasks = new Set<string>();
	const pendingApprovalAttempts = new Set<string>();
	for (const approval of Object.values(state.approvals)) {
		if (approval.status !== "pending") continue;
		const request = approval.request;
		pendingApprovalObjectives.add(request.objectiveId);
		if (request.taskId !== undefined) pendingApprovalTasks.add(request.taskId);
		if (request.attemptId !== undefined) pendingApprovalAttempts.add(request.attemptId);
	}
	const openPlanObjectives = new Set<string>();
	const openPlanTasks = new Set<string>();
	const successors = successorIndex(state);
	for (const plan of Object.values(state.plans)) {
		const record = plan.record;
		if (plan.closed !== undefined || isPlanFromNewerBuild(record)) continue;
		openPlanObjectives.add(record.objectiveId);
		if (record.subgraphOf !== undefined) openPlanObjectives.add(record.subgraphOf.delegationObjectiveId);
		for (const taskId of planTaskNames(state, plan, successors)) openPlanTasks.add(taskId);
	}
	const custodyTasks = new Set<string>();
	const custodyAttempts = new Set<string>();
	for (const delivery of Object.values(state.eventDeliveries)) {
		if (delivery.target.kind === "task") custodyTasks.add(delivery.target.taskId);
		if (delivery.binding) {
			custodyTasks.add(delivery.binding.execution.taskId);
			custodyAttempts.add(delivery.binding.execution.attemptId);
		}
	}
	for (const subscription of Object.values(state.threadSubscriptions)) {
		if (subscription.revokedOrdinal === undefined) custodyTasks.add(subscription.taskId);
	}
	const resumeAttempts = new Set<string>();
	for (const agent of Object.values(state.agents)) {
		if (agent.activeAttemptId !== undefined) resumeAttempts.add(agent.activeAttemptId);
		const checkpointId = agent.resumeContext.latestCheckpointId;
		const checkpoint = checkpointId === undefined ? undefined : state.checkpoints[checkpointId];
		if (checkpoint) resumeAttempts.add(checkpoint.attemptId);
	}
	const latestNative = latestAgentAttemptsByDurableOrder(state);
	for (const [agentId, agent] of Object.entries(state.agents)) {
		if (agent.status !== "suspended" && agent.status !== "resuming") continue;
		const latest = latestNative.get(agentId);
		if (latest) resumeAttempts.add(latest.attemptId);
	}
	// The reader shows `awaitingParent` only for a registered idle binding, so a retired binding never shows it again. Its
	// last result holds nothing; every other binding's result that still needs the parent is held here, whatever its status.
	const awaitingParentAttempts = new Set<string>();
	for (const [agentId, latest] of latestNative) {
		if (state.agents[agentId]?.status !== "retired" && attemptAwaitsParent(state, latest)) {
			awaitingParentAttempts.add(latest.attemptId);
		}
	}
	const unretiredLanes = new Set<string>();
	const liveTreeRoots = new Set<string>();
	for (const attempt of Object.values(state.attempts)) {
		const lane = managedLaneOf(attempt);
		if (lane !== undefined && attempt.managedLifetime !== "retired") unretiredLanes.add(lane);
		if (!terminalAttemptStatus(attempt.status) && attempt.agentId !== undefined) {
			const root = state.agents[attempt.agentId]?.rootAgentId;
			if (root !== undefined) liveTreeRoots.add(root);
		}
	}
	return {
		pendingNoticeObjectives,
		pendingNoticeAttempts,
		pendingApprovalObjectives,
		pendingApprovalTasks,
		pendingApprovalAttempts,
		openPlanObjectives,
		openPlanTasks,
		awaitingParentAttempts,
		custodyTasks,
		custodyAttempts,
		resumeAttempts,
		unretiredLanes,
		liveTreeRoots,
	};
}

function receiptOutboxHeld(state: TaskRuntimeProjection, attempt: AttemptRuntimeState): boolean {
	return (
		Object.keys(attempt.usageReceipts ?? {}).length > 0 ||
		Object.keys(attempt.parentWrites ?? {}).length > 0 ||
		workerReceiptPublicationPending(state, attempt)
	);
}

function treeLive(state: TaskRuntimeProjection, facts: HoldFacts, attempt: AttemptRuntimeState): boolean {
	const root = attempt.agentId === undefined ? undefined : state.agents[attempt.agentId]?.rootAgentId;
	return root !== undefined && facts.liveTreeRoots.has(root);
}

function managedLaneHeld(facts: HoldFacts, attempt: AttemptRuntimeState): boolean {
	const lane = managedLaneOf(attempt);
	return lane !== undefined && facts.unretiredLanes.has(lane);
}

/**
 * The first projection hold (checks 1-11) that keeps a unit, or undefined. Check 12 is `referencedReleasedIds`. Holds 3-5
 * read the objective only for an objective unit. Dropping that clause for a session unit leaves no dangling record: the
 * notices, approvals and plans it no longer holds name only the session objective, which is never released, and
 * `deriveDependents` deletes a notice or approval only by a released objective, task or attempt id.
 */
function projectionHoldOf(
	state: TaskRuntimeProjection,
	facts: HoldFacts,
	unit: RetentionUnit,
): RetentionHold | undefined {
	const tasks = unit.taskIds.map((id) => state.tasks[id]!);
	const attempts = unit.attemptIds.map((id) => state.attempts[id]!);
	const isObjective = unit.kind === "objective";
	const isSession = !isObjective;
	if (
		tasks.some(
			(task) => !TERMINAL_TASK_STATUSES.has(task.task.status) || taskAwaitsVerification(state, task.task.taskId),
		)
	)
		return "unfinished_task";
	if (attempts.some((attempt) => !terminalAttemptStatus(attempt.status))) return "live_attempt";
	// A notice carries no task id, so a session task unit is held only by a notice on one of its attempts.
	if (
		(isObjective && facts.pendingNoticeObjectives.has(unit.objectiveId)) ||
		attempts.some((attempt) => facts.pendingNoticeAttempts.has(attempt.attemptId))
	)
		return "pending_notice";
	if (
		(isObjective && facts.pendingApprovalObjectives.has(unit.objectiveId)) ||
		unit.taskIds.some((id) => facts.pendingApprovalTasks.has(id)) ||
		attempts.some((attempt) => facts.pendingApprovalAttempts.has(attempt.attemptId))
	)
		return "pending_approval";
	// An open plan holds every task it names. A closed plan holds nothing here: it is released with the tasks it names (a
	// `session_plan` unit), and check 12 keeps the names of a closed plan that is not released.
	if (
		(isObjective && facts.openPlanObjectives.has(unit.objectiveId)) ||
		(isSession && unit.taskIds.some((id) => facts.openPlanTasks.has(id)))
	)
		return "open_plan";
	if (attempts.some((attempt) => receiptOutboxHeld(state, attempt))) return "receipt_outbox";
	if (attempts.some((attempt) => facts.awaitingParentAttempts.has(attempt.attemptId))) return "awaiting_parent";
	if (
		unit.taskIds.some((id) => facts.custodyTasks.has(id)) ||
		attempts.some((attempt) => facts.custodyAttempts.has(attempt.attemptId))
	)
		return "host_event_custody";
	if (attempts.some((attempt) => facts.resumeAttempts.has(attempt.attemptId))) return "resume_basis";
	if (attempts.some((attempt) => managedLaneHeld(facts, attempt))) return "managed_lane";
	if (attempts.some((attempt) => treeLive(state, facts, attempt))) return "tree_live";
	return undefined;
}

function externallyHeld(unit: RetentionUnit, input: RetentionSelectionInput): boolean {
	if (unit.kind === "objective" && input.externalObjectiveHolds.has(unit.objectiveId)) return true;
	return unit.attemptIds.some((attemptId) => {
		const agentId = input.state.attempts[attemptId]?.agentId;
		return (
			input.externalAttemptHolds.has(attemptId) || (agentId !== undefined && input.externalAgentHolds.has(agentId))
		);
	});
}

/**
 * Check 12: the released records a retained record names, as keys `objective:`, `task:`, `attempt:` or `plan:` plus the
 * id. A retained record is any record outside `released`, so a released session plan is exempt. Every reference here is one
 * the reducer's snapshot decode enforces or one a retained record would dangle through.
 */
function referencedReleasedIds(state: TaskRuntimeProjection, released: ReleasedIds): Set<string> {
	const objectives = new Set(released.objectiveIds);
	const tasks = new Set(released.taskIds);
	const attempts = new Set(released.attemptIds);
	const plans = new Set(released.planIds);
	const successors = successorIndex(state);
	const found = new Set<string>();
	const note = (kind: string, members: ReadonlySet<string>, id: string | undefined) => {
		if (id !== undefined && members.has(id)) found.add(`${kind}:${id}`);
	};
	for (const [taskId, runtime] of Object.entries(state.tasks)) {
		if (tasks.has(taskId)) continue;
		const task = runtime.task;
		for (const dependency of task.dependsOn) note("task", tasks, dependency);
		note("task", tasks, task.verificationOfTaskId);
		note("attempt", attempts, task.verificationOfAttemptId);
		if (runtime.verification) {
			note("task", tasks, runtime.verification.verifierTaskId);
			note("attempt", attempts, runtime.verification.verifierAttemptId);
		}
		for (const escalation of runtime.escalations ?? []) {
			note("task", tasks, escalation.supersedesTaskId);
			note("task", tasks, escalation.taskId);
			note("attempt", attempts, escalation.attemptId);
		}
	}
	for (const [attemptId, attempt] of Object.entries(state.attempts)) {
		if (attempts.has(attemptId)) continue;
		note("task", tasks, attempt.taskId);
		if (attempt.verification) {
			note("task", tasks, attempt.verification.verifierTaskId);
			note("attempt", attempts, attempt.verification.verifierAttemptId);
			note("attempt", attempts, attempt.verification.subjectAttemptId);
		}
	}
	for (const [planId, plan] of Object.entries(state.plans)) {
		if (plans.has(planId) || isPlanFromNewerBuild(plan.record)) continue;
		note("objective", objectives, plan.record.objectiveId);
		if (plan.record.subgraphOf !== undefined) {
			note("plan", plans, plan.record.subgraphOf.parentPlanId);
			note("objective", objectives, plan.record.subgraphOf.delegationObjectiveId);
		}
		for (const taskId of planTaskNames(state, plan, successors)) note("task", tasks, taskId);
	}
	return found;
}

function unitIsReferenced(unit: RetentionUnit, referenced: ReadonlySet<string>): boolean {
	if (unit.kind === "objective" && referenced.has(`objective:${unit.objectiveId}`)) return true;
	return (
		unit.taskIds.some((id) => referenced.has(`task:${id}`)) ||
		unit.attemptIds.some((id) => referenced.has(`attempt:${id}`)) ||
		unit.planIds.some((id) => referenced.has(`plan:${id}`))
	);
}

/**
 * The dependents a release deletes: records that name a released objective, task or attempt, and the released session
 * plans (an objective's plans leave with the objective and are not repeated here). Every list is sorted.
 */
export function deriveDependents(
	state: TaskRuntimeProjection,
	released: {
		readonly objectiveIds: readonly string[];
		readonly taskIds: readonly string[];
		readonly attemptIds: readonly string[];
		readonly planIds: readonly string[];
	},
): RetentionDependents {
	const objectives = new Set(released.objectiveIds);
	const tasks = new Set(released.taskIds);
	const attempts = new Set(released.attemptIds);
	return {
		checkpointIds: released.attemptIds.flatMap((id) => state.attempts[id]?.checkpointIds ?? []).sort(),
		notificationIds: Object.values(state.notifications)
			.filter((n) => objectives.has(n.objectiveId) || (n.attemptId !== undefined && attempts.has(n.attemptId)))
			.map((n) => n.notificationId)
			.sort(),
		approvalIds: Object.values(state.approvals)
			.filter(({ request }) => {
				const taskOwned = request.taskId !== undefined && tasks.has(request.taskId);
				const attemptOwned = request.attemptId !== undefined && attempts.has(request.attemptId);
				return objectives.has(request.objectiveId) || taskOwned || attemptOwned;
			})
			.map(({ request }) => request.approvalId)
			.sort(),
		planIds: released.planIds
			.filter((planId) => {
				const plan = state.plans[planId];
				return (
					plan !== undefined &&
					!isPlanFromNewerBuild(plan.record) &&
					plan.record.objectiveId.startsWith(SESSION_OBJECTIVE_PREFIX)
				);
			})
			.sort(),
		subscriptionIds: Object.values(state.threadSubscriptions)
			.filter((s) => s.revokedOrdinal !== undefined && tasks.has(s.taskId))
			.map((s) => s.subscriptionId)
			.sort(),
	};
}

/**
 * The digest a `retention.pruned` payload carries as `dependentsDigest`: sha256 of the canonical JSON of the dependents.
 * The planner and the reducer both call this, so the two sides cannot hash differently.
 */
export function retentionDependentsDigest(dependents: RetentionDependents): string {
	return canonicalDigest(dependents);
}

/**
 * The turn carry each agent gets from the attempts a prune releases. The attempts of one agent are released as an older
 * prefix (the prefix rule), so `count` grows by the released native attempts, `conversationTurnOrigin` is set once, from
 * the first released attempt that admitted one, and `last` follows the agent's latest native attempt once all are gone.
 */
export function deriveCarry(
	state: TaskRuntimeProjection,
	released: { readonly attemptIds: readonly string[] },
): ReadonlyMap<string, AgentPrunedTurns> {
	const releasedSet = new Set(released.attemptIds);
	const carry = new Map<string, AgentPrunedTurns>();
	for (const [agentId, attemptIds] of nativeAttemptsByAgent(state)) {
		const agent = state.agents[agentId];
		if (!agent) continue;
		const releasedNative = attemptIds.filter((id) => releasedSet.has(id));
		if (releasedNative.length === 0) continue;
		const previous = agent.prunedTurns;
		const firstAdmitted = releasedNative
			.map((id) => state.attempts[id]!)
			.find((attempt) => attempt.admittedTurnOrigin !== undefined)?.admittedTurnOrigin;
		const conversationTurnOrigin = previous?.conversationTurnOrigin ?? firstAdmitted;
		let last = previous?.last;
		if (releasedNative.length === attemptIds.length) {
			const latest = latestAgentAttemptByDurableOrder(state, agentId);
			const task = latest ? state.tasks[latest.taskId] : undefined;
			if (!latest || !task) {
				throw new DurableTaskRuntimeError(`Agent '${agentId}' has no latest attempt to carry.`);
			}
			const ownTurnOrigin = attemptTurnOrigin(latest);
			last = {
				attemptId: latest.attemptId,
				taskId: latest.taskId,
				objectiveId: task.task.objectiveId,
				status: latest.status,
				...(ownTurnOrigin ? { ownTurnOrigin } : {}),
				acceptanceCriterionIds: [...task.task.acceptanceCriterionIds],
				dispatch: latest.dispatch,
			};
		}
		carry.set(agentId, {
			count: (previous?.count ?? 0) + releasedNative.length,
			...(conversationTurnOrigin ? { conversationTurnOrigin } : {}),
			...(last ? { last } : {}),
		});
	}
	return carry;
}

/**
 * The planner's selection: old units with no hold, taken oldest first within the per-list bound, then reduced until no
 * retained record names a member and every agent's released attempts form a prefix. A session plan group is one unit, so
 * its plans leave only with every task they name; a group that a hold or the bound keeps keeps those tasks too. Pure and
 * deterministic.
 */
export function selectRetention(input: RetentionSelectionInput): RetentionSelection {
	const { state } = input;
	const cutoffMs = Date.parse(input.cutoff);
	const units = retentionUnits(state);
	const old = units.filter((unit) => unit.lastActivityMs <= cutoffMs);
	const facts = holdFacts(state);
	const candidates = hasOpaquePlan(state)
		? []
		: old.filter((unit) => projectionHoldOf(state, facts, unit) === undefined && !externallyHeld(unit, input));
	const taken: RetentionUnit[] = [];
	let truncated = false;
	let objectives = 0;
	let tasks = 0;
	let attempts = 0;
	let plans = 0;
	for (const unit of candidates) {
		objectives += unit.kind === "objective" ? 1 : 0;
		tasks += unit.taskIds.length;
		attempts += unit.attemptIds.length;
		plans += unit.planIds.length;
		if (
			objectives > MAX_RETENTION_PRUNE_RECORDS ||
			tasks > MAX_RETENTION_PRUNE_RECORDS ||
			attempts > MAX_RETENTION_PRUNE_RECORDS ||
			plans > MAX_RETENTION_PRUNE_RECORDS
		) {
			truncated = true;
			break;
		}
		taken.push(unit);
	}
	const natives = nativeAttemptsByAgent(state);
	let current = taken;
	for (;;) {
		const referenced = referencedReleasedIds(state, releasedIdsOf(current));
		const removed = new Set<RetentionUnit>();
		for (const unit of current) if (unitIsReferenced(unit, referenced)) removed.add(unit);
		const owner = new Map<string, RetentionUnit>();
		for (const unit of current) for (const attemptId of unit.attemptIds) owner.set(attemptId, unit);
		for (const attemptIds of natives.values()) {
			let sawUnreleased = false;
			for (const attemptId of attemptIds) {
				const unit = owner.get(attemptId);
				if (unit === undefined) sawUnreleased = true;
				else if (sawUnreleased) removed.add(unit);
			}
		}
		if (removed.size === 0) break;
		current = current.filter((unit) => !removed.has(unit));
	}
	const released = releasedIdsOf(current);
	const attemptIds = [...released.attemptIds].sort();
	return {
		objectiveIds: [...released.objectiveIds].sort(),
		taskIds: [...released.taskIds].sort(),
		attemptIds,
		planIds: [...released.planIds].sort(),
		dependents: deriveDependents(state, released),
		carry: deriveCarry(state, { attemptIds }),
		truncated,
		held: old.length - candidates.length + taken.length - current.length,
	};
}

/**
 * The structural checks a `retention.pruned` payload must pass wherever it is applied, replay included. They read the
 * payload against the projection's record shape only: the archive id names the archive digest, the cutoff is not after the
 * event, every listed id exists, each list is closed over the others (a released task's attempts, a released attempt's
 * task, and a released objective's tasks and plans are all listed), the agent turn prefix the carry arithmetic needs holds,
 * and the dependents digest matches what the projection derives. A payload that passes these applies the same way under any
 * later rule set. Frozen for v1: `deriveDependents` defines what a v1 prune deletes, and `deriveCarry` defines the carry it
 * writes, which for each agent's released basis includes that task's acceptance criterion ids (`last.acceptanceCriterionIds`).
 * Replay re-derives the carry, so a change to either derivation must branch on the payload version, or a logged v1 prune
 * would replay to a different state (and a changed `deriveDependents` would fail the logged dependents digest). The archive
 * digest covers the carry as well (`agentCarry`), but replay does not re-verify it.
 */
export function assertRetentionPruneWellFormed(
	state: TaskRuntimeProjection,
	payload: RetentionPrunedPayload,
	occurredAt: string,
): void {
	if (Date.parse(payload.cutoff) > Date.parse(occurredAt)) refuse("the cutoff is after the event");
	if (payload.archiveId !== retentionArchiveId(payload.archiveDigest)) {
		refuse("the archive id does not name the archive digest");
	}
	if (state.retentionArchiveIds?.includes(payload.archiveId)) refuse("the archive is already committed");
	for (const objectiveId of payload.objectiveIds) {
		if (!state.objectives[objectiveId]) refuse(`objective ${objectiveId} is unknown`);
	}
	for (const taskId of payload.taskIds) {
		if (!state.tasks[taskId]) refuse(`task ${taskId} is unknown`);
	}
	for (const attemptId of payload.attemptIds) {
		if (!state.attempts[attemptId]) refuse(`attempt ${attemptId} is unknown`);
	}
	for (const planId of payload.planIds) {
		if (!state.plans[planId]) refuse(`plan ${planId} is unknown`);
	}
	const tasks = new Set(payload.taskIds);
	const attempts = new Set(payload.attemptIds);
	const plans = new Set(payload.planIds);
	for (const taskId of payload.taskIds) {
		for (const attemptId of state.tasks[taskId]!.attemptIds) {
			if (!attempts.has(attemptId)) refuse(`attempt ${attemptId} of task ${taskId} is not released with it`);
		}
	}
	for (const attemptId of payload.attemptIds) {
		const taskId = state.attempts[attemptId]!.taskId;
		if (!tasks.has(taskId)) refuse(`attempt ${attemptId} is released without its task ${taskId}`);
	}
	for (const objectiveId of payload.objectiveIds) {
		for (const taskId of state.objectives[objectiveId]!.taskIds) {
			if (!tasks.has(taskId)) refuse(`task ${taskId} of objective ${objectiveId} is not released with it`);
		}
		for (const [planId, plan] of Object.entries(state.plans)) {
			if (isPlanFromNewerBuild(plan.record) || plan.record.objectiveId !== objectiveId) continue;
			if (!plans.has(planId)) refuse(`plan ${planId} of objective ${objectiveId} is not released with it`);
		}
	}
	const releasedAttempts = new Set(payload.attemptIds);
	for (const attemptIds of nativeAttemptsByAgent(state).values()) {
		let sawRetained = false;
		for (const attemptId of attemptIds) {
			if (!releasedAttempts.has(attemptId)) sawRetained = true;
			else if (sawRetained) refuse("an agent's released turns are not an older prefix");
		}
	}
	if (retentionDependentsDigest(deriveDependents(state, payload)) !== payload.dependentsDigest) {
		refuse("the dependents digest differs from the projection");
	}
}

/**
 * The planner's rules, checked before the prune is appended (runtime `commitRetentionPrune`, on the planned state the ordinal
 * guard proved current). They recompute what the payload must release from the units, and throw when the payload names a
 * unit the planner would not release. Each listed task resolves to its unit (an objective, a finished session task, or a
 * session plan group), so the task, attempt and plan lists must equal the units' members exactly (the exact-membership
 * rule). Holds, references and the age rule are planner-only: replay never re-judges them, because a logged prune is what
 * the planner decided at its time. External holds and the day count are not in the projection, so the cutoff carries the
 * age and the pass checks the external holds before it commits.
 */
export function assertRetentionPruneAllowed(
	state: TaskRuntimeProjection,
	payload: RetentionPrunedPayload,
	occurredAt: string,
): void {
	assertRetentionPruneWellFormed(state, payload, occurredAt);
	const cutoffMs = Date.parse(payload.cutoff);
	if (hasOpaquePlan(state)) refuse("a plan from a newer build hides its references");
	const units = retentionUnits(state);
	const byKey = new Map(units.map((unit) => [unit.key, unit]));
	const unitOfTask = new Map<string, RetentionUnit>();
	const unitOfPlan = new Map<string, RetentionUnit>();
	for (const unit of units) {
		if (unit.kind === "objective") continue;
		for (const taskId of unit.taskIds) unitOfTask.set(taskId, unit);
		for (const planId of unit.planIds) unitOfPlan.set(planId, unit);
	}
	const listedObjectives = new Set(payload.objectiveIds);
	const listed = new Map<string, RetentionUnit>();
	for (const objectiveId of payload.objectiveIds) {
		const unit = byKey.get(`objective:${objectiveId}`);
		if (!unit) refuse(`objective ${objectiveId} is not a closed, non-session objective`);
		if (unit.lastActivityMs > cutoffMs) refuse(`objective ${objectiveId} is newer than the cutoff`);
		listed.set(unit.key, unit);
	}
	const listSessionUnit = (unit: RetentionUnit): void => {
		if (unit.lastActivityMs > cutoffMs) refuse(`${unit.key} is newer than the cutoff`);
		listed.set(unit.key, unit);
	};
	for (const taskId of payload.taskIds) {
		const task = state.tasks[taskId];
		if (!task) refuse(`task ${taskId} is unknown`);
		if (listedObjectives.has(task.task.objectiveId)) continue;
		const unit = unitOfTask.get(taskId);
		if (!unit) refuse(`task ${taskId} is neither in a listed objective nor finished session work`);
		listSessionUnit(unit);
	}
	// A session plan group with no task left to name is listed by its plan alone. A plan of a listed objective is not in
	// `unitOfPlan`, so it is listed with its objective, and the exact-membership check refuses any other plan.
	for (const planId of payload.planIds) {
		const unit = unitOfPlan.get(planId);
		if (unit) listSessionUnit(unit);
	}
	const listedUnits = [...listed.values()];
	const expected = releasedIdsOf(listedUnits);
	if (!sameIds(payload.taskIds, expected.taskIds)) refuse("the task list is not the listed units' tasks");
	if (!sameIds(payload.attemptIds, expected.attemptIds)) refuse("the attempt list is not the listed units' attempts");
	if (!sameIds(payload.planIds, expected.planIds)) refuse("the plan list is not the listed units' plans");
	const facts = holdFacts(state);
	for (const unit of listedUnits) {
		if (projectionHoldOf(state, facts, unit) !== undefined) refuse(`${unit.key} is held`);
	}
	const released = {
		objectiveIds: payload.objectiveIds,
		taskIds: payload.taskIds,
		attemptIds: payload.attemptIds,
		planIds: payload.planIds,
	};
	if (referencedReleasedIds(state, released).size > 0) refuse("retained work depends on a released record");
}

function sameIds(listed: readonly string[], expected: readonly string[]): boolean {
	if (listed.length !== expected.length) return false;
	const set = new Set(listed);
	return set.size === listed.length && expected.every((id) => set.has(id));
}

/**
 * Each closed non-session objective's first projection hold (checks 1-11 and 12), or undefined when none holds. Used by the
 * refusal text. Check 12 treats a record as retained only when it sits outside every closed unit, so a chain of closed
 * units is read as released; the planner's fixpoint is the exact rule.
 */
export function closedObjectiveHolds(state: TaskRuntimeProjection): ReadonlyMap<string, RetentionHold | undefined> {
	const units = retentionUnits(state);
	const facts = holdFacts(state);
	const referenced = referencedReleasedIds(state, releasedIdsOf(units));
	const holds = new Map<string, RetentionHold | undefined>();
	for (const unit of units) {
		if (unit.kind !== "objective") continue;
		const hold =
			projectionHoldOf(state, facts, unit) ?? (unitIsReferenced(unit, referenced) ? "referenced" : undefined);
		holds.set(unit.objectiveId, hold);
	}
	return holds;
}
