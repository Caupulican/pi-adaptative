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
 * so ordering, restart metadata and the room snapshot share one owner. Stop and resume are session-scoped and survive a
 * restart through `FleetQueueStore`; the stop machine is observed in the kernel's machine registry.
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
import { FleetQueue } from "./fleet-queue.ts";
import { type FleetQueueMetadataEntry, FleetQueueStore, fleetQueueMetadataPath } from "./fleet-queue-store.ts";
import type {
	AdmitDecision,
	FleetDispatch,
	FleetRoomDecision,
	FleetScheduler,
	FleetScope,
	RoomQuery,
	RoomSnapshot,
	RoomTerm,
	ShareSpec,
} from "./fleet-types.ts";
import { FleetWaitSets } from "./fleet-wait-sets.ts";

/** First recheck of a machine or unstated-reset allowance wait with nothing running; doubles up to the cap. */
export const FLEET_RECHECK_INITIAL_MS = 30_000;
export const FLEET_RECHECK_MAX_MS = 5 * 60_000;
/** Idempotent admit decisions kept per session. */
const ADMIT_DECISION_LIMIT = 1024;

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
}

/** One local dispatch's room question: the model whose account it runs on, and whether it writes. */
export interface LocalRoomInput {
	readonly laneId?: string;
	readonly model?: Model<Api>;
	readonly writes: boolean;
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
	private readonly lastWait = new Map<string, { key: string; retryAt?: number }>();
	private readonly alarms = new Map<string, WallAlarm & { readonly at: number }>();
	private readonly rechecks = new Map<string, Recheck>();
	private readonly ceilingEpisodes = new Set<string>();
	private readonly pendingWakes = new Set<string>();
	private readonly observer = observeMachine(FLEET_STOP_MACHINE);
	private readonly unregisterMachine: () => void;
	private readonly unsubscribeAllowance: (() => void) | undefined;
	private local: FleetLocalPort | undefined;
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
		const metadata = this.store.load();
		if (metadata) {
			for (const entry of metadata.entries) this.restored.set(entry.id, entry);
			if (metadata.stopped) {
				this.stopped = true;
				this.observer.record("running", "stopped", "restored");
			}
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
	}

	/** Binds the worker controller that runs local lanes; the returned function unbinds it. */
	bindLocal(port: FleetLocalPort): () => void {
		this.local = port;
		return () => {
			if (this.local === port) this.local = undefined;
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
		const memoKey = `${running}|${writers}|${input.writes}|${input.model ? `${input.model.provider}/${input.model.id}` : ""}`;
		let decision = pass.decisions.get(memoKey);
		if (!decision) {
			decision = decideRoom(this.localTerms(input, running, writers));
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

	/** A local lane starts now (every start, queued or direct, reports here once its attempt is prepared). */
	noteAdmitted(laneId: string): void {
		this.waits.release(laneId);
		this.lastWait.delete(laneId);
		harnessLog.debug("fleet", "a node is admitted", () => ({
			laneId,
			running: this.local?.runningCount() ?? 0,
		}));
		this.changed();
	}

	/** A local attempt's run ended: its slot is free again (the controller drains on the same terminal). */
	noteReleased(attemptId: string): void {
		this.yields.delete(attemptId);
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
		this.pass = undefined;
		this.changed();
		this.wake("fleet:stop");
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
			perAccount: [...this.accountReadings.values()].map((reading) => {
				const term = allowanceRoomTerm(reading);
				return {
					accountKey: reading.accountKey,
					room: term.room,
					...(term.retryAt !== undefined ? { retryAt: term.retryAt } : {}),
				};
			}),
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
		this.unregisterMachine();
		this.roomSubscribers.clear();
		this.local = undefined;
	}

	// ---- internals ----

	private decideAdmit(dispatch: FleetDispatch, placement: Placement): AdmitDecision {
		if (dispatch.escalation) {
			const original = this.deps.escalationAuthorityDigest?.(dispatch.escalation.outcomeId);
			if (original !== dispatch.escalation.authorityDigest)
				return {
					kind: "refused",
					reason: "authority_digest_mismatch",
					blocker: "owner_authority_required",
					detail: "the escalation's authority differs from its original attempt's",
				};
		}
		const key = placementCapacityKey(placement);
		if (key === undefined)
			return {
				kind: "refused",
				reason: "placement",
				blocker: "placement_unreachable",
				detail: "a local placement starts through the worker controller's own start path",
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

	private localTerms(input: LocalRoomInput, running: number, writers: number): RoomTerm[] {
		const settings = this.deps.settings();
		const terms: RoomTerm[] = [];
		if (this.stopped)
			terms.push({ reason: "fleet_stopped", room: 0, waitKey: "fleet:stop", detail: "the fleet is stopped" });
		terms.push(ceilingTerm("running", running, settings.ceiling.running));
		if (input.writes) terms.push(ceilingTerm("writers", writers, settings.ceiling.writers));
		if (input.model && this.deps.allowance) terms.push(allowanceRoomTerm(this.readAllowance(input.model)));
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

	private armAlarm(key: string, at: number): void {
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
