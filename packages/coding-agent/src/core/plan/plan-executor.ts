/**
 * The plan executor: applies `plan` tool calls and runs every open plan of the session to its end.
 *
 * Event-driven, never polling: it reconciles (`plan-reconcile.ts`) after each orchestration store commit (worker
 * outcomes, lane terminals, its own plan events), each fleet room change, each goal synchronization and each tool
 * call. One drain runs at a time; a commit during a drain marks it dirty and the drain runs again. Work that awaits
 * (preparing a release, the vote judgment, a plan-update delivery) runs beside the drain and asks for a new drain when
 * it ends. A release or action the fleet refused, or that failed, is parked until the room, the goal or the plan
 * changes, so the executor never loops on its own refusals.
 *
 * Restart recovery is the same reconcile: every fact it reads is durable (plan events, task outcomes, the parent-input
 * receipts of plan-updates), a release replays through the fleet's idempotency key, and a plan-update's delivery id is
 * the plan, the step and the event's sequence.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { defineMachine, type MachineObserver, observeMachine, registerMachine } from "../../kernel/machine-spec.ts";
import { orchestrationSessionDir } from "../agent-paths.ts";
import { renderCommsStateLine } from "../comms/comms-records.ts";
import { describeOutcomeForHandoff } from "../delegation/worker-outcome-words.ts";
import type { FleetDispatch, FleetScheduler, RoomQuery } from "../fleet/fleet-types.ts";
import { weightOf } from "../fleet/local-admit.ts";
import type { GoalState } from "../goals/goal-state.ts";
import { withSessionBundleAdmission } from "../orchestration/session-bundle-lifecycle.ts";
import type { DurableTaskRuntime, TaskRuntimeProjection } from "../orchestration/task-runtime.ts";
import { goalObjectiveId } from "../orchestration/work-state-projection.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import type { ParentInputDelivery } from "../parent-input-delivery.ts";
import type { Placement } from "../placement/placement-types.ts";
import type { OperationEffectEngine } from "../system-one/operation-classifier.ts";
import { chooseVoteWinner } from "../system-one/plan-vote.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import {
	decideCodeJoin,
	JOIN_RESULT_MAX_BYTES,
	type JoinIdentity,
	type JoinResult,
	joinArtifactPath,
	joinOutcomeId,
	settleVote,
	workerJoinResult,
} from "./joins.ts";
import { acceptPlanCall } from "./plan-acceptance.ts";
import { buildPlanDispatch, decidePlacement, planCriticalPath, planReleaseKey } from "./plan-dispatch.ts";
import type { PlanCallContext, PlanExecutorPort, PlanToolInput, PlanToolResult } from "./plan-executor-port.ts";
import {
	checkPlanFacts,
	derivePlanId,
	isPlanFromNewerBuild,
	PLAN_LIMITS,
	type PlanNodeSpec,
	type PlanNodeState,
	type PlanRecord,
	type PlanRuntimeState,
} from "./plan-graph.ts";
import { type PlanAction, type PlanUpdateIntent, reconcilePlans } from "./plan-reconcile.ts";
import { planNodeOfTask } from "./plan-reducer.ts";
import { resolveSince, splitNodes, verifyWrapNodes } from "./plan-revision.ts";
import { planUpdateDelivery, planUpdateDeliveryId } from "./plan-update.ts";
import { activeRootPlan, listPlanViews, planView } from "./plan-view.ts";

/** Reconcile passes one drain may run before it yields to the next event. */
const MAX_DRAIN_PASSES = 16;
const VOTE_SUMMARY_CHARS = 600;

type PlanFleet = Pick<FleetScheduler, "prepare" | "admit" | "cancel" | "room" | "subscribeRoom">;

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
	readonly deliver: (delivery: ParentInputDelivery, signal: AbortSignal) => Promise<unknown>;
	readonly isDelivered: (deliveryId: string) => boolean;
	/** Acknowledges routed terminal notifications the plan consumed. */
	readonly acknowledge: (notificationIds: readonly string[]) => void;
	readonly now?: () => number;
}

const NODE_STATES: readonly PlanNodeState[] = [
	"planned",
	"ready",
	"admitted",
	"running",
	"settled",
	"held",
	"superseded",
	"cancelled",
];

function onward(...states: PlanNodeState[]): Partial<Record<PlanNodeState, PlanNodeState>> {
	return Object.fromEntries(states.map((state) => [state, state]));
}

/** One plan step's life; a revise may restart a settled or held step, and a retry may queue a running one again. */
export const PLAN_NODE_MACHINE = defineMachine<PlanNodeState, PlanNodeState>({
	name: "plan-node",
	states: NODE_STATES,
	initial: "planned",
	transitions: {
		planned: onward("ready", "admitted", "settled", "held", "superseded", "cancelled"),
		ready: onward("planned", "admitted", "running", "settled", "superseded", "cancelled"),
		admitted: onward("planned", "running", "settled", "held", "superseded", "cancelled"),
		running: onward("planned", "admitted", "settled", "held", "superseded", "cancelled"),
		held: onward("planned", "ready", "settled", "superseded", "cancelled"),
		settled: onward("planned", "ready", "held", "superseded", "cancelled"),
		superseded: {},
		cancelled: {},
	},
	describe: {
		planned: "waiting for earlier steps",
		ready: "ready to start",
		admitted: "starting",
		running: "running",
		settled: "done",
		held: "held",
		superseded: "replaced",
		cancelled: "stopped",
	},
});

let nodeObserver: MachineObserver<PlanNodeState> | undefined;

function machineObserver(): MachineObserver<PlanNodeState> {
	if (!nodeObserver) {
		nodeObserver = observeMachine(PLAN_NODE_MACHINE);
		registerMachine(nodeObserver);
	}
	return nodeObserver;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function queryKey(query: RoomQuery): string {
	return `${query.objectiveId}|${query.weight}`;
}

/** A join result file the executor wrote; anything else reads as absent. */
function readJoinResult(path: string): JoinResult | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<JoinResult>;
		return value?.v === 1 && value.outcome && Array.isArray(value.members) ? (value as JoinResult) : undefined;
	} catch {
		return undefined;
	}
}

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
	private nodeStates = new Map<string, PlanNodeState>();
	private unsubscribeStore: (() => void) | undefined;
	private lastSnapshot: TaskRuntimeProjection | undefined;
	private draining = false;
	private dirty = false;
	private disposed = false;

	constructor(deps: PlanExecutorDeps) {
		this.deps = deps;
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
		for (const unsubscribe of this.roomSubscriptions.values()) unsubscribe();
		this.roomSubscriptions.clear();
	}

	/** The goal changed: parked work may be allowed now, and the goal's requirements are re-read. */
	noteGoalChanged(): void {
		this.parked.clear();
		this.requestDrain();
	}

	/** The terminal route's predicate: the task runs (or ran) a step of a retained plan. */
	ownsTask(taskId: string): boolean {
		return planNodeOfTask(this.deps.runtime().getSnapshot().plans, taskId) !== undefined;
	}

	async applyToolCall(input: PlanToolInput, context: PlanCallContext): Promise<PlanToolResult> {
		if (this.disposed) return { ok: false, text: "Plans are unavailable: the session is closing." };
		const runtime = this.deps.runtime();
		const snapshot = runtime.getSnapshot();
		const active = activeRootPlan(snapshot);
		const nowIso = new Date(this.now()).toISOString();
		if (input.action === "cancel") {
			if (!active) return { ok: false, text: "No plan is running." };
			runtime.closePlan({
				planId: active.planId,
				status: "cancelled",
				reason: input.reason?.trim().slice(0, PLAN_LIMITS.reasonChars) || "cancelled by the planner",
			});
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
		return this.deps.now?.() ?? Date.now();
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

	private pass(): void {
		const runtime = this.deps.runtime();
		const snapshot = runtime.getSnapshot();
		if (Object.keys(snapshot.plans).length === 0) return;
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
			case "settle":
				runtime.settlePlanNode({
					planId: action.planId,
					nodeId: action.nodeId,
					outcomeId: action.outcomeId,
					generation: action.generation,
				});
				harnessLog.info("plan", "a plan step is settled", { planId: action.planId, nodeId: action.nodeId });
				return;
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
				runtime.closePlan({ planId: action.planId, status: action.status, reason: action.reason });
				harnessLog.info("plan", "a plan is closed", {
					planId: action.planId,
					status: action.status,
					reason: action.reason,
				});
				return;
			case "cancel_task":
				this.cancelTask(action.taskId, action.reason);
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
					workerJoinResult(snapshot, plan, record, node, action.outcome, identity),
				);
				return;
			}
			case "verify_wrap":
				if (!action.settled) {
					const { outcomeId, generation } = action.outcome;
					runtime.settlePlanNode({ planId: action.planId, nodeId: action.nodeId, outcomeId, generation });
				}
				this.hostRevision(
					action.planId,
					action.nodeId,
					action.outcome.generation,
					"an independent check",
					(record, version) => verifyWrapNodes(record, action.nodeId, action.requirementIds, version),
				);
				return;
			case "split":
				this.hostRevision(action.planId, action.nodeId, action.outcome.generation, "a split", (record, version) =>
					splitNodes(record, action.nodeId, action.requirementIds, version),
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
	 * A host revision (verify wrap, split): version+1 with the new nodes; a version the facts refuse holds the step for
	 * the root's revise instead.
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

	/** Rule 4: a code join's decision; a vote with two or more accepted candidates asks System One first. */
	private decideJoin(planId: string, nodeId: string): void {
		const { snapshot, plan, record } = this.planOf(planId);
		const node = this.nodeOf(record, nodeId);
		const identity = this.joinIdentity(plan, planId, nodeId);
		const decision = decideCodeJoin(snapshot, plan, record, node, identity);
		if (decision.kind === "wait") return;
		if (decision.kind === "settle") {
			this.settleJoin(planId, nodeId, decision.result);
			for (const member of decision.cancel) {
				const taskId = plan.nodes[member]?.release?.taskId;
				if (taskId && !plan.nodes[member]?.settled) this.cancelTask(taskId, "plan_join_settled");
			}
			return;
		}
		const key = `${planId}:${nodeId}:${node.since}`;
		if (this.choosing.has(key)) return;
		this.choosing.add(key);
		const candidates = decision.candidates.map((candidate) => ({
			nodeId: candidate.nodeId,
			summary:
				`${describeOutcomeForHandoff(candidate.outcome)}${candidate.outcome.digestRef ? ` Report: ${candidate.outcome.digestRef}` : ""}`.slice(
					0,
					VOTE_SUMMARY_CHARS,
				),
		}));
		void chooseVoteWinner(this.deps.engine(), {
			criterion: node.join?.criterion ?? node.intent,
			candidates,
			signal: this.abort.signal,
		})
			.then((winner) => {
				const fresh = this.planOf(planId);
				const runtime = fresh.plan.nodes[nodeId];
				if (!runtime || runtime.join || runtime.since !== node.since || fresh.plan.closed) return;
				const identityNow = this.joinIdentity(fresh.plan, planId, nodeId);
				this.settleJoin(
					planId,
					nodeId,
					settleVote(fresh.snapshot, fresh.plan, fresh.record, node, identityNow, winner),
				);
			})
			.catch((error: unknown) => {
				if (!this.abort.signal.aborted)
					harnessLog.warn("plan", "a vote could not settle", { planId, nodeId, error: errorText(error) });
			})
			.finally(() => {
				this.choosing.delete(key);
				this.requestDrain();
			});
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
		this.deps.runtime().settlePlanJoin({ planId, nodeId, outcome: result.outcome, artifact: path });
		harnessLog.info("plan", "a plan join is settled", {
			planId,
			nodeId,
			status: result.outcome.status,
			members: result.members.length,
		});
	}

	// ---- releases ----

	/** Rule 5: one release through the fleet, within the room's ready window. */
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
		if (this.releasing.has(key)) return;
		const dispatch = buildPlanDispatch(snapshot, plan, record, node, planCriticalPath(record));
		const query: RoomQuery = {
			objectiveId: record.objectiveId,
			weight: weightOf(dispatch.demand, dispatch.writeScope),
		};
		const roomKey = queryKey(query);
		this.roomQueries.set(roomKey, query);
		if (!room.has(roomKey)) {
			const inFlight = [...this.releasing.values()].filter((entry) => entry.query === roomKey).length;
			room.set(roomKey, this.deps.fleet().room(query).readyWindowFree - inFlight);
		}
		const free = room.get(roomKey) ?? 0;
		if (free <= 0) {
			waiting.add(roomKey);
			return;
		}
		room.set(roomKey, free - 1);
		const { placement, exit } = decidePlacement(node);
		const run = this.admit(record.planId, node.id, node.since, dispatch, placement, exit, roomKey).finally(() => {
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
			harnessLog.info("plan", "a plan step release waits", { planId, nodeId, reason, detail });
		};
		try {
			const fleet = this.deps.fleet();
			const prepared = await fleet.prepare(dispatch, placement, this.abort.signal);
			if (this.disposed) return;
			if (prepared.kind === "refused") return park(prepared.reason, prepared.detail);
			const current = this.deps.runtime().getSnapshot().plans[planId];
			const runtime = current?.nodes[nodeId];
			if (!current || current.closed || !runtime || runtime.since !== version || runtime.release) {
				harnessLog.info("plan", "a prepared plan step changed before it started", { planId, nodeId });
				return;
			}
			const decision = fleet.admit(dispatch, placement);
			if (decision.kind === "refused") return park(decision.reason, decision.detail);
			this.deps.runtime().releasePlanNode({ planId, version, nodeId, taskId: decision.taskId, placement, exit });
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
			const delivery = planUpdateDelivery(
				view,
				{ ...intent.input, ...(result ? { result } : {}) },
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
		const observer = machineObserver();
		const seen = new Map<string, PlanNodeState>();
		for (const view of listPlanViews(snapshot)) {
			for (const node of view.nodes) {
				const key = `${view.planId}/${node.id}`;
				const before = this.nodeStates.get(key);
				if (before !== undefined && before !== node.state) observer.record(before, node.state, `plan step ${key}`);
				seen.set(key, node.state);
			}
		}
		this.nodeStates = seen;
	}
}
