/**
 * The plan executor: applies `plan` tool calls and runs every open plan of the session to its end.
 *
 * Event-driven, never polling: it reconciles (`plan-reconcile.ts`) after each orchestration store commit (worker
 * outcomes, lane terminals, its own plan events), each fleet room change, each goal synchronization and each tool
 * call. One drain runs at a time; a commit during a drain marks it dirty and the drain runs again. Work that awaits
 * (preparing a release, the vote judgment, a plan-update delivery) runs beside the drain and asks for a new drain when
 * it ends. A release or action the fleet refused, or that failed, is parked until the room, the goal or the plan
 * changes, so the executor never loops on its own refusals. A read-only step the fleet refused on a linked machine is
 * not parked: the machine is skipped for that release and the step runs here on the next drain.
 *
 * Restart recovery is the same reconcile: every fact it reads is durable (plan events, task outcomes, the parent-input
 * receipts of plan-updates), a release replays through the fleet's idempotency key, and a plan-update's delivery id is
 * the plan, the step and the event's sequence.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { observeMachine, registerMachine } from "../../kernel/machine-spec.ts";
import { SYSTEM_TIMER_PORT, type TimerPort } from "../../kernel/timer-port.ts";
import { orchestrationSessionDir } from "../agent-paths.ts";
import type { WorkerClaim } from "../autonomy/contracts.ts";
import { renderCommsStateLine } from "../comms/comms-records.ts";
import type { WorkerLaneIsolationDeps } from "../delegation/worker-lane-isolation.ts";
import type { Outcome } from "../delegation/worker-outcome-contract.ts";
import { PLAN_VERIFIER_UNAVAILABLE } from "../delegation/worker-profile-resolver.ts";
import type { FleetDispatch, FleetScheduler, RoomQuery } from "../fleet/fleet-types.ts";
import { weightOf } from "../fleet/local-admit.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { withSessionBundleAdmission } from "../orchestration/session-bundle-lifecycle.ts";
import type { DurableTaskRuntime, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { currentTaskOf } from "../orchestration/task-successor.ts";
import { goalObjectiveId } from "../orchestration/work-state-projection.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import type { ParentInputDelivery } from "../parent-input-delivery.ts";
import type { Placement } from "../placement/placement-types.ts";
import type { ProofStakesLevel } from "../proof/stakes-levels.ts";
import { workerResultStakes } from "../proof/worker-proof-sheet.ts";
import type { OperationEffectEngine } from "../system-one/operation-classifier.ts";
import { judgeVoteStep } from "../system-one/plan-vote-rubric.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	decideCodeJoin,
	JOIN_RESULT_MAX_BYTES,
	type JoinIdentity,
	type JoinResult,
	joinArtifactPath,
	joinOutcomeId,
	mergeResult,
	settleVote,
	workerJoinResult,
} from "./joins.ts";
import { acceptPlanCall } from "./plan-acceptance.ts";
import { buildPlanDispatch, decidePlacement, planReleaseKey } from "./plan-dispatch.ts";
import type { PlanCallContext, PlanExecutorPort, PlanToolInput, PlanToolResult } from "./plan-executor-port.ts";
import { PlanFingerprint, sameVisibleView } from "./plan-fingerprint.ts";
import {
	checkPlanFacts,
	derivePlanId,
	isPlanFromNewerBuild,
	PLAN_LIMITS,
	type PlanCloseStatus,
	type PlanNodeSpec,
	type PlanNodeState,
	type PlanRecord,
	type PlanRuntimeState,
	planCriticalPath,
} from "./plan-graph.ts";
import {
	MergeLandings,
	type MergeStep,
	mergeLanes,
	mergeWorkerNodes,
	WORKTREE_UNAVAILABLE,
	worktreeUnavailableWords,
} from "./plan-merge.ts";
import { PLAN_NODE_MACHINE } from "./plan-node-machine.ts";
import { placementFor } from "./plan-placement.ts";
import { type PlanAction, type PlanUpdateIntent, reconcilePlans } from "./plan-reconcile.ts";
import { planNodeOfTask } from "./plan-reducer.ts";
import { PlanResultGates } from "./plan-result-gates.ts";
import { placeHereNodes, resolveSince, verifyWrapNodes, voteCheckNodes } from "./plan-revision.ts";
import { planUpdateDelivery, planUpdateDeliveryId } from "./plan-update.ts";
import { activeRootPlan, type PlanView, planNodeBrief, planNodeOutcome, planView } from "./plan-view.ts";

/** Reconcile passes one drain may run before it yields to the next event. */
const MAX_DRAIN_PASSES = 16;
const NO_MACHINES: ReadonlySet<string> = new Set();

type PlanFleet = Pick<
	FleetScheduler,
	| "prepare"
	| "admit"
	| "cancel"
	| "room"
	| "subscribeRoom"
	| "releasePrepared"
	| "placementCandidates"
	| "boundMachine"
	| "hasRemoteBackend"
	| "subscribeCandidates"
>;

export interface PlanExecutorDeps {
	readonly runtime: () => DurableTaskRuntime;
	/** Fires after every orchestration store commit. */
	readonly subscribeStore: (listener: () => void) => () => void;
	readonly fleet: () => PlanFleet;
	readonly engine: () => OperationEffectEngine | undefined;
	readonly goal: () => GoalState | undefined;
	readonly sessionId: () => string;
	readonly agentDir: () => string;
	/** The root's session branch, root to leaf (the J4 excerpt and the request a plan answers). */
	readonly rootEntries: () => readonly unknown[];
	readonly captureOrigin: () => WorkerReceiptOrigin;
	/**
	 * The host's claim of one worker attempt (its receipts, changed files and findings), as the session holds it when the
	 * step settles. Undefined when the attempt left no claim; the step's stakes then read from its outcome alone.
	 */
	readonly workerClaim: (taskId: string, attemptId: string) => WorkerClaim | undefined;
	readonly deliver: (delivery: ParentInputDelivery, signal: AbortSignal) => Promise<unknown>;
	readonly isDelivered: (deliveryId: string) => boolean;
	/** Acknowledges routed terminal notifications the plan consumed. */
	readonly acknowledge: (notificationIds: readonly string[]) => void;
	/** Retires a worker a closed plan made for one of its steps; the retirement also frees its worktree lane when it had one. */
	readonly retireWorker: (agentId: string) => void;
	/** Fires when a plan's visible state changes (a step starts, settles or is held, a plan opens or closes). */
	readonly planChanged: () => void;
	readonly timers?: () => TimerPort;
	readonly lanes?: () => WorkerLaneIsolationDeps;
	readonly landGate?: () => { readonly gate: "on" | "off"; readonly gateCommand?: string };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The `stakes` field of a settlement record, present only when a level was read for the step. */
function optionalStakes(stakes: ProofStakesLevel | undefined): { stakes?: ProofStakesLevel } {
	return stakes !== undefined ? { stakes } : {};
}

function queryKey(query: RoomQuery): string {
	return `${query.objectiveId}|${query.weight}`;
}

/** The release keys of every step that still waits for its release in an open plan of the snapshot. */
function waitingReleaseKeys(snapshot: TaskRuntimeProjection): ReadonlySet<string> {
	const waiting = new Set<string>();
	for (const [planId, plan] of Object.entries(snapshot.plans))
		if (!plan.closed)
			for (const [nodeId, node] of Object.entries(plan.nodes))
				if (!node.release) waiting.add(planReleaseKey(planId, nodeId, node.since));
	return waiting;
}

/** A join result file the executor wrote; anything else, a partial record included, reads as absent. */
function readJoinResult(path: string): JoinResult | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isJoinResult(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Every field the combined update and its proof sheet read: a record missing one of them is not a join result. */
function isJoinResult(value: unknown): value is JoinResult {
	if (!isPlainRecord(value) || value.v !== 1) return false;
	if (typeof value.kind !== "string" || typeof value.artifact !== "string") return false;
	if (value.winner !== undefined && typeof value.winner !== "string") return false;
	const outcome = value.outcome;
	if (!isPlainRecord(outcome) || typeof outcome.status !== "string") return false;
	if (!isPlainRecord(outcome.cost) || typeof outcome.cost.usd !== "number") return false;
	const members = value.members;
	if (
		!Array.isArray(members) ||
		!members.every(
			(member: unknown) =>
				isPlainRecord(member) &&
				typeof member.nodeId === "string" &&
				typeof member.status === "string" &&
				typeof member.outcomeId === "string",
		)
	)
		return false;
	const coverage = value.coverage;
	if (!isPlainRecord(coverage) || !Object.values(coverage).every((met) => typeof met === "boolean")) return false;
	const conflicts = value.conflicts;
	if (
		!Array.isArray(conflicts) ||
		!conflicts.every(
			(conflict: unknown) =>
				isPlainRecord(conflict) &&
				(conflict.kind === "finding" || conflict.kind === "file") &&
				isStringArray(conflict.between) &&
				typeof conflict.detail === "string",
		)
	)
		return false;
	return isStringArray(value.changedFiles) && isStringArray(value.gaps);
}

/** The skip-reason prefix of a worker start that threw while it was being made (`worker-start-phases.ts`). */
const WORKER_START_ERROR = "worker_start_error:";

const STATE_WORDS: Readonly<Record<PlanNodeState, string>> = {
	planned: "waits for earlier steps",
	ready: "ready",
	admitted: "started (queued)",
	running: "running",
	settled: "done",
	held: "held",
	superseded: "replaced",
	cancelled: "stopped",
};

export class PlanExecutor implements PlanExecutorPort {
	private readonly deps: PlanExecutorDeps;
	private readonly abort = new AbortController();
	/** Refused or failed release and action keys, with the room query a release waits on. */
	private readonly parked = new Map<string, string | undefined>();
	private readonly releasing = new Map<string, { readonly run: Promise<void>; readonly query: string }>();
	private readonly choosing = new Set<string>();
	private readonly delivering = new Set<string>();
	private readonly roomQueries = new Map<string, RoomQuery>();
	private readonly roomSubscriptions = new Map<string, () => void>();
	/** The room queries the last pass found waiting on local room: a machine that becomes a candidate wakes them. */
	private waitingRoomKeys: ReadonlySet<string> = new Set();
	private unsubscribeCandidates: (() => void) | undefined;
	/** Linked machines a release's remote placement was refused by, per release key: never offered again for that release. */
	private readonly remoteRefused = new Map<string, Set<string>>();
	/** Release keys a temporary remote refusal parked, with the machine the offer stays prepared for: retried when candidates change. */
	private readonly remoteParked = new Map<string, string>();
	/**
	 * Release keys whose refused or failed start may still hold the offer it prepared (a local allocation or a remote offer).
	 * `parked` cannot hold them: the drain clears it, so a revision would lose them before the release sweep. Kept until the
	 * step is released or stops waiting, when `releaseStale` gives the offer back.
	 */
	private readonly offerKeys = new Set<string>();
	/** This executor's shadow of every plan step's state; listed in the session's status view while the executor lives. */
	private readonly nodeMachine = observeMachine(PLAN_NODE_MACHINE, { entities: true });
	private readonly unregisterMachine: () => void;
	/** Which plans' inputs moved since the last observation, by reference. */
	private readonly fingerprint = new PlanFingerprint();
	/** The R3 gates on settled results: a dependent or reduce step waits on its review (`plan-result-gates.ts`). */
	private readonly resultGates = new PlanResultGates({
		engine: () => this.deps.engine(),
		signal: this.abort.signal,
		hold: (planId, nodeId, since, detail) => this.holdStep(planId, nodeId, since, detail),
		drain: () => this.requestDrain(),
	});
	private readonly merges: MergeLandings;
	/** A step's claim report, the source of its open items: the host's claim of that attempt. */
	private readonly reportOf = (taskId: string, attemptId: string | undefined) =>
		attemptId === undefined ? undefined : this.deps.workerClaim(taskId, attemptId)?.report;
	/** The plan views at the last observed snapshot; a view that differs from the one here is a visible change. */
	private readonly visibleViews = new Map<string, PlanView>();
	private unsubscribeStore: (() => void) | undefined;
	private lastSnapshot: TaskRuntimeProjection | undefined;
	private draining = false;
	private dirty = false;
	private disposed = false;

	constructor(deps: PlanExecutorDeps) {
		this.deps = deps;
		this.merges = new MergeLandings(deps, () => this.requestDrain());
		this.unregisterMachine = registerMachine(this.nodeMachine, deps.sessionId());
	}

	/** Subscribes to the store and runs the startup reconcile (restart recovery). */
	start(): void {
		if (this.unsubscribeStore || this.disposed) return;
		this.unsubscribeStore = this.deps.subscribeStore(() => this.requestDrain());
		this.requestDrain();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.abort.abort();
		this.unsubscribeStore?.();
		this.unsubscribeCandidates?.();
		this.unsubscribeCandidates = undefined;
		for (const unsubscribe of this.roomSubscriptions.values()) unsubscribe();
		this.roomSubscriptions.clear();
		this.merges.dispose();
		this.unregisterMachine();
	}

	/** The goal changed: parked work may be allowed now, and the goal's requirements are re-read. */
	noteGoalChanged(): void {
		this.parked.clear();
		this.requestDrain();
	}

	/** The terminal route's predicate: the task runs (or ran) a step of a retained plan. */
	ownsTask(taskId: string): boolean {
		return planNodeOfTask(this.deps.runtime().getSnapshot(), taskId) !== undefined;
	}

	async applyToolCall(input: PlanToolInput, context: PlanCallContext): Promise<PlanToolResult> {
		if (this.disposed) return { ok: false, text: "Plans are unavailable: the session is closing." };
		const runtime = this.deps.runtime();
		const snapshot = runtime.getSnapshot();
		const active = activeRootPlan(snapshot);
		const nowIso = new Date(this.now()).toISOString();
		if (input.action === "cancel") {
			if (!active) return { ok: false, text: "No plan is running." };
			this.closePlan(
				active.planId,
				"cancelled",
				input.reason?.trim().slice(0, PLAN_LIMITS.reasonChars) || "cancelled by the planner",
			);
			harnessLog.info("plan", "a plan is cancelled", { planId: active.planId });
			await this.releaseNow();
			return this.result(active.planId, ["PLAN_UPDATE"], ["The plan is cancelled; its running steps are stopped."]);
		}
		if (input.action === "start" && active) {
			return {
				ok: false,
				text: `A plan is already running ("${active.title}", ${active.planId}). Revise it or cancel it first.`,
			};
		}
		if (input.action === "revise" && !active) return { ok: false, text: "No plan is running; start one." };
		const planId =
			active && input.action === "revise" ? active.planId : derivePlanId(this.deps.sessionId(), context.toolCallId);
		if (input.action === "start" && snapshot.plans[planId]) {
			return this.result(planId, ["PLAN_STARTED"], ["This plan call was already applied."]);
		}
		const plan = snapshot.plans[planId];
		const current = plan && !isPlanFromNewerBuild(plan.record) ? { record: plan.record, runtime: plan } : undefined;
		const goal = this.deps.goal();
		const accepted = await acceptPlanCall(input, {
			planId,
			objectiveId: goal ? goalObjectiveId(goal.goalId) : `session:${this.deps.sessionId()}`,
			goal,
			...(current ? { current } : {}),
			headroom: runtime.getProjectionCapacity().headroom,
			engine: this.deps.engine(),
			entries: this.deps.rootEntries(),
			now: nowIso,
			...(context.signal ? { signal: context.signal } : {}),
		});
		if (!accepted.ok) {
			harnessLog.info("plan", "a plan call is refused", {
				action: input.action,
				problems: accepted.problems.length,
			});
			const verb = input.action === "start" ? "started" : "revised";
			return {
				ok: false,
				text: [`The plan was not ${verb}. Fix:`, ...accepted.problems.map((line) => `- ${line}`)].join("\n"),
			};
		}
		runtime.recordPlan(accepted.record);
		harnessLog.info("plan", input.action === "start" ? "a plan is recorded" : "a plan is revised", {
			planId,
			version: accepted.record.version,
			steps: accepted.record.nodes.length,
			unjudged: accepted.record.unjudged,
		});
		await this.releaseNow();
		return this.result(planId, [input.action === "start" ? "PLAN_STARTED" : "PLAN_UPDATE"], accepted.notes);
	}

	private now(): number {
		return (this.deps.timers?.() ?? SYSTEM_TIMER_PORT).now();
	}

	/**
	 * Closes a plan. Its running steps stop through their own cancels (the reconcile); a prepared step that was never
	 * admitted is released here, by the plan's scope, since nothing else would release it.
	 */
	private closePlan(planId: string, status: PlanCloseStatus, reason: string): void {
		this.deps.runtime().closePlan({ planId, status, reason });
		this.resultGates.forgetPlan(planId);
		this.merges.forgetPlan(planId);
		this.deps.fleet().cancel({ kind: "plan", planId }, "plan_closed");
	}

	/**
	 * Holds a step for re-planning in plain words, only on the spec version the caller read and while the step still waits: a
	 * step revised, released or held since is left as it is.
	 */
	private holdStep(planId: string, nodeId: string, since: number, detail: string): void {
		const plan = this.deps.runtime().getSnapshot().plans[planId];
		const runtime = plan?.nodes[nodeId];
		if (!plan || plan.closed || !runtime || runtime.since !== since || runtime.release || runtime.held) return;
		this.deps.runtime().holdPlanNode({ planId, nodeId, reason: "replan", detail, generation: since });
		harnessLog.info("plan", "a plan step waits for re-planning", { planId, nodeId });
	}

	/** Runs a drain now (parked work included) and waits for the releases it started. */
	private async releaseNow(): Promise<void> {
		this.parked.clear();
		this.requestDrain();
		await Promise.resolve();
		await Promise.allSettled([...this.releasing.values()].map((entry) => entry.run));
	}

	private result(
		planId: string,
		codes: Parameters<typeof renderCommsStateLine>[0],
		notes: readonly string[],
	): PlanToolResult {
		const view = planView(this.deps.runtime().getSnapshot(), planId);
		if (!view) return { ok: false, text: "The plan is no longer retained." };
		const started = view.nodes.filter((node) => node.state === "admitted" || node.state === "running").length;
		const waiting = view.nodes.filter((node) => node.state === "planned" || node.state === "ready").length;
		const codeLine = renderCommsStateLine(codes);
		const lines = [
			...(codeLine ? [codeLine] : []),
			`Plan ${view.planId} "${view.title}" version ${view.version}: ${started} started, ${waiting} waiting.`,
			...view.nodes.map(
				(node) =>
					`- ${node.id} (${node.kind}): ${STATE_WORDS[node.state]}: ${node.intent.replace(/\s+/g, " ").slice(0, 160)}`,
			),
			...(view.rootOwned.length > 0 ? [`Requirements no step proves (yours): ${view.rootOwned.join(", ")}.`] : []),
			...notes,
			"You are woken once per combined result and when a step needs you; keep working meanwhile.",
		];
		return { ok: true, text: lines.join("\n"), planId, version: view.version, started, waiting };
	}

	// ---- the drain ----

	private requestDrain(): void {
		this.dirty = true;
		if (this.draining || this.disposed) return;
		this.draining = true;
		queueMicrotask(() => this.drain());
	}

	private drain(): void {
		let passes = 0;
		try {
			while (this.dirty && !this.disposed && passes < MAX_DRAIN_PASSES) {
				this.dirty = false;
				passes += 1;
				this.pass();
			}
			if (this.dirty && passes >= MAX_DRAIN_PASSES)
				harnessLog.warn("plan", "a plan drain reached its pass bound; the next event resumes it", { passes });
		} catch (error) {
			harnessLog.warn("plan", "a plan drain failed", { error: errorText(error) });
		} finally {
			this.draining = false;
		}
	}

	/**
	 * Gives back the prepared offer of each release key that no longer waits: a revised or removed step, a closed plan, or a
	 * step released since its refusal. A key that stops waiting is forgotten with its offer. `waiting` holds the keys the
	 * pass's snapshot still waits on; releasing an offer that was already consumed is a no-op.
	 */
	private releaseStale(waiting: ReadonlySet<string>): void {
		const fleet = this.deps.fleet();
		const held = new Set([...this.offerKeys, ...this.remoteParked.keys(), ...this.remoteRefused.keys()]);
		for (const key of held) {
			if (waiting.has(key)) continue;
			fleet.releasePrepared(key);
			this.offerKeys.delete(key);
			this.remoteParked.delete(key);
			this.remoteRefused.delete(key);
		}
	}

	private pass(): void {
		const runtime = this.deps.runtime();
		const snapshot = runtime.getSnapshot();
		if (this.offerKeys.size + this.remoteParked.size + this.remoteRefused.size > 0)
			this.releaseStale(waitingReleaseKeys(snapshot));
		if (Object.keys(snapshot.plans).length === 0) {
			// A plan the snapshot dropped must still leave the panel, even when no plan is left to reconcile.
			this.observe(snapshot);
			return;
		}
		this.resultGates.refresh(snapshot, this.reportOf);
		const result = reconcilePlans(snapshot, this.deps.goal());
		const room = new Map<string, number>();
		const waiting = new Set<string>();
		for (const action of result.actions) {
			const key = this.actionKey(action);
			if (this.parked.has(key)) continue;
			try {
				if (action.kind === "release") this.release(action, snapshot, room, waiting);
				else this.apply(action);
			} catch (error) {
				this.parked.set(key, undefined);
				harnessLog.warn("plan", "a plan action failed and waits for the next change", {
					action: action.kind,
					planId: action.planId,
					error: errorText(error),
				});
			}
		}
		if (result.acknowledge.length > 0) this.deps.acknowledge(result.acknowledge);
		this.deliverUpdates(result.updates);
		this.syncRoomSubscriptions(waiting);
		this.observe(runtime.getSnapshot());
	}

	private actionKey(action: PlanAction): string {
		switch (action.kind) {
			case "cancel_task":
				return `cancel:${action.taskId}`;
			case "close":
				return `close:${action.planId}`;
			case "retire_worker":
				return `retire:${action.agentId}`;
			case "release": {
				const plan = this.deps.runtime().getSnapshot().plans[action.planId];
				const since = plan?.nodes[action.nodeId]?.since ?? 0;
				return planReleaseKey(action.planId, action.nodeId, since);
			}
			default:
				return `${action.kind}:${action.planId}:${action.nodeId}`;
		}
	}

	private planOf(planId: string): { snapshot: TaskRuntimeProjection; plan: PlanRuntimeState; record: PlanRecord } {
		const snapshot = this.deps.runtime().getSnapshot();
		const plan = snapshot.plans[planId];
		if (!plan || isPlanFromNewerBuild(plan.record)) throw new Error(`plan ${planId} is not runnable`);
		return { snapshot, plan, record: plan.record };
	}

	private nodeOf(record: PlanRecord, nodeId: string): PlanNodeSpec {
		const node = record.nodes.find((entry) => entry.id === nodeId);
		if (!node) throw new Error(`plan ${record.planId} has no step ${nodeId}`);
		return node;
	}

	private apply(action: Exclude<PlanAction, { kind: "release" }>): void {
		const runtime = this.deps.runtime();
		switch (action.kind) {
			case "settle": {
				const { snapshot, plan } = this.planOf(action.planId);
				runtime.settlePlanNode({
					planId: action.planId,
					nodeId: action.nodeId,
					outcomeId: action.outcomeId,
					generation: action.generation,
					...optionalStakes(this.stakesOfStep(snapshot, plan, action.nodeId, action.outcome)),
				});
				harnessLog.info("plan", "a plan step is settled", { planId: action.planId, nodeId: action.nodeId });
				return;
			}
			case "hold":
				runtime.holdPlanNode({
					planId: action.planId,
					nodeId: action.nodeId,
					reason: action.reason,
					detail: action.detail,
					generation: action.generation,
				});
				harnessLog.info("plan", "a plan step is held", {
					planId: action.planId,
					nodeId: action.nodeId,
					reason: action.reason,
				});
				return;
			case "close":
				this.closePlan(action.planId, action.status, action.reason);
				harnessLog.info("plan", "a plan is closed", {
					planId: action.planId,
					status: action.status,
					reason: action.reason,
				});
				return;
			case "cancel_task":
				this.cancelTask(action.taskId, action.reason);
				return;
			case "retire_worker":
				this.deps.retireWorker(action.agentId);
				harnessLog.info("plan", "a closed plan's worker is retired", { planId: action.planId });
				return;
			case "code_join":
				this.decideJoin(action.planId, action.nodeId);
				return;
			case "worker_join": {
				const { snapshot, plan, record } = this.planOf(action.planId);
				const node = this.nodeOf(record, action.nodeId);
				const identity = this.joinIdentity(plan, action.planId, action.nodeId);
				this.settleJoin(
					action.planId,
					action.nodeId,
					workerJoinResult(
						snapshot,
						plan,
						record,
						node,
						action.outcome,
						identity,
						this.stakesOfStep(snapshot, plan, action.nodeId, action.outcome),
						this.resultGates.findingsOf(action.planId, action.nodeId),
					),
				);
				return;
			}
			case "verify_wrap":
				if (!action.settled) {
					const { snapshot, plan } = this.planOf(action.planId);
					const { outcomeId, generation } = action.outcome;
					const stakes = this.stakesOfStep(snapshot, plan, action.nodeId, action.outcome);
					runtime.settlePlanNode({
						planId: action.planId,
						nodeId: action.nodeId,
						outcomeId,
						generation,
						...optionalStakes(stakes),
					});
				}
				this.hostRevision(
					action.planId,
					action.nodeId,
					action.outcome.generation,
					"an independent check",
					(record, version) => verifyWrapNodes(record, action.nodeId, action.requirementIds, version),
				);
				return;
			case "replace":
				this.hostRevision(
					action.planId,
					action.nodeId,
					action.outcome.generation,
					"a re-placement on this machine",
					(record, version) => placeHereNodes(record, action.nodeId, version),
				);
				return;
		}
	}

	/** Stops a task the plan no longer runs: through its lane when an attempt is live, else in the store. */
	private cancelTask(taskId: string, reason: string): void {
		const snapshot = this.deps.runtime().getSnapshot();
		const task = snapshot.tasks[taskId];
		if (!task) return;
		const attemptId = task.attemptIds[task.attemptIds.length - 1];
		const status = attemptId ? snapshot.attempts[attemptId]?.status : undefined;
		const live =
			status !== undefined &&
			!["completed", "partial", "blocked", "failed", "cancelled", "expired"].includes(status);
		if (live) {
			this.deps.fleet().cancel({ kind: "lane", laneId: taskId }, reason);
			// The lane's terminal arrives as a store commit; until then the same cancel is not repeated.
			this.parked.set(`cancel:${taskId}`, undefined);
		} else this.deps.runtime().cancelTask(taskId, reason);
		harnessLog.info("plan", "a plan task is stopped", { taskId, reason, live });
	}

	/**
	 * A host revision (verify wrap, re-placement): version+1 with the new nodes; a version the facts refuse holds the step
	 * for the root's revise instead.
	 */
	private hostRevision(
		planId: string,
		nodeId: string,
		generation: number,
		what: string,
		build: (record: PlanRecord, version: number) => { nodes: PlanNodeSpec[]; final: string } | undefined,
	): void {
		const runtime = this.deps.runtime();
		const { plan, record } = this.planOf(planId);
		const version = record.version + 1;
		const built = build(record, version);
		const nodes = built ? resolveSince(record, plan, built.nodes, version, false) : undefined;
		const cited = [...new Set((nodes ?? []).flatMap((node) => node.requirementIds))];
		const facts =
			built && nodes
				? checkPlanFacts(record.title, nodes, built.final, {
						version,
						requirementIds: cited,
						openRequirementIds: [],
						headroom: runtime.getProjectionCapacity().headroom,
						releasedTasks: Object.values(plan.nodes).filter((entry) => entry.release).length,
						maxScopeChars: PLAN_LIMITS.scopeChars,
					})
				: undefined;
		if (!built || !facts?.ok) {
			const detail = `step ${nodeId} needs ${what}, and the plan has no room for it; revise the plan`;
			runtime.holdPlanNode({ planId, nodeId, reason: "replan", detail, generation });
			harnessLog.info("plan", "a host revision does not fit; the step is held", { planId, nodeId, what });
			return;
		}
		runtime.recordPlan({
			...record,
			version,
			nodes: facts.nodes,
			final: built.final,
			revisedAt: new Date(this.now()).toISOString(),
		});
		harnessLog.info("plan", "a plan is revised by the host", { planId, nodeId, what, version });
	}

	private joinIdentity(plan: PlanRuntimeState, planId: string, nodeId: string): JoinIdentity {
		const n = (plan.nodes[nodeId]?.join?.n ?? 0) + 1;
		const relative = joinArtifactPath(planId, nodeId, n);
		const absolute = join(orchestrationSessionDir(this.deps.agentDir(), this.deps.sessionId()), relative);
		return {
			outcomeId: joinOutcomeId(planId, nodeId, n),
			generation: n,
			recordedAt: new Date(this.now()).toISOString(),
			artifact: absolute.length <= PLAN_LIMITS.artifactChars ? absolute : relative,
		};
	}

	/** Rule 4: a code join's decision; a vote with accepted candidates is judged on its rubric first (S6). */
	private decideJoin(planId: string, nodeId: string): void {
		const { snapshot, plan, record } = this.planOf(planId);
		const node = this.nodeOf(record, nodeId);
		const identity = this.joinIdentity(plan, planId, nodeId);
		const decision = decideCodeJoin(snapshot, plan, record, node, identity);
		if (decision.kind === "wait") return;
		if (decision.kind === "merge") {
			this.landMerge(planId, nodeId, node.since);
			return;
		}
		if (decision.kind === "settle") {
			this.settleJoin(planId, nodeId, decision.result);
			for (const member of decision.cancel) {
				const release = plan.nodes[member]?.release;
				const taskId = release ? currentTaskOf(snapshot, release.taskId) : undefined;
				if (taskId && !plan.nodes[member]?.settled) this.cancelTask(taskId, "plan_join_settled");
			}
			return;
		}
		const key = `${planId}:${nodeId}:${node.since}`;
		if (this.choosing.has(key)) return;
		this.choosing.add(key);
		void this.judgeVote(planId, nodeId, node.since, decision.candidates)
			.catch((error: unknown) => {
				if (!this.abort.signal.aborted)
					harnessLog.warn("plan", "a vote could not settle", { planId, nodeId, error: errorText(error) });
			})
			.finally(() => {
				this.choosing.delete(key);
				this.requestDrain();
			});
	}

	/**
	 * S6: the vote's candidates are judged on its criteria and the exit they reach acts (`plan-vote-rubric.ts`). The plan is
	 * re-read after the judgment: a vote that moved on in the meantime is left as it is.
	 */
	private async judgeVote(
		planId: string,
		nodeId: string,
		since: number,
		candidates: readonly { readonly nodeId: string; readonly outcome: Outcome }[],
	): Promise<void> {
		const { snapshot, plan, record } = this.planOf(planId);
		const { step } = await judgeVoteStep(this.deps.engine(), {
			snapshot,
			plan,
			record,
			vote: this.nodeOf(record, nodeId),
			candidates,
			reportOf: this.reportOf,
			signal: this.abort.signal,
		});
		const current = this.planOf(planId);
		const runtime = current.plan.nodes[nodeId];
		if (!runtime || runtime.join || runtime.since !== since || current.plan.closed) return;
		if (step.kind === "hold") {
			this.apply({ kind: "hold", planId, nodeId, reason: "replan", detail: step.detail, generation: since });
			return;
		}
		if (step.kind === "auto_verify") {
			const { top } = step;
			this.hostRevision(planId, nodeId, since, "an independent check", (fresh, version) => {
				const built = voteCheckNodes(fresh, nodeId, top, version);
				return built && { nodes: built.nodes, final: fresh.final };
			});
			return;
		}
		const winner = step.kind === "winner" ? step.memberId : undefined;
		const identity = this.joinIdentity(current.plan, planId, nodeId);
		const node = this.nodeOf(current.record, nodeId);
		this.settleJoin(
			planId,
			nodeId,
			settleVote(current.snapshot, current.plan, current.record, node, identity, winner),
		);
	}

	/** S7: lands a merge join's lanes in order, off the drain (`plan-merge.ts`). */
	private landMerge(planId: string, nodeId: string, since: number): void {
		const { snapshot, plan, record } = this.planOf(planId);
		const lanes = mergeLanes(snapshot, plan, record, this.nodeOf(record, nodeId));
		this.merges.start(planId, nodeId, lanes, (step) => this.actOnMerge(planId, nodeId, since, step));
	}

	/** Applies a landing's step to its merge join: settle, wait for a retry, add the merge worker, or hold with its words. */
	private actOnMerge(planId: string, nodeId: string, since: number, step: MergeStep): void {
		const { snapshot, plan, record } = this.planOf(planId);
		if (plan.closed || plan.nodes[nodeId]?.join) return;
		if (step.kind === "hold") this.holdStep(planId, nodeId, since, step.detail);
		else if (step.kind === "retry") this.merges.retry(planId, nodeId, step.afterMs);
		else if (step.kind === "merge_worker")
			this.hostRevision(planId, nodeId, since, "a merge worker", (fresh, version) =>
				mergeWorkerNodes(fresh, nodeId, step, version),
			);
		else {
			const identity = this.joinIdentity(plan, planId, nodeId);
			this.settleJoin(planId, nodeId, mergeResult(snapshot, plan, record, this.nodeOf(record, nodeId), identity));
		}
	}

	/**
	 * The stakes a released step's settled outcome reads: the host's claim of that attempt (receipts, changed files, findings)
	 * and the outcome. Read here, when the step settles, and recorded on the step, so the plan's sheet never reads the branch.
	 * A reading that fails is logged and the step settles without a level, as a proof sheet that cannot be built does: stakes
	 * inform and never hold a step.
	 */
	private stakesOfStep(
		snapshot: TaskRuntimeProjection,
		plan: PlanRuntimeState,
		nodeId: string,
		outcome: Outcome,
	): ProofStakesLevel | undefined {
		try {
			const release = plan.nodes[nodeId]?.release;
			const taskId = release ? currentTaskOf(snapshot, release.taskId) : undefined;
			const attemptId = outcome.attempts.at(-1)?.attemptId;
			const claim =
				taskId !== undefined && attemptId !== undefined ? this.deps.workerClaim(taskId, attemptId) : undefined;
			return workerResultStakes({ claim, outcome }).level;
		} catch (error) {
			harnessLog.warn("proof", "a plan step's stakes could not be read; the step settles without a level", {
				nodeId,
				error: errorText(error),
			});
			return undefined;
		}
	}

	/** Writes the join's full result, then records the settlement. A failed write is logged; the plan still moves. */
	private settleJoin(planId: string, nodeId: string, result: JoinResult): void {
		const bounded = (value: JoinResult): string => JSON.stringify(value);
		let text = bounded(result);
		if (Buffer.byteLength(text, "utf8") > JOIN_RESULT_MAX_BYTES) {
			text = bounded({ ...result, changedFiles: result.changedFiles.slice(0, 64), gaps: result.gaps.slice(0, 32) });
		}
		const path = result.artifact;
		if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
			try {
				withSessionBundleAdmission(this.deps.agentDir(), this.deps.sessionId(), () => {
					mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
					writeFileAtomicSync(path, text, { mode: 0o600 });
				});
			} catch (error) {
				harnessLog.warn("plan", "a join result could not be written", { planId, nodeId, error: errorText(error) });
			}
		}
		this.deps.runtime().settlePlanJoin({
			planId,
			nodeId,
			outcome: result.outcome,
			artifact: path,
			...(result.stakes !== undefined ? { stakes: result.stakes } : {}),
		});
		harnessLog.info("plan", "a plan join is settled", {
			planId,
			nodeId,
			status: result.outcome.status,
			members: result.members.length,
		});
	}

	// ---- releases ----

	/**
	 * Rule 5: one release through the fleet. A read-only step may go to a linked machine (`plan-placement.ts`); otherwise it
	 * starts here, within the room's ready window.
	 */
	private release(
		action: Extract<PlanAction, { kind: "release" }>,
		snapshot: TaskRuntimeProjection,
		room: Map<string, number>,
		waiting: Set<string>,
	): void {
		const plan = snapshot.plans[action.planId];
		if (!plan || isPlanFromNewerBuild(plan.record)) return;
		const record = plan.record;
		const node = this.nodeOf(record, action.nodeId);
		const key = planReleaseKey(record.planId, node.id, node.since);
		if (this.releasing.has(key) || this.resultGates.waiting(record.planId, node.id)) return;
		const dispatch = buildPlanDispatch(snapshot, plan, record, node, planCriticalPath(record), {
			reportOf: this.reportOf,
			conflictingFindings: this.resultGates.findingsRead(record.planId, node.id, "conflict"),
			openFindings: this.resultGates.findingsRead(record.planId, node.id, "open"),
		});
		if (node.kind === "verify" && dispatch.verification === undefined) {
			this.holdStep(record.planId, node.id, node.since, "this verify step has no finished step to check");
			return;
		}
		const query: RoomQuery = {
			objectiveId: record.objectiveId,
			weight: weightOf(dispatch.demand, dispatch.writeScope),
		};
		const roomKey = queryKey(query);
		this.roomQueries.set(roomKey, query);
		const fleet = this.deps.fleet();
		const candidates = fleet.placementCandidates();
		const chosen = placementFor(node, decidePlacement(node), {
			localRunnable: candidates.length > 0 ? fleet.room(query).runnableNow : 0,
			candidates,
			refused: this.remoteRefused.get(key) ?? NO_MACHINES,
			remoteBackend: fleet.hasRemoteBackend(),
			boundMachine: fleet.boundMachine(dispatch.idempotencyKey),
		});
		// An offer a temporary refusal left prepared is kept only for the machine it was prepared for.
		const parkedOn = this.remoteParked.get(key);
		if (parkedOn !== undefined) {
			this.remoteParked.delete(key);
			if (chosen.placement.kind !== "remote_machine" || chosen.placement.machineId !== parkedOn)
				fleet.releasePrepared(key);
		}
		// A remote placement was checked against the candidates' room; only a local start waits on the ready window.
		if (chosen.placement.kind !== "remote_machine") {
			if (!room.has(roomKey)) {
				const inFlight = [...this.releasing.values()].filter((entry) => entry.query === roomKey).length;
				room.set(roomKey, fleet.room(query).readyWindowFree - inFlight);
			}
			const free = room.get(roomKey) ?? 0;
			if (free <= 0) {
				waiting.add(roomKey);
				return;
			}
			room.set(roomKey, free - 1);
		}
		const run = this.admit(
			record.planId,
			node.id,
			node.since,
			dispatch,
			chosen.placement,
			chosen.exit,
			roomKey,
		).finally(() => {
			this.releasing.delete(key);
			this.requestDrain();
		});
		this.releasing.set(key, { run, query: roomKey });
	}

	private async admit(
		planId: string,
		nodeId: string,
		version: number,
		dispatch: FleetDispatch,
		placement: Placement,
		exit: string,
		roomKey: string,
	): Promise<void> {
		const key = dispatch.idempotencyKey;
		const park = (reason: string, detail: string) => {
			this.parked.set(key, roomKey);
			this.offerKeys.add(key);
			harnessLog.info("plan", "a plan step release waits", { planId, nodeId, reason, detail });
		};
		// A temporary remote refusal (the machine's room or runtime is momentarily unavailable: the refusal carries a retry time)
		// keeps its offer prepared and the step parked on that machine; a candidate change offers it again. A permanent one
		// releases the offer, the machine is not offered again for this release, and the next drain releases the step here
		// (or on another candidate).
		const refused = (refusal: { readonly reason: string; readonly detail: string; readonly retryAt?: number }) => {
			if (refusal.detail.startsWith(`${PLAN_VERIFIER_UNAVAILABLE}:`))
				return this.holdStep(planId, nodeId, version, `the verifier cannot run: ${refusal.detail}`);
			if (refusal.detail.startsWith(WORKTREE_UNAVAILABLE))
				return this.holdStep(planId, nodeId, version, worktreeUnavailableWords(refusal.detail));
			// A start that threw is not a wait for room: retrying it changes nothing, so the planner is told what failed.
			if (refusal.detail.startsWith(WORKER_START_ERROR))
				return this.holdStep(
					planId,
					nodeId,
					version,
					`this step could not be started: ${refusal.detail.slice(WORKER_START_ERROR.length)}`,
				);
			if (placement.kind !== "remote_machine") return park(refusal.reason, refusal.detail);
			const machineId = placement.machineId;
			// A must-pinned step can only be placed on its machine, so only a candidate change can help it: every refusal parks it.
			if (exit === "pin_machine_must" || refusal.retryAt !== undefined) {
				this.remoteParked.set(key, machineId);
				return park(refusal.reason, refusal.detail);
			}
			this.deps.fleet().releasePrepared(key);
			this.remoteRefused.set(key, new Set([...(this.remoteRefused.get(key) ?? []), machineId]));
			harnessLog.info("plan", "a plan step's remote placement was refused; it is released here", {
				planId,
				nodeId,
				machineId,
				reason: refusal.reason,
			});
			this.requestDrain();
		};
		try {
			const fleet = this.deps.fleet();
			const prepared = await fleet.prepare(dispatch, placement, this.abort.signal);
			if (this.disposed) return;
			if (prepared.kind === "refused") return refused(prepared);
			const current = this.deps.runtime().getSnapshot().plans[planId];
			const runtime = current?.nodes[nodeId];
			if (!current || current.closed || !runtime || runtime.since !== version || runtime.release) {
				harnessLog.info("plan", "a prepared plan step changed before it started", { planId, nodeId });
				fleet.releasePrepared(key);
				return;
			}
			const decision = fleet.admit(dispatch, placement);
			if (decision.kind === "refused") return refused(decision);
			this.deps.runtime().releasePlanNode({ planId, version, nodeId, taskId: decision.taskId, placement, exit });
			this.offerKeys.delete(key);
			this.remoteRefused.delete(key);
			harnessLog.info("plan", "a plan step is released", {
				planId,
				nodeId,
				taskId: decision.taskId,
				admitted: decision.kind,
				exit,
			});
		} catch (error) {
			if (this.abort.signal.aborted) return;
			park("error", errorText(error));
		}
	}

	/** Room subscriptions follow the queries a release waits on; a room change unparks and drains. */
	private syncRoomSubscriptions(waiting: ReadonlySet<string>): void {
		this.waitingRoomKeys = waiting;
		// A candidate change re-runs the releases waiting on local room, and places again the remote placements a temporary
		// refusal parked (subscribed once).
		this.unsubscribeCandidates ??= this.deps.fleet().subscribeCandidates(() => {
			let unparked = false;
			for (const key of this.remoteParked.keys()) unparked = this.parked.delete(key) || unparked;
			if (unparked || this.waitingRoomKeys.size > 0) this.requestDrain();
		});
		const wanted = new Set([
			...waiting,
			...[...this.parked.values()].filter((key): key is string => key !== undefined),
		]);
		for (const [key, unsubscribe] of this.roomSubscriptions) {
			if (wanted.has(key)) continue;
			unsubscribe();
			this.roomSubscriptions.delete(key);
		}
		for (const key of wanted) {
			const query = this.roomQueries.get(key);
			if (!query || this.roomSubscriptions.has(key)) continue;
			this.roomSubscriptions.set(
				key,
				this.deps.fleet().subscribeRoom(query, () => {
					this.parked.clear();
					this.requestDrain();
				}),
			);
		}
	}

	// ---- plan-updates and the machine shadow ----

	private deliverUpdates(updates: readonly PlanUpdateIntent[]): void {
		if (updates.length === 0) return;
		const snapshot = this.deps.runtime().getSnapshot();
		for (const intent of updates) {
			const deliveryId = planUpdateDeliveryId(intent.planId, intent.input);
			if (this.delivering.has(deliveryId) || this.deps.isDelivered(deliveryId)) continue;
			const view = planView(snapshot, intent.planId);
			if (!view) continue;
			const result = intent.artifact ? readJoinResult(intent.artifact) : undefined;
			// A plan that finished on a plain step has no combined result to read: its update carries that step's outcome.
			const plan = snapshot.plans[intent.planId];
			const stepOutcome =
				!result && plan && intent.input.kind === "settled" && intent.input.nodeId !== undefined
					? planNodeOutcome(snapshot, plan, intent.input.nodeId)
					: undefined;
			const brief = planNodeBrief(snapshot, intent.planId, intent.input.nodeId);
			// The join's recorded level: the highest its steps settled at, read from the durable record, not the artifact.
			const joinStakes =
				intent.input.nodeId !== undefined
					? snapshot.plans[intent.planId]?.nodes[intent.input.nodeId]?.join?.stakes
					: undefined;
			const delivery = planUpdateDelivery(
				view,
				{
					...intent.input,
					...(result ? { result } : {}),
					...(stepOutcome ? { stepOutcome } : {}),
					...(brief ? { brief } : {}),
					...(joinStakes ? { stakes: joinStakes } : {}),
				},
				this.deps.captureOrigin(),
			);
			this.delivering.add(deliveryId);
			this.deps
				.deliver(delivery, this.abort.signal)
				.then(() =>
					harnessLog.info("plan", "a plan update is delivered", {
						planId: intent.planId,
						kind: intent.input.kind,
					}),
				)
				.catch((error: unknown) => {
					if (!this.abort.signal.aborted)
						harnessLog.warn("plan", "a plan update could not be delivered; the next change retries it", {
							planId: intent.planId,
							error: errorText(error),
						});
				})
				.finally(() => this.delivering.delete(deliveryId));
		}
	}

	private observe(snapshot: TaskRuntimeProjection): void {
		if (snapshot === this.lastSnapshot) return;
		this.lastSnapshot = snapshot;
		let visibleChange = false;
		// A plan the snapshot no longer holds leaves the panel, and its fingerprint goes with it.
		for (const planId of [...this.visibleViews.keys()]) {
			if (snapshot.plans[planId] !== undefined) continue;
			this.visibleViews.delete(planId);
			this.fingerprint.forget(planId);
			visibleChange = true;
		}
		// Only a plan whose inputs moved is rebuilt: its steps' state moves go to the machine shadow, and its view is compared
		// with the one the panel last saw.
		for (const planId of this.fingerprint.changed(snapshot)) {
			// planView is undefined only for an id the snapshot lacks; `changed` reads the snapshot's own plans.
			const view = planView(snapshot, planId);
			if (view === undefined) continue;
			const before = this.visibleViews.get(planId);
			if (before === undefined || !sameVisibleView(before, view)) visibleChange = true;
			this.recordStepMoves(before, view);
			this.visibleViews.set(planId, view);
		}
		// The panel is a function of these views; the store commits of other work leave them as they were, so the owner's
		// screen redraws only when a plan's visible state moves (a step starts, settles or is held, a plan opens or closes,
		// or its text changes).
		if (visibleChange) this.deps.planChanged();
	}

	/** Records each step of a plan whose state moved since the last observation; a step new to the plan moves nothing. */
	private recordStepMoves(before: PlanView | undefined, view: PlanView): void {
		if (before === undefined) return;
		const states = new Map<string, PlanNodeState>(before.nodes.map((node) => [node.id, node.state] as const));
		for (const node of view.nodes) {
			const was = states.get(node.id);
			if (was !== undefined && was !== node.state)
				this.nodeMachine.record(was, node.state, `plan step ${view.planId}/${node.id}`);
		}
	}
}
