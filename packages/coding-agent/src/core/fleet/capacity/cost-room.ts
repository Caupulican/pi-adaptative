/**
 * The cost term of the room formula: dollars bound only metered (API-key) work. A subscription login is quota, governed
 * by its allowance and the provider's refusals, never by dollars; a model without a price (a local runtime) costs none.
 *
 * - Budgets: `fleet.budgets.meteredUsdPerDay` (local calendar day) and `.meteredUsdPerGoal`, 0 meaning unbounded. Room is
 *   floor((limit - spent - reserved) / estimate) for each bounded budget, the smaller binding.
 * - Reservation and charge: a metered worker reserves its estimate when it starts and charges its measured cost (the
 *   attempt's cumulative usage, less what the attempt was already charged) when its run ends, the reservation released
 *   either way (`RequestSpendBudget` semantics at fleet scope). The estimate is the model's price times the node's
 *   estimated tokens when the planner states them, otherwise the running average of the model's charged worker costs,
 *   seeded by its price for a conservative token count until one settles.
 * - Spend-rate brake: new metered starts pause while the current 15-minute window's metered spend exceeds
 *   max(`fleet.brake.minUsd`, 3 x the trailing 7-day 95th percentile of 15-minute windows). It lifts when the next window
 *   begins under the line, or when the owner continues held work with `/estop off`, which keeps it lifted for the rest of
 *   that window. Subscription work continues and nothing running is stopped.
 *
 * Settled spend and reservations are machine-wide (`state/fleet/spend.json`, merged additively under its lock): a day
 * budget bounds the day's fleet spend across every pi process on the agent directory, and a reservation counts while its
 * holder is alive (`shared-holder.ts`).
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Api, Model } from "@caupulican/pi-ai";
import { harnessLog } from "../../../kernel/harness-log.ts";
import { isPlainRecord } from "../../util/value-guards.ts";
import { FleetSharedState } from "../fleet-shared-state.ts";
import type { RoomTerm } from "../fleet-types.ts";
import { addLiveHolder, type HolderRecord, holderAlive, removeLiveHolder } from "../shared-holder.ts";

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

/** A metered reservation held machine-wide: the estimate and the goal it counts against, with its holder (`HolderRecord`). */
interface ReservationRecord extends HolderRecord {
	readonly usd: number;
	readonly objectiveId?: string;
}

/** The longest a metered worker may hold a reservation; an older record is void whoever holds it (a hung or reused-pid holder). */
const MAX_RESERVATION_AGE_MS = 6 * 60 * 60_000;
/** Charged attempts kept in the shared file. Past it, a terminal attempt's record goes first, oldest first. */
const MAX_SETTLED_RECORDS = 4096;

/**
 * The cumulative measured cost already charged for one attempt, when it was last charged, and whether the attempt had
 * ended by then (a terminal attempt is never charged again, so its record is the first to go).
 */
interface SettledRecord {
	readonly usd: number;
	readonly at: number;
	readonly terminal?: boolean;
}

/** One charge made by this process, merged into the shared file under its lock against the record the file holds then. */
interface PendingCharge {
	readonly attemptId: string;
	readonly cumulative: number;
	readonly at: number;
	readonly terminal: boolean;
	readonly objectiveId?: string;
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
	/** Per attempt, the cumulative cost charged so far, machine-wide: a resumed attempt is charged only its growth. */
	readonly settled?: Readonly<Record<string, SettledRecord>>;
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

/**
 * The charged-attempt records the shared file keeps. A record of an attempt that has not ended may still be charged, so it is
 * kept; past the bound, a terminal attempt's record goes first, oldest first.
 */
function boundSettled(settled: ReadonlyMap<string, SettledRecord>): Record<string, SettledRecord> {
	const newestFirst = [...settled.entries()].sort((a, b) => b[1].at - a[1].at);
	return Object.fromEntries(
		[
			...newestFirst.filter(([, record]) => !record.terminal),
			...newestFirst.filter(([, record]) => record.terminal),
		].slice(0, MAX_SETTLED_RECORDS),
	);
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
	const settled: Record<string, SettledRecord> = {};
	if (isPlainRecord(value.settled))
		for (const [attemptId, raw] of Object.entries(value.settled))
			if (isPlainRecord(raw) && typeof raw.usd === "number" && typeof raw.at === "number")
				if (Number.isFinite(raw.usd) && Number.isFinite(raw.at))
					settled[attemptId] = { usd: raw.usd, at: raw.at, ...(raw.terminal === true ? { terminal: true } : {}) };
	return { v: 1, day: value.day, dayUsd: value.dayUsd, goals, windows, reservations, settled };
}

export class MeteredSpend {
	private readonly options: MeteredSpendOptions;
	private readonly file: FleetSharedState<SpendFile>;
	private state: SpendFile;
	/** Settled spend not yet merged into the shared file. */
	private pending: { dayUsd: number; day: string; goals: Map<string, number>; windows: Map<number, number> };
	/** Charges made here and not yet written: each is settled against the file's own record when the file is merged. */
	private pendingCharges: PendingCharge[] = [];
	/** The charges the last merge carried; the commit removes exactly these, so a charge made while the write runs waits. */
	private mergedCharges: readonly PendingCharge[] = [];
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
	/** The window the owner's continue last lifted the brake in: the brake does not re-engage in that window. */
	private liftedWindow: number | undefined;

	constructor(options: MeteredSpendOptions) {
		this.options = options;
		addLiveHolder(this.holder);
		this.file = new FleetSharedState(join(options.agentDir, "state", "fleet", "spend.json"), "spend", parseSpendFile);
		const day = localDay(options.now());
		this.state = { v: 1, day, dayUsd: 0, goals: {}, windows: [], reservations: {}, settled: {} };
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
		removeLiveHolder(this.holder);
	}

	/**
	 * A metered worker's run ended: its reservation is released, and its cumulative measured cost is charged. Only the part
	 * not already charged to the machine counts, so a suspended and resumed attempt is charged once for each part of its cost.
	 * The machine's part is computed when the shared file is merged, under its lock; this process's view counts it here.
	 * `terminal` says the attempt has ended, so its record may be evicted first.
	 */
	charge(
		attemptId: string,
		cumulativeUsd: number | undefined,
		objectiveId: string | undefined,
		terminal = false,
	): void {
		this.adoptDisk();
		const reservation = this.reservations.get(attemptId);
		if (reservation) {
			this.reservations.delete(attemptId);
			this.pendingReservations.delete(attemptId);
			this.pendingReleases.add(attemptId);
			this.persist();
		}
		const cumulative =
			cumulativeUsd !== undefined && Number.isFinite(cumulativeUsd) && cumulativeUsd > 0 ? cumulativeUsd : 0;
		const pendingCumulative = this.pendingCharges.filter((charge) => charge.attemptId === attemptId).at(-1);
		const already = Math.max(this.state.settled?.[attemptId]?.usd ?? 0, pendingCumulative?.cumulative ?? 0);
		const delta = cumulative - already;
		if (reservation) {
			const spent = Math.max(0, delta);
			const previous = this.averages.get(reservation.modelRef);
			this.averages.set(
				reservation.modelRef,
				previous === undefined ? spent : (1 - ESTIMATE_SMOOTHING) * previous + ESTIMATE_SMOOTHING * spent,
			);
		}
		if (delta <= 0) return;
		const now = this.options.now();
		const goal = objectiveId ?? reservation?.objectiveId;
		this.pendingCharges.push({
			attemptId,
			cumulative,
			at: now,
			terminal,
			...(goal ? { objectiveId: goal } : {}),
		});
		const day = localDay(now);
		if (this.pending.day !== day) this.pending = { dayUsd: 0, day, goals: new Map(), windows: new Map() };
		this.pending.dayUsd += delta;
		if (goal) this.pending.goals.set(goal, (this.pending.goals.get(goal) ?? 0) + delta);
		const start = windowStart(now);
		this.pending.windows.set(start, (this.pending.windows.get(start) ?? 0) + delta);
		this.persist();
		harnessLog.debug("fleet", "a metered worker's spend is charged", () => ({ attemptId, usd: delta }));
		this.updateBrake(now, this.options.settings());
	}

	/**
	 * The owner's continue lifts the brake until the spend crosses the line again in a later window, and keeps it lifted for
	 * the current window: it does not re-engage in the window it was lifted in.
	 */
	liftBrake(): void {
		this.liftedWindow = windowStart(this.options.now());
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
	 * Whether a shared record still holds its budget. Released attempts never do. A record whose holder is alive (this
	 * process's instance, or another process that runs) holds; a record of this instance holds only while it still reserves
	 * the attempt.
	 */
	private holds(attemptId: string, record: ReservationRecord, now: number): boolean {
		return (
			!this.pendingReleases.has(attemptId) &&
			holderAlive(record, now, MAX_RESERVATION_AGE_MS) &&
			(record.holder !== this.holder || this.reservations.has(attemptId))
		);
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
		this.pendingCharges = this.pendingCharges.filter((charge) => !this.mergedCharges.includes(charge));
		this.mergedCharges = [];
		this.pending = { dayUsd: 0, day: this.pending.day, goals: new Map(), windows: new Map() };
		this.updateBrake(this.options.now(), this.options.settings());
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
		if (this.liftedWindow === current || this.brakeWindow !== undefined) return;
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
			text: `Workers paused new paid (API-key) starts: ${usd(spent)} was spent in the last 15 minutes, above the ${usd(line)} safety line. Subscription work continues and running workers finish. Paid starts resume when the next 15-minute window begins, or now with /estop off.`,
		});
	}

	private merge(disk: SpendFile | undefined): SpendFile {
		const base = disk ?? this.state;
		const now = this.options.now();
		const goals = new Map(Object.entries(base.goals));
		const windows = new Map(base.windows.map(([at, spent]) => [at, spent] as const));
		const settled = new Map<string, SettledRecord>(Object.entries(base.settled ?? {}));
		let day = base.day;
		let dayUsd = base.dayUsd;
		// Each charge counts what the file has not charged its attempt yet, read here under the file's lock. The amount that
		// lands goes to the day, goal and window the charge was made in, so two processes charging one attempt never both count it.
		this.mergedCharges = [...this.pendingCharges];
		for (const charge of this.mergedCharges) {
			const delta = charge.cumulative - (settled.get(charge.attemptId)?.usd ?? 0);
			if (delta <= 0) continue;
			settled.set(charge.attemptId, { usd: charge.cumulative, at: charge.at, terminal: charge.terminal });
			const chargeDay = localDay(charge.at);
			if (chargeDay > day) {
				day = chargeDay;
				dayUsd = 0;
			}
			if (chargeDay === day) dayUsd += delta;
			if (charge.objectiveId)
				goals.set(charge.objectiveId, { usd: (goals.get(charge.objectiveId)?.usd ?? 0) + delta, updatedAt: now });
			const start = windowStart(charge.at);
			windows.set(start, (windows.get(start) ?? 0) + delta);
		}
		const since = windowStart(now) - SPEND_HISTORY_WINDOWS * SPEND_WINDOW_MS;
		const reservations: Record<string, ReservationRecord> = {};
		for (const [attemptId, record] of Object.entries(base.reservations ?? {}))
			if (this.holds(attemptId, record, now)) reservations[attemptId] = record;
		for (const [attemptId, record] of this.pendingReservations) reservations[attemptId] = record;
		const merged: SpendFile = {
			reservations,
			settled: boundSettled(settled),
			v: 1,
			day,
			dayUsd,
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
