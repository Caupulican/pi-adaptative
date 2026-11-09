/**
 * The cost term of the room formula: dollars bound only metered (API-key) work. A subscription login is quota, governed
 * by its allowance and the provider's refusals, never by dollars; a model without a price (a local runtime) costs none.
 *
 * - Budgets: `fleet.budgets.meteredUsdPerDay` (local calendar day) and `.meteredUsdPerGoal`, 0 meaning unbounded. Room is
 *   floor((limit - spent - reserved) / estimate) for each bounded budget, the smaller binding.
 * - Reservation and settlement: a metered worker reserves its estimate when it starts and settles its measured cost
 *   (the attempt's usage) when its run ends, the reservation released either way (`RequestSpendBudget` semantics at
 *   fleet scope). The estimate is the model's price times the node's estimated tokens when the planner states them,
 *   otherwise the running average of the model's settled worker costs, seeded by its price for a conservative token
 *   count until one settles.
 * - Spend-rate brake: new metered starts pause while the current 15-minute window's metered spend exceeds
 *   max(`fleet.brake.minUsd`, 3 x the trailing 7-day 95th percentile of 15-minute windows). It lifts when the next window
 *   begins under the line, or when the owner lifts an emergency stop. Subscription work continues and nothing running is stopped.
 *
 * Settled spend is machine-wide (`state/fleet/spend.json`, merged additively under its lock): a day budget bounds the
 * day's fleet spend across every pi process on the agent directory. Reservations are this process's own.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Api, Model } from "@caupulican/pi-ai";
import { harnessLog } from "../../../kernel/harness-log.ts";
import { isPlainRecord } from "../../util/value-guards.ts";
import { FleetSharedState } from "../fleet-shared-state.ts";
import type { RoomTerm } from "../fleet-types.ts";

export const SPEND_WINDOW_MS = 15 * 60_000;
/** Seven days of 15-minute windows. */
const SPEND_HISTORY_WINDOWS = 672;
const BRAKE_PERCENTILE = 0.95;
const BRAKE_MULTIPLE = 3;
/** Goals whose spend the shared file keeps; the least recently charged beyond it are dropped. */
const MAX_GOAL_RECORDS = 256;
/** The token counts the estimate prices before any worker on the model settled: conservative, replaced by the average. */
const SEED_INPUT_TOKENS = 200_000;
const SEED_OUTPUT_TOKENS = 10_000;
/** The share of a stated token estimate priced as output. */
const ESTIMATED_OUTPUT_SHARE = 0.05;
/** Weight of the newest settled cost in a model's running average. */
const ESTIMATE_SMOOTHING = 0.3;

export interface MeteredBudgetSettings {
	readonly meteredUsdPerDay: number;
	readonly meteredUsdPerGoal: number;
	readonly brakeMinUsd: number;
}

/** A metered reservation held machine-wide: the estimate, the goal it counts against, and the instance that holds it. */
interface ReservationRecord {
	readonly usd: number;
	readonly objectiveId?: string;
	/** The random id of the MeteredSpend instance that made it; a live instance of this process owns the record. */
	readonly holder: string;
	/** The process that made it, which decides liveness for a holder outside this process. */
	readonly pid: number;
	readonly at: number;
}

/** The longest a metered worker may hold a reservation; an older record is void whoever holds it (a hung or reused-pid holder). */
const MAX_RESERVATION_AGE_MS = 6 * 60 * 60_000;

/** The holder ids of every MeteredSpend alive in this process. */
const liveHolders = new Set<string>();

/** Whether another process is still running on this machine (a crashed holder's reservation is void). */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

interface SpendFile {
	readonly v: 1;
	readonly day: string;
	readonly dayUsd: number;
	readonly goals: Readonly<Record<string, { readonly usd: number; readonly updatedAt: number }>>;
	/** [window start, usd], newest last, at most seven days. */
	readonly windows: readonly (readonly [number, number])[];
	/** Reservations held by every live process on the machine, keyed by attempt. */
	readonly reservations: Readonly<Record<string, ReservationRecord>>;
}

interface Reservation {
	readonly modelRef: string;
	readonly usd: number;
	readonly objectiveId?: string;
}

export interface MeteredSpendOptions {
	readonly agentDir: string;
	now(): number;
	settings(): MeteredBudgetSettings;
	/** The brake engaged (with the owner's plain words) or lifted. */
	onBrake?(state: { readonly engaged: true; readonly text: string } | { readonly engaged: false }): void;
}

/** One spend cost the room is computed for. */
export interface CostRoomInput {
	readonly estimateUsd: number;
	readonly objectiveId?: string;
}

function localDay(at: number): string {
	const date = new Date(at);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function nextLocalMidnight(at: number): number {
	const date = new Date(at);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function windowStart(at: number): number {
	return Math.floor(at / SPEND_WINDOW_MS) * SPEND_WINDOW_MS;
}

function usd(value: number): string {
	return `$${value.toFixed(2)}`;
}

function parseSpendFile(value: unknown): SpendFile | undefined {
	if (!isPlainRecord(value) || value.v !== 1 || typeof value.day !== "string") return undefined;
	if (typeof value.dayUsd !== "number" || !Number.isFinite(value.dayUsd)) return undefined;
	const goals: Record<string, { usd: number; updatedAt: number }> = {};
	if (isPlainRecord(value.goals))
		for (const [id, raw] of Object.entries(value.goals))
			if (isPlainRecord(raw) && typeof raw.usd === "number" && typeof raw.updatedAt === "number")
				goals[id] = { usd: raw.usd, updatedAt: raw.updatedAt };
	const windows = Array.isArray(value.windows)
		? value.windows.flatMap((raw): (readonly [number, number])[] =>
				Array.isArray(raw) && typeof raw[0] === "number" && typeof raw[1] === "number" ? [[raw[0], raw[1]]] : [],
			)
		: [];
	const reservations: Record<string, ReservationRecord> = {};
	if (isPlainRecord(value.reservations))
		for (const [attemptId, raw] of Object.entries(value.reservations))
			if (
				isPlainRecord(raw) &&
				typeof raw.usd === "number" &&
				typeof raw.holder === "string" &&
				typeof raw.pid === "number" &&
				typeof raw.at === "number"
			)
				reservations[attemptId] = {
					usd: raw.usd,
					holder: raw.holder,
					pid: raw.pid,
					at: raw.at,
					...(typeof raw.objectiveId === "string" ? { objectiveId: raw.objectiveId } : {}),
				};
	return { v: 1, day: value.day, dayUsd: value.dayUsd, goals, windows, reservations };
}

export class MeteredSpend {
	private readonly options: MeteredSpendOptions;
	private readonly file: FleetSharedState<SpendFile>;
	private state: SpendFile;
	/** Settled spend not yet merged into the shared file. */
	private pending: { dayUsd: number; day: string; goals: Map<string, number>; windows: Map<number, number> };
	/** This process's live reservations; the shared file holds every process's, and this map is their own copy. */
	private readonly reservations = new Map<string, Reservation>();
	/** Reservations this instance made that the shared file does not hold yet, and attempts it released. */
	private readonly pendingReservations = new Map<string, ReservationRecord>();
	private readonly pendingReleases = new Set<string>();
	/** The merge the shared file was last asked to hold: it becomes this instance's state only once the write succeeds. */
	private candidate: SpendFile | undefined;
	/** Identifies this instance's reservations in the shared file; alive while the instance is not closed. */
	private readonly holder = randomUUID();
	private readonly averages = new Map<string, number>();
	private brakeWindow: number | undefined;

	constructor(options: MeteredSpendOptions) {
		this.options = options;
		liveHolders.add(this.holder);
		this.file = new FleetSharedState(join(options.agentDir, "state", "fleet", "spend.json"), "spend", parseSpendFile);
		const day = localDay(options.now());
		this.state = { v: 1, day, dayUsd: 0, goals: {}, windows: [], reservations: {} };
		this.pending = { dayUsd: 0, day, goals: new Map(), windows: new Map() };
		this.adoptDisk();
	}

	/** What a worker on `model` is expected to cost; 0 when the model has no price. */
	estimate(model: Model<Api>, estimatedTokens: number | undefined): number {
		const input = model.cost?.input ?? 0;
		const output = model.cost?.output ?? 0;
		if (input <= 0 && output <= 0) return 0;
		if (estimatedTokens !== undefined && estimatedTokens > 0)
			return (estimatedTokens * input + estimatedTokens * ESTIMATED_OUTPUT_SHARE * output) / 1_000_000;
		return (
			this.averages.get(`${model.provider}/${model.id}`) ??
			(SEED_INPUT_TOKENS * input + SEED_OUTPUT_TOKENS * output) / 1_000_000
		);
	}

	/**
	 * The cost term for one more metered worker, or undefined when nothing binds (no bounded budget and no brake). The
	 * brake waits on `budget:brake` until its window ends; an exhausted day budget waits on `budget:day` until local
	 * midnight; an exhausted goal budget waits on `budget:goal:<id>` with no reopen time (it does not reset).
	 */
	term(input: CostRoomInput): RoomTerm | undefined {
		this.adoptDisk();
		const now = this.options.now();
		const settings = this.options.settings();
		this.updateBrake(now, settings);
		if (this.brakeWindow !== undefined)
			return {
				reason: "cost_budget",
				room: 0,
				waitKey: "budget:brake",
				retryAt: this.brakeWindow + SPEND_WINDOW_MS,
				detail: "new paid (API-key) work is paused by the spend-rate brake",
			};
		const estimate = Math.max(input.estimateUsd, Number.EPSILON);
		const terms: RoomTerm[] = [];
		if (settings.meteredUsdPerDay > 0) {
			const remaining = settings.meteredUsdPerDay - this.daySpent(now) - this.reservedTotal();
			terms.push({
				reason: "cost_budget",
				room: Math.max(0, Math.floor(remaining / estimate)),
				waitKey: "budget:day",
				retryAt: nextLocalMidnight(now),
				detail: `today's paid (API-key) worker budget of ${usd(settings.meteredUsdPerDay)} is used up`,
			});
		}
		if (settings.meteredUsdPerGoal > 0 && input.objectiveId) {
			const remaining =
				settings.meteredUsdPerGoal - this.goalSpent(input.objectiveId) - this.reservedFor(input.objectiveId);
			terms.push({
				reason: "cost_budget",
				room: Math.max(0, Math.floor(remaining / estimate)),
				waitKey: `budget:goal:${input.objectiveId}`,
				detail: `this goal's paid (API-key) worker budget of ${usd(settings.meteredUsdPerGoal)} is used up`,
			});
		}
		return terms.sort((a, b) => a.room - b.room)[0];
	}

	/** A metered worker started: its estimate is held against the budgets until it settles. */
	reserve(attemptId: string, reservation: Reservation): void {
		this.reservations.set(attemptId, reservation);
		this.pendingReleases.delete(attemptId);
		this.pendingReservations.set(attemptId, {
			usd: reservation.usd,
			...(reservation.objectiveId ? { objectiveId: reservation.objectiveId } : {}),
			holder: this.holder,
			pid: process.pid,
			at: this.options.now(),
		});
		this.persist();
	}

	/** Ends this instance: its reservations are released by the claims that held them; it is no longer a live holder. */
	close(): void {
		liveHolders.delete(this.holder);
	}

	/** A metered worker's run ended: its reservation is released and its measured cost charged. */
	settle(attemptId: string, measuredUsd: number | undefined): void {
		const reservation = this.reservations.get(attemptId);
		if (!reservation) return;
		this.reservations.delete(attemptId);
		this.pendingReservations.delete(attemptId);
		this.pendingReleases.add(attemptId);
		this.persist();
		const spent = measuredUsd !== undefined && Number.isFinite(measuredUsd) && measuredUsd > 0 ? measuredUsd : 0;
		const previous = this.averages.get(reservation.modelRef);
		this.averages.set(
			reservation.modelRef,
			previous === undefined ? spent : (1 - ESTIMATE_SMOOTHING) * previous + ESTIMATE_SMOOTHING * spent,
		);
		if (spent === 0) return;
		const now = this.options.now();
		const day = localDay(now);
		if (this.pending.day !== day) this.pending = { dayUsd: 0, day, goals: new Map(), windows: new Map() };
		this.pending.dayUsd += spent;
		if (reservation.objectiveId)
			this.pending.goals.set(
				reservation.objectiveId,
				(this.pending.goals.get(reservation.objectiveId) ?? 0) + spent,
			);
		const start = windowStart(now);
		this.pending.windows.set(start, (this.pending.windows.get(start) ?? 0) + spent);
		this.persist();
		harnessLog.debug("fleet", "a metered worker's spend is settled", () => ({ attemptId, usd: spent }));
		this.updateBrake(now, this.options.settings());
	}

	/** The owner's resume lifts the brake until the spend crosses the line again in a later window. */
	liftBrake(): void {
		if (this.brakeWindow === undefined) return;
		this.brakeWindow = undefined;
		harnessLog.info("fleet", "the spend-rate brake was lifted by the owner's resume");
		this.options.onBrake?.({ engaged: false });
	}

	isBraked(): boolean {
		return this.brakeWindow !== undefined;
	}

	/** Today's settled metered fleet spend across the machine, for a status view. */
	daySpent(now = this.options.now()): number {
		const day = localDay(now);
		return (this.state.day === day ? this.state.dayUsd : 0) + (this.pending.day === day ? this.pending.dayUsd : 0);
	}

	private goalSpent(objectiveId: string): number {
		return (this.state.goals[objectiveId]?.usd ?? 0) + (this.pending.goals.get(objectiveId) ?? 0);
	}

	/** Every live reservation on the machine: other processes' from the shared file, this instance's own. */
	private liveReservations(): Map<string, ReservationRecord> {
		const now = this.options.now();
		const live = new Map<string, ReservationRecord>();
		for (const [attemptId, record] of Object.entries(this.state.reservations))
			if (this.holds(attemptId, record, now)) live.set(attemptId, record);
		for (const [attemptId, reservation] of this.reservations)
			live.set(attemptId, {
				usd: reservation.usd,
				...(reservation.objectiveId ? { objectiveId: reservation.objectiveId } : {}),
				holder: this.holder,
				pid: process.pid,
				at: now,
			});
		return live;
	}

	/**
	 * Whether a shared record still holds its budget. Released attempts never do; a record older than the worker lifetime
	 * never does. A record of an instance alive in this process holds while that instance still reserves the attempt; a
	 * record of another process holds only while that process runs. An unknown holder of this process is void.
	 */
	private holds(attemptId: string, record: ReservationRecord, now: number): boolean {
		if (this.pendingReleases.has(attemptId) || now - record.at > MAX_RESERVATION_AGE_MS) return false;
		if (liveHolders.has(record.holder)) return record.holder !== this.holder || this.reservations.has(attemptId);
		return record.pid !== process.pid && processAlive(record.pid);
	}

	/** Schedules this instance's merge; the pending state is dropped only once the shared file holds it. */
	private persist(): void {
		this.file.schedule(
			(disk) => this.merge(disk),
			() => this.committed(),
		);
	}

	/** Runs once a merge reached the shared file: what it carried is no longer pending. */
	private committed(): void {
		if (this.candidate) this.state = this.candidate;
		this.candidate = undefined;
		this.pendingReservations.clear();
		this.pendingReleases.clear();
		this.pending = { dayUsd: 0, day: this.pending.day, goals: new Map(), windows: new Map() };
	}

	private reservedTotal(): number {
		let total = 0;
		for (const reservation of this.liveReservations().values()) total += reservation.usd;
		return total;
	}

	private reservedFor(objectiveId: string): number {
		let total = 0;
		for (const reservation of this.liveReservations().values())
			if (reservation.objectiveId === objectiveId) total += reservation.usd;
		return total;
	}

	private windowSpent(start: number): number {
		const stored = this.state.windows.find(([at]) => at === start)?.[1] ?? 0;
		return stored + (this.pending.windows.get(start) ?? 0);
	}

	/** The brake line: the floor, or three times the trailing week's 95th-percentile window, whichever is larger. */
	private brakeLine(current: number, minUsd: number): number {
		const since = current - SPEND_HISTORY_WINDOWS * SPEND_WINDOW_MS;
		const values = this.state.windows.filter(([at]) => at >= since && at < current).map(([, spent]) => spent);
		const padded = [...values, ...new Array<number>(Math.max(0, SPEND_HISTORY_WINDOWS - values.length)).fill(0)].sort(
			(a, b) => a - b,
		);
		const p95 = padded[Math.ceil(BRAKE_PERCENTILE * padded.length) - 1] ?? 0;
		return Math.max(minUsd, BRAKE_MULTIPLE * p95);
	}

	private updateBrake(now: number, settings: MeteredBudgetSettings): void {
		const current = windowStart(now);
		if (this.brakeWindow !== undefined && this.brakeWindow !== current) {
			this.brakeWindow = undefined;
			harnessLog.info("fleet", "the spend-rate brake lifted: a new spend window began under the line");
			this.options.onBrake?.({ engaged: false });
		}
		if (this.brakeWindow !== undefined) return;
		const spent = this.windowSpent(current);
		const line = this.brakeLine(current, settings.brakeMinUsd);
		if (!(spent > line)) return;
		this.brakeWindow = current;
		harnessLog.warn("fleet", "the spend-rate brake paused new paid worker starts", () => ({
			windowUsd: Number(spent.toFixed(4)),
			lineUsd: Number(line.toFixed(4)),
		}));
		this.options.onBrake?.({
			engaged: true,
			text: `Workers paused new paid (API-key) starts: ${usd(spent)} was spent in the last 15 minutes, above the ${usd(line)} safety line. Subscription work continues and running workers finish. Paid starts resume when the next 15-minute window begins, or when an emergency stop on this machine is lifted with /estop off.`,
		});
	}

	private merge(disk: SpendFile | undefined): SpendFile {
		const day = this.pending.day;
		const base = disk ?? this.state;
		const sameDay = base.day === day;
		const goals = new Map(Object.entries(base.goals));
		const now = this.options.now();
		for (const [id, spent] of this.pending.goals)
			goals.set(id, { usd: (goals.get(id)?.usd ?? 0) + spent, updatedAt: now });
		const windows = new Map(base.windows.map(([at, spent]) => [at, spent] as const));
		for (const [at, spent] of this.pending.windows) windows.set(at, (windows.get(at) ?? 0) + spent);
		const since = windowStart(now) - SPEND_HISTORY_WINDOWS * SPEND_WINDOW_MS;
		const reservations: Record<string, ReservationRecord> = {};
		for (const [attemptId, record] of Object.entries(base.reservations ?? {}))
			if (this.holds(attemptId, record, now)) reservations[attemptId] = record;
		for (const [attemptId, record] of this.pendingReservations) reservations[attemptId] = record;
		const merged: SpendFile = {
			reservations,
			v: 1,
			day,
			dayUsd: (sameDay ? base.dayUsd : 0) + this.pending.dayUsd,
			goals: Object.fromEntries(
				[...goals.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, MAX_GOAL_RECORDS),
			),
			windows: [...windows.entries()].filter(([at]) => at >= since).sort((a, b) => a[0] - b[0]),
		};
		this.candidate = merged;
		return merged;
	}

	private adoptDisk(): void {
		const disk = this.file.readIfChanged();
		if (disk) this.state = disk;
	}
}
