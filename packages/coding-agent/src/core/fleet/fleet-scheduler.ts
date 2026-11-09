/**
 * The session's fleet scheduler: the one owner of how many workers may run now. Room is computed from code facts
 * (safety ceilings, the subscription allowance of the account the work runs on, free memory and the shared heap, and the
 * room a non-local placement's capacity source reports); no fixed concurrency setting exists. Waiting nodes are indexed
 * by the resource that blocks them, and only an event for that resource re-runs selection: a terminal (the worker
 * controller drains on it), an allowance reading that changed, a capacity source's signal, a resume, or a `TimerPort`
 * alarm at a recorded reopen time. With nothing running to signal, a node waiting on machine memory or on an allowance
 * with no stated reset is rechecked by one alarm that starts at 30 s and doubles to 5 min: a scheduled recheck of a
 * resource fact, never polling for work completion.
 *
 * Local lanes are materialized and started by the worker controller; its dispatch queue is a `FleetQueue` created here,
 * so ordering, restart metadata and the room snapshot share one owner. A planned local dispatch is prepared through the
 * controller's start phases (`prepare`) and materialized synchronously by `admit` (`local-admit.ts`). Each local worker
 * claims its account's adaptive window and its metered cost while it runs (`fleet-local-claims.ts`). Stop and resume are
 * session-scoped and survive a restart through `FleetQueueStore`; the stop machine is observed in the kernel's machine
 * registry.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import { harnessLog } from "../../kernel/harness-log.ts";
import { defineMachine, observeMachine, registerMachine } from "../../kernel/machine-spec.ts";
import { alarmAt, type TimerPort, type WallAlarm } from "../../kernel/timer-port.ts";
import type { PlacementCapacitySource } from "../placement/capacity-source.ts";
import { type Placement, placementCapacityKey } from "../placement/placement-types.ts";
import type { ResolvedFleetSettings } from "../settings/settings-schema.ts";
import { type AllowanceReading, allowanceRoomTerm, type FleetAllowancePort } from "./capacity/allowance-room.ts";
import {
	type MachineBaseline,
	type MachineFacts,
	machineBaseline,
	machineRoomTerms,
	processMachineBaseline,
	readMachineFacts,
} from "./capacity/machine-room.ts";
import { bindingTerm, ceilingTerm, decideRoom } from "./capacity/room.ts";
import { FleetLocalClaims, type SpendBrakeState } from "./fleet-local-claims.ts";
import { FleetQueue } from "./fleet-queue.ts";
import { type FleetQueueMetadataEntry, FleetQueueStore, fleetQueueMetadataPath } from "./fleet-queue-store.ts";
import type {
	AdmitDecision,
	FleetDispatch,
	FleetRefusal,
	FleetRoomDecision,
	FleetScheduler,
	FleetScope,
	FleetWaitReason,
	PrepareDecision,
	RoomQuery,
	RoomSnapshot,
	RoomTerm,
	ShareSpec,
} from "./fleet-types.ts";
import { FleetWaitSets } from "./fleet-wait-sets.ts";
import {
	decisionForStart,
	type FleetLocalStartPort,
	horizonRefusal,
	LOCAL_START_RUNTIME_REPLACING,
	refusalForSkip,
	weightOf,
} from "./local-admit.ts";

/** First recheck of a machine or unstated-reset allowance wait with nothing running; doubles up to the cap. */
export const FLEET_RECHECK_INITIAL_MS = 30_000;
export const FLEET_RECHECK_MAX_MS = 5 * 60_000;
/** Idempotent admit decisions kept per session. */
const ADMIT_DECISION_LIMIT = 1024;

const NO_LOCAL_STARTS: FleetRefusal = {
	kind: "refused",
	reason: "placement",
	blocker: "placement_unreachable",
	detail: "no worker controller is bound to start local work",
};

const FLEET_STOP_MACHINE = defineMachine<"running" | "stopped", "stop" | "resume">({
	name: "fleet-admission",
	states: ["running", "stopped"],
	initial: "running",
	transitions: { running: { stop: "stopped" }, stopped: { resume: "running" } },
	describe: { running: "admitting workers as room allows", stopped: "stopped: nothing new starts until resumed" },
});

/** What the fleet reads from, and asks of, the worker controller that runs this session's local lanes. */
export interface FleetLocalPort {
	/** Local workers holding a running slot (running minus those yielded while they wait). */
	runningCount(): number;
	/** Running local workers that hold write paths. */
	runningWriterCount(): number;
	/** Re-runs the local selection pass (the dispatch queue's drain). */
	drain(): void;
	/** Running local lanes with their flow, for a scope cancel. */
	runningLanes(): readonly { laneId: string; objectiveId: string; subtreeId: string }[];
	/** Cancels queued or running lanes through the controller's durable cancel path. */
	cancelLanes(laneIds: readonly string[], reasonCode: string): void;
	/** The attempt has not reached a terminal state. */
	isAttemptLive(attemptId: string): boolean;
	/** The attempt's measured cost so far, in dollars; undefined when unpriced or unknown. */
	attemptCostUsd(attemptId: string): number | undefined;
}

export interface SessionFleetSchedulerDeps {
	readonly agentDir: string;
	readonly sessionId: string;
	readonly timers: TimerPort;
	settings(): ResolvedFleetSettings;
	readonly allowance?: FleetAllowancePort;
	readMachine?(): MachineFacts;
	/** The authority digest of an escalation's original attempt; undefined when unknown. */
	escalationAuthorityDigest?(outcomeId: string): string | undefined;
	/** The provider account a model's requests are charged to (the provider gate's keying); absent leaves windows out. */
	accountKey?(provider: string): string;
	/** The owner's concurrency limit for a provider (`providerAdmission.limits`), when set. */
	providerLimit?(provider: string): number | undefined;
	/** True when a model's work is paid per request (an API key), not a subscription login; absent means none is. */
	isMetered?(model: Model<Api>): boolean;
	/** The spend-rate brake engaged (with the owner's plain words) or lifted. */
	onSpendBrake?(state: SpendBrakeState): void;
}

/** One local dispatch's room question: the model whose account it runs on, whether it writes, and its goal. */
export interface LocalRoomInput {
	readonly laneId?: string;
	readonly model?: Model<Api>;
	readonly writes: boolean;
	/** The goal whose metered budget the dispatch spends; the queued lane's goal when absent. */
	readonly objectiveId?: string;
	/** The planner's token estimate, which prices the metered cost term when stated. */
	readonly estimatedTokens?: number;
}

interface FactsPass {
	machine?: MachineFacts;
	readonly allowance: Map<string, AllowanceReading>;
	readonly decisions: Map<string, FleetRoomDecision>;
}

interface Recheck {
	alarm?: WallAlarm;
	delayMs: number;
}

export class SessionFleetScheduler implements FleetScheduler {
	private readonly deps: SessionFleetSchedulerDeps;
	private readonly waits = new FleetWaitSets();
	private readonly store: FleetQueueStore;
	private readonly restored = new Map<string, FleetQueueMetadataEntry>();
	private readonly baseline: MachineBaseline;
	private readonly yields = new Map<string, number>();
	private readonly sources = new Map<string, { source: PlacementCapacitySource; unsubscribe: () => void }>();
	private readonly decisions = new Map<string, AdmitDecision>();
	private readonly roomSubscribers = new Set<{
		query: RoomQuery;
		onChange: (snapshot: RoomSnapshot) => void;
		last: number;
	}>();
	private readonly accountReadings = new Map<string, AllowanceReading>();
	private readonly lastWait = new Map<string, { key: string; reason: FleetWaitReason; retryAt?: number }>();
	private readonly alarms = new Map<string, WallAlarm & { readonly at: number }>();
	private readonly rechecks = new Map<string, Recheck>();
	private readonly ceilingEpisodes = new Set<string>();
	private readonly pendingWakes = new Set<string>();
	private readonly observer = observeMachine(FLEET_STOP_MACHINE);
	private readonly unregisterMachine: () => void;
	private readonly unsubscribeAllowance: (() => void) | undefined;
	private readonly claims: FleetLocalClaims;
	private readonly unsubscribeWindows: () => void;
	/** Local dispatches prepared and not yet admitted, by key, so a scope cancel releases its own. */
	private readonly prepared = new Map<string, FleetDispatch>();
	private local: FleetLocalPort | undefined;
	private startPort: FleetLocalStartPort | undefined;
	private queue: FleetQueue<unknown> | undefined;
	private pass: FactsPass | undefined;
	private stopped = false;
	private revision = 0;
	private roomNotifyPending = false;
	private lastReleaseAt: number | undefined;
	private meanReleaseIntervalMs: number | undefined;
	private disposed = false;

	constructor(deps: SessionFleetSchedulerDeps) {
		this.deps = deps;
		this.store = new FleetQueueStore(fleetQueueMetadataPath(deps.agentDir, deps.sessionId));
		this.baseline = deps.readMachine ? machineBaseline(deps.readMachine()) : processMachineBaseline();
		this.unregisterMachine = registerMachine(this.observer);
		this.claims = new FleetLocalClaims({
			agentDir: deps.agentDir,
			now: () => deps.timers.now(),
			settings: () => deps.settings(),
			...(deps.accountKey ? { accountKey: deps.accountKey } : {}),
			...(deps.providerLimit ? { providerLimit: deps.providerLimit } : {}),
			...(deps.isMetered ? { isMetered: deps.isMetered } : {}),
			...(deps.onSpendBrake ? { onBrake: deps.onSpendBrake } : {}),
		});
		const metadata = this.store.load();
		if (metadata) {
			for (const entry of metadata.entries) this.restored.set(entry.id, entry);
			if (metadata.stopped) {
				this.stopped = true;
				this.observer.record("running", "stopped", "restored");
			}
			// A restarted fleet releases half of each account window until its first success, as after a resume.
			this.claims.rampAll();
			const now = deps.timers.now();
			for (const entry of metadata.entries)
				if (entry.retryAt !== undefined && entry.retryAt > now && entry.lastReason)
					this.armAlarm(entry.lastReason, entry.retryAt);
			harnessLog.info("fleet", "fleet queue metadata restored", {
				entries: metadata.entries.length,
				stopped: metadata.stopped,
			});
		}
		this.unsubscribeAllowance = deps.allowance?.subscribe((accountKey) => {
			this.accountReadings.delete(accountKey);
			this.pass = undefined;
			this.changed();
			this.wake(`account:${accountKey}`);
		});
		this.unsubscribeWindows = this.claims.subscribe((waitKey) => {
			this.pass = undefined;
			this.changed();
			this.wake(waitKey);
		});
	}

	/** Binds the worker controller that runs local lanes; the returned function unbinds it. */
	bindLocal(port: FleetLocalPort): () => void {
		this.local = port;
		return () => {
			if (this.local === port) this.local = undefined;
		};
	}

	/** Binds the worker controller's start phases, through which a local dispatch is prepared and materialized. */
	bindStartPhases(port: FleetLocalStartPort): () => void {
		this.startPort = port;
		return () => {
			if (this.startPort !== port) return;
			port.release();
			this.prepared.clear();
			this.startPort = undefined;
		};
	}

	/**
	 * The local dispatch queue. Its order is the fleet's fair order, its membership feeds the room snapshot and restart
	 * metadata, and a node leaving it leaves its wait set. A recovered node takes back its first enqueue time.
	 */
	createQueue<P>(): FleetQueue<P> {
		const queue = new FleetQueue<P>({
			now: () => this.deps.timers.now(),
			enqueuedAtFor: (id) => this.restored.get(id)?.enqueuedAt,
			onRemove: (id) => {
				this.waits.release(id);
				this.lastWait.delete(id);
			},
			onChange: () => this.changed(),
		});
		this.queue = queue as FleetQueue<unknown>;
		return queue;
	}

	/** The queued node's flow and priority as a previous process of this session left them. */
	restoredEntry(id: string): FleetQueueMetadataEntry | undefined {
		return this.restored.get(id);
	}

	// ---- local admission ----

	/**
	 * Room for one more local dispatch: the stop, the running and writer ceilings, the allowance of the dispatch's
	 * account and the machine terms, in that order. A waiting lane is indexed under the binding term's resource and an
	 * alarm is armed at its reopen time; memoized for one synchronous selection pass while the running counts hold.
	 */
	localRoom(input: LocalRoomInput): FleetRoomDecision {
		const running = this.local?.runningCount() ?? 0;
		const writers = input.writes ? (this.local?.runningWriterCount() ?? 0) : 0;
		const pass = this.factsPass();
		const objectiveId =
			input.objectiveId ||
			(input.laneId !== undefined ? this.queue?.entry(input.laneId)?.objectiveId : undefined) ||
			"";
		const memoKey = `${running}|${writers}|${input.writes}|${input.model ? `${input.model.provider}/${input.model.id}` : ""}|${objectiveId}`;
		let decision = pass.decisions.get(memoKey);
		if (!decision) {
			decision = decideRoom(this.localTerms({ ...input, objectiveId }, running, writers));
			pass.decisions.set(memoKey, decision);
		}
		if (input.laneId !== undefined) this.recordLocalDecision(input.laneId, decision, running);
		return decision;
	}

	/** Free ready-window slots for one more queued node; ordinary work leaves the last slot to a verifier. */
	readyWindowFree(queued: number, priority: boolean): number {
		return Math.max(0, this.readyWindow() - queued - (priority ? 0 : 1));
	}

	/** The fleet's ready window: the running ceiling plus a buffer, so a slot that frees always has a queued successor. */
	readyWindow(): number {
		const running = this.deps.settings().ceiling.running;
		return running + Math.max(8, Math.floor(running / 4));
	}

	/**
	 * A local lane starts now (every start, queued or direct, reports here once its attempt is prepared): it occupies its
	 * account's window and reserves its metered estimate against the goal's and the day's budgets until it is released.
	 */
	noteAdmitted(laneId: string, attemptId: string, model: Model<Api>, objectiveId: string | undefined): void {
		this.waits.release(laneId);
		this.lastWait.delete(laneId);
		this.claims.admitted(attemptId, model, objectiveId);
		harnessLog.debug("fleet", "a node is admitted", () => ({
			laneId,
			running: this.local?.runningCount() ?? 0,
		}));
		this.changed();
	}

	/** A local attempt's run ended: its slot is free again (the controller drains on the same terminal). */
	noteReleased(attemptId: string): void {
		this.yields.delete(attemptId);
		this.claims.released(attemptId, () => this.local?.attemptCostUsd(attemptId));
		const now = this.deps.timers.now();
		if (this.lastReleaseAt !== undefined) {
			const interval = Math.max(1, now - this.lastReleaseAt);
			this.meanReleaseIntervalMs =
				this.meanReleaseIntervalMs === undefined ? interval : 0.8 * this.meanReleaseIntervalMs + 0.2 * interval;
		}
		this.lastReleaseAt = now;
		harnessLog.debug("fleet", "a node is released", { attemptId });
		this.changed();
	}

	// ---- capacity yields (a running worker that waits on another gives its slot back meanwhile) ----

	yieldedCount(attemptId: string): number | undefined {
		return this.yields.get(attemptId);
	}

	setYielded(attemptId: string, count: number): void {
		this.yields.set(attemptId, count);
		this.changed();
	}

	forgetYield(attemptId: string): void {
		if (this.yields.delete(attemptId)) this.changed();
	}

	/** Yielded slots still held by a live attempt; attempts no longer holding a slot are forgotten and returned. */
	heldYields(holdsSlot: (attemptId: string) => boolean): { held: number; pruned: string[] } {
		let held = 0;
		const pruned: string[] = [];
		for (const attemptId of this.yields.keys()) {
			if (holdsSlot(attemptId)) held += 1;
			else pruned.push(attemptId);
		}
		for (const attemptId of pruned) this.yields.delete(attemptId);
		return { held, pruned };
	}

	// ---- FleetScheduler ----

	async prepare(dispatch: FleetDispatch, placement: Placement, signal?: AbortSignal): Promise<PrepareDecision> {
		const mismatch = this.escalationRefusal(dispatch);
		if (mismatch) return mismatch;
		if (placement.kind !== "local_worker" || this.decisions.has(dispatch.idempotencyKey)) return { kind: "prepared" };
		const port = this.startPort;
		if (!port) return NO_LOCAL_STARTS;
		const prepared = await port.prepare(dispatch, signal);
		if (!prepared.ok) {
			harnessLog.info("fleet", "a dispatch is refused at preparation", {
				key: dispatch.idempotencyKey,
				reason: prepared.skipReason.split(":")[0] ?? "",
			});
			return refusalForSkip(prepared.skipReason);
		}
		if (this.startPort === port) this.prepared.set(dispatch.idempotencyKey, dispatch);
		else port.release(dispatch.idempotencyKey);
		return { kind: "prepared" };
	}

	admit(dispatch: FleetDispatch, placement: Placement): AdmitDecision {
		const cached = this.decisions.get(dispatch.idempotencyKey);
		if (cached) return cached;
		const decision = this.decideAdmit(dispatch, placement);
		if (decision.kind === "refused") {
			harnessLog.info("fleet", "a dispatch is refused", {
				key: dispatch.idempotencyKey,
				reason: decision.reason,
				placement: placement.kind,
			});
			return decision;
		}
		if (decision.kind === "run")
			harnessLog.debug("fleet", "a dispatch runs", { key: dispatch.idempotencyKey, laneId: decision.laneId });
		else harnessLog.debug("fleet", "a dispatch is queued", { key: dispatch.idempotencyKey, reason: decision.reason });
		this.decisions.set(dispatch.idempotencyKey, decision);
		if (this.decisions.size > ADMIT_DECISION_LIMIT) {
			const oldest = this.decisions.keys().next().value;
			if (oldest !== undefined) this.decisions.delete(oldest);
		}
		return decision;
	}

	cancel(scope: FleetScope, reasonCode: string): void {
		const local = this.local;
		if (!local) return;
		const queued = this.queue;
		const inScope = (lane: { objectiveId: string; subtreeId: string }): boolean =>
			scope.kind === "all" ||
			(scope.kind === "objective" && lane.objectiveId === scope.objectiveId) ||
			(scope.kind === "subtree" && lane.subtreeId === scope.subtreeId);
		for (const [key, dispatch] of this.prepared)
			if (inScope(dispatch.demand) || (scope.kind === "plan" && dispatch.plan?.planId === scope.planId))
				this.releasePrepared(key);
		const laneIds =
			scope.kind === "lane"
				? [scope.laneId]
				: scope.kind === "plan"
					? []
					: [
							...(queued?.matching(inScope) ?? []),
							...local
								.runningLanes()
								.filter(inScope)
								.map((lane) => lane.laneId),
						];
		if (laneIds.length === 0) return;
		harnessLog.info("fleet", "a fleet scope is cancelled", { scope: scope.kind, lanes: laneIds.length, reasonCode });
		local.cancelLanes(laneIds, reasonCode);
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.observer.record("running", "stopped", "stop");
		harnessLog.info("fleet", "the fleet is stopped", { queued: this.queue?.size ?? 0 });
		this.pass = undefined;
		this.changed();
	}

	resume(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.observer.record("stopped", "running", "resume");
		harnessLog.info("fleet", "the fleet is resumed", { queued: this.queue?.size ?? 0 });
		// A resume releases half of each account window until its first success, and lifts the spend-rate brake.
		this.claims.rampAll();
		this.claims.liftBrake();
		this.pass = undefined;
		this.changed();
		this.wake("fleet:stop");
		this.wake("budget:brake");
	}

	isStopped(): boolean {
		return this.stopped;
	}

	room(query: RoomQuery): RoomSnapshot {
		const running = this.local?.runningCount() ?? 0;
		const writes = query.weight === "write" || query.weight === "heavy";
		const writers = writes ? (this.local?.runningWriterCount() ?? 0) : 0;
		const terms = this.localTerms({ writes }, running, writers);
		const decision = decideRoom(terms);
		const queue = this.queue;
		const queued =
			queue?.matching(
				(entry) =>
					entry.objectiveId === query.objectiveId &&
					(query.subtreeId === undefined || entry.subtreeId === query.subtreeId),
			).length ?? 0;
		const throughputPerMin = this.meanReleaseIntervalMs ? 60_000 / this.meanReleaseIntervalMs : 0;
		const limitedBy = decision.ok ? bindingTerm(terms)?.reason : decision.term.reason;
		return {
			runnableNow: decision.ok ? decision.room : 0,
			readyWindowFree: this.readyWindowFree(queue?.size ?? 0, false),
			queued,
			throughputPerMin,
			etaMs: (additional) =>
				throughputPerMin > 0 ? ((queued + additional) / throughputPerMin) * 60_000 : Number.POSITIVE_INFINITY,
			...(limitedBy ? { limitedBy } : {}),
			perAccount: this.perAccount(),
			revision: this.revision,
		};
	}

	subscribeRoom(query: RoomQuery, onChange: (snapshot: RoomSnapshot) => void): () => void {
		const subscriber = { query, onChange, last: this.room(query).runnableNow };
		this.roomSubscribers.add(subscriber);
		return () => {
			this.roomSubscribers.delete(subscriber);
		};
	}

	openShare(spec: ShareSpec): void {
		this.queue?.openShare(spec);
		harnessLog.debug("fleet", "a fleet share is opened", { subtreeId: spec.subtreeId, weight: spec.weight });
	}

	closeShare(subtreeId: string, reasonCode: string): void {
		const members = this.queue?.closeShare(subtreeId) ?? [];
		harnessLog.debug("fleet", "a fleet share is closed", { subtreeId, queued: members.length, reasonCode });
		if (members.length > 0) this.local?.cancelLanes(members, reasonCode);
	}

	registerCapacitySource(source: PlacementCapacitySource): () => void {
		this.sources.get(source.key)?.unsubscribe();
		const unsubscribe = source.subscribe(() => {
			this.changed();
			this.wake(`placement:${source.key}`);
		});
		this.sources.set(source.key, { source, unsubscribe });
		this.changed();
		return () => {
			const current = this.sources.get(source.key);
			if (current?.source !== source) return;
			current.unsubscribe();
			this.sources.delete(source.key);
			this.changed();
		};
	}

	/** Writes the restart metadata and releases every alarm, subscription and registry entry. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.store.close();
		for (const alarm of this.alarms.values()) alarm.stop();
		this.alarms.clear();
		for (const recheck of this.rechecks.values()) recheck.alarm?.stop();
		this.rechecks.clear();
		for (const { unsubscribe } of this.sources.values()) unsubscribe();
		this.sources.clear();
		this.unsubscribeAllowance?.();
		this.unsubscribeWindows();
		this.startPort?.release();
		this.prepared.clear();
		this.startPort = undefined;
		const local = this.local;
		this.claims.dispose((attemptId) => local?.attemptCostUsd(attemptId));
		this.unregisterMachine();
		this.roomSubscribers.clear();
		this.local = undefined;
	}

	// ---- internals ----

	private escalationRefusal(dispatch: FleetDispatch): FleetRefusal | undefined {
		if (!dispatch.escalation) return undefined;
		const original = this.deps.escalationAuthorityDigest?.(dispatch.escalation.outcomeId);
		return original === dispatch.escalation.authorityDigest
			? undefined
			: {
					kind: "refused",
					reason: "authority_digest_mismatch",
					blocker: "owner_authority_required",
					detail: "the escalation's authority differs from its original attempt's",
				};
	}

	private decideAdmit(dispatch: FleetDispatch, placement: Placement): AdmitDecision {
		const mismatch = this.escalationRefusal(dispatch);
		if (mismatch) return mismatch;
		if (placement.kind === "local_worker") return this.admitLocal(dispatch);
		const key = placementCapacityKey(placement);
		if (key === undefined)
			return {
				kind: "refused",
				reason: "placement",
				blocker: "placement_unreachable",
				detail: `a ${placement.kind} placement names no machine or bot`,
			};
		const source = this.sources.get(key)?.source;
		if (!source)
			return {
				kind: "refused",
				reason: "placement",
				blocker: "placement_unreachable",
				detail: `no capacity source is registered for ${key}`,
			};
		const room = source.room();
		if (room.slots < 1)
			return {
				kind: "refused",
				reason: "placement",
				blocker: "capacity_unavailable",
				...(room.retryAt !== undefined ? { retryAt: room.retryAt, retryAtBasis: "backoff" as const } : {}),
				detail: `${key} has no free slot`,
			};
		return {
			kind: "refused",
			reason: "placement",
			blocker: "placement_unreachable",
			detail: `no execution backend is registered for ${placement.kind} placements`,
		};
	}

	/**
	 * A prepared local dispatch, materialized: the horizon exits first (`local-admit.ts`), on the account and cost terms
	 * of the model its preparation chose, then the controller's own synchronous start decides run or queued.
	 */
	private admitLocal(dispatch: FleetDispatch): AdmitDecision {
		const port = this.startPort;
		if (!port) return NO_LOCAL_STARTS;
		const key = dispatch.idempotencyKey;
		const model = port.preparedModel(key);
		let binding: RoomTerm | undefined;
		if (model) {
			const writes = dispatch.writeScope.length > 0;
			const running = this.local?.runningCount() ?? 0;
			const writers = writes ? (this.local?.runningWriterCount() ?? 0) : 0;
			const terms = this.localTerms(
				{
					model,
					writes,
					objectiveId: dispatch.demand.objectiveId,
					...(dispatch.demand.estimatedTokens !== undefined
						? { estimatedTokens: dispatch.demand.estimatedTokens }
						: {}),
				},
				running,
				writers,
			);
			// The dispatch starts only once every term has room: any closed term that reopens past the horizon refuses it.
			const now = this.deps.timers.now();
			const horizonMs = this.deps.settings().queueHorizonMs;
			for (const term of terms) {
				const refusal = term.room < 1 ? horizonRefusal(term, now, horizonMs) : undefined;
				if (!refusal) continue;
				this.releasePrepared(key);
				return refusal;
			}
			const room = decideRoom(terms);
			if (!room.ok) binding = room.term;
		}
		const start = port.materialize(dispatch);
		if (start?.started !== false || start.skipReason !== LOCAL_START_RUNTIME_REPLACING) this.prepared.delete(key);
		if (!start)
			return {
				kind: "refused",
				reason: "preflight",
				blocker: "preflight_failed",
				detail: "this local dispatch was not prepared, or its preparation was released",
			};
		return decisionForStart(start, {
			weight: weightOf(dispatch.demand, dispatch.writeScope),
			accountKey: (provider) => this.deps.accountKey?.(provider) ?? provider,
			waitReason: (laneId) => this.lastWait.get(laneId)?.reason,
			...(binding ? { binding } : {}),
			etaMs: () => {
				const snapshot = this.room({ objectiveId: dispatch.demand.objectiveId, weight: "read" });
				return snapshot.etaMs(0);
			},
		});
	}

	private releasePrepared(key: string): void {
		this.prepared.delete(key);
		this.startPort?.release(key);
	}

	/** Room per account: the allowance readings and the adaptive windows, the smaller binding where both know one. */
	private perAccount(): RoomSnapshot["perAccount"] {
		const accounts = new Map<string, { accountKey: string; room: number; retryAt?: number }>();
		for (const reading of this.accountReadings.values()) {
			const term = allowanceRoomTerm(reading);
			accounts.set(reading.accountKey, {
				accountKey: reading.accountKey,
				room: term.room,
				...(term.retryAt !== undefined ? { retryAt: term.retryAt } : {}),
			});
		}
		for (const window of this.claims.perAccount()) {
			const known = accounts.get(window.accountKey);
			if (!known || window.room < known.room) accounts.set(window.accountKey, window);
		}
		return [...accounts.values()];
	}

	private localTerms(input: LocalRoomInput, running: number, writers: number): RoomTerm[] {
		const settings = this.deps.settings();
		const terms: RoomTerm[] = [];
		if (this.stopped)
			terms.push({ reason: "fleet_stopped", room: 0, waitKey: "fleet:stop", detail: "the fleet is stopped" });
		terms.push(ceilingTerm("running", running, settings.ceiling.running));
		if (input.writes) terms.push(ceilingTerm("writers", writers, settings.ceiling.writers));
		if (input.model && this.deps.allowance) terms.push(allowanceRoomTerm(this.readAllowance(input.model)));
		if (input.model)
			terms.push(...this.claims.terms(input.model, input.objectiveId || undefined, input.estimatedTokens));
		const pass = this.factsPass();
		pass.machine ??= this.readMachine();
		terms.push(...machineRoomTerms(pass.machine, this.baseline, running, settings.reserve.memoryPercent));
		return terms;
	}

	private readAllowance(model: Model<Api>): AllowanceReading {
		const pass = this.factsPass();
		const modelKey = `${model.provider}/${model.id}`;
		let reading = pass.allowance.get(modelKey);
		if (!reading) {
			try {
				reading = this.deps.allowance!.read(model);
			} catch {
				reading = {
					accountKey: model.provider,
					allowance: { kind: "unknown", reason: "the allowance read failed", subscription: true },
				};
			}
			pass.allowance.set(modelKey, reading);
			this.accountReadings.set(reading.accountKey, reading);
		}
		return reading;
	}

	private readMachine(): MachineFacts {
		return (this.deps.readMachine ?? readMachineFacts)();
	}

	/** External facts and decisions shared by one synchronous selection pass; the next microtask reads afresh. */
	private factsPass(): FactsPass {
		if (this.pass) return this.pass;
		const pass: FactsPass = { allowance: new Map(), decisions: new Map() };
		this.pass = pass;
		const local = this.local;
		if (local)
			this.claims.prune(
				(attemptId) => local.isAttemptLive(attemptId),
				(attemptId) => local.attemptCostUsd(attemptId),
			);
		queueMicrotask(() => {
			if (this.pass === pass) this.pass = undefined;
		});
		return pass;
	}

	private recordLocalDecision(laneId: string, decision: FleetRoomDecision, running: number): void {
		if (decision.ok) {
			this.waits.release(laneId);
			return;
		}
		const { term } = decision;
		const previous = this.lastWait.get(laneId);
		this.waits.wait(laneId, term.waitKey);
		if (previous?.key !== term.waitKey || previous.retryAt !== term.retryAt) {
			this.lastWait.set(laneId, {
				key: term.waitKey,
				reason: term.reason,
				...(term.retryAt !== undefined ? { retryAt: term.retryAt } : {}),
			});
			harnessLog.debug("fleet", "a node waits for room", { laneId, reason: term.reason, key: term.waitKey });
			this.changed();
		}
		if (term.reason === "safety_ceiling" && !this.ceilingEpisodes.has(term.waitKey)) {
			this.ceilingEpisodes.add(term.waitKey);
			harnessLog.info("fleet", "a safety ceiling holds new work", { key: term.waitKey, running });
		}
		if (term.retryAt !== undefined && term.retryAt > this.deps.timers.now())
			this.armAlarm(term.waitKey, term.retryAt);
		else if ((term.reason === "account_window" || term.waitKey.startsWith("machine:")) && running === 0)
			this.armRecheck(term.waitKey);
	}

	/**
	 * Wakes the waiters on `key` at `at`. A reopening account's wake is jittered per process and account, so the workers
	 * of many sessions and machines never return to one account in the same instant (thundering herd).
	 */
	private armAlarm(key: string, reopenAt: number): void {
		const at = reopenAt + this.claims.reopenJitterMs(key, reopenAt);
		const existing = this.alarms.get(key);
		if (existing && existing.at <= at) return;
		existing?.stop();
		const alarm = alarmAt(this.deps.timers, at, () => {
			this.alarms.delete(key);
			this.pass = undefined;
			this.wake(key);
		});
		this.alarms.set(key, { at, stop: () => alarm.stop() });
	}

	private armRecheck(key: string): void {
		const recheck = this.rechecks.get(key) ?? { delayMs: 0 };
		if (recheck.alarm) return;
		recheck.delayMs =
			recheck.delayMs === 0 ? FLEET_RECHECK_INITIAL_MS : Math.min(FLEET_RECHECK_MAX_MS, recheck.delayMs * 2);
		const handle = this.deps.timers.setTimeout(() => {
			recheck.alarm = undefined;
			this.pass = undefined;
			this.wake(key);
		}, recheck.delayMs);
		recheck.alarm = { stop: () => this.deps.timers.clearTimeout(handle) };
		this.rechecks.set(key, recheck);
	}

	/** Re-runs selection for the woken resources that have waiters, once per microtask however many events arrive. */
	private wake(key: string): void {
		if (this.disposed) return;
		const first = this.pendingWakes.size === 0;
		this.pendingWakes.add(key);
		if (!first) return;
		queueMicrotask(() => {
			const keys = [...this.pendingWakes];
			this.pendingWakes.clear();
			if (this.disposed || !keys.some((woken) => this.waits.waiting(woken))) return;
			harnessLog.trace("fleet", "a fleet resource changed; selection runs", { keys: keys.join(",") });
			try {
				this.local?.drain();
			} catch (error) {
				harnessLog.error("fleet", "a fleet wake could not run selection", () => ({
					error: error instanceof Error ? error.name : "unknown",
				}));
			}
			for (const woken of keys) if (!this.waits.waiting(woken)) this.settleEpisode(woken);
		});
	}

	private settleEpisode(key: string): void {
		this.ceilingEpisodes.delete(key);
		const recheck = this.rechecks.get(key);
		if (recheck && !recheck.alarm) this.rechecks.delete(key);
	}

	/** Bumps the room revision, schedules the restart metadata write and the room subscribers' check. */
	private changed(): void {
		if (this.disposed) return;
		this.revision += 1;
		for (const key of this.ceilingEpisodes) if (!this.waits.waiting(key)) this.settleEpisode(key);
		this.store.schedule(() => this.metadata());
		if (this.roomNotifyPending || this.roomSubscribers.size === 0) return;
		this.roomNotifyPending = true;
		queueMicrotask(() => {
			this.roomNotifyPending = false;
			for (const subscriber of [...this.roomSubscribers]) {
				const snapshot = this.room(subscriber.query);
				const now = snapshot.runnableNow;
				const last = subscriber.last;
				const crossed = (last === 0) !== (now === 0) || (last > 0 && (now >= 2 * last || now <= last / 2));
				if (!crossed) continue;
				subscriber.last = now;
				try {
					subscriber.onChange(snapshot);
				} catch {
					// A subscriber's failure never stops the others from hearing the room change.
				}
			}
		});
	}

	private metadata() {
		const entries: FleetQueueMetadataEntry[] = [];
		for (const entry of this.queue?.ordered() ?? []) {
			const wait = this.lastWait.get(entry.id);
			entries.push({
				id: entry.id,
				objectiveId: entry.objectiveId,
				subtreeId: entry.subtreeId,
				priority: entry.priority,
				enqueuedAt: entry.enqueuedAt,
				...(wait ? { lastReason: wait.key } : {}),
				...(wait?.retryAt !== undefined ? { retryAt: wait.retryAt } : {}),
			});
		}
		return { v: 1 as const, stopped: this.stopped, entries };
	}
}
