/**
 * The watches one session armed for its own work, kept beside the session's transcript in `<session>.watches.json`: a file
 * of its own, with its own version, that no older build lists (they list a session directory by `.jsonl`). Each record is
 * one one-shot watch: what it waits on, the plan its armer saved, who armed it (the session under a turn's authority, or a
 * worker runtime under its lane's scope), the edge cursor the monitor advances, how it ended, and the wakes its armer is
 * owed, each with the delivery id a redelivery reuses. A wake's words are a pure function of the record, so a restart
 * delivers the same input.
 *
 * The codec is strict: a record this build cannot read (another kind, a newer field) is set aside and written back as it
 * was, never dropped or rewritten; a file a newer build wrote is never overwritten (this build keeps its own watches in
 * memory); a file that is not a ledger at all is moved aside under a name of its own. Ended watches are kept until seven
 * days after the session last closed, and at most {@link MAX_ENDED_SESSION_WATCHES} of them; one whose wake is not
 * delivered yet is always kept. A session with no transcript file keeps its ledger in memory.
 */
import { readFileSync, renameSync } from "node:fs";
import {
	isRoutineId,
	MAX_ROUTINE_PROMPT_CHARS,
	parseRoutineCursor,
	type RoutineCursor,
} from "../routines/routine-contract.ts";
import { boundedRoutineText } from "../routines/routine-field-guards.ts";
import { WATCH_LAST_SEEN, type WatchLastSeen } from "../routines/routine-watch-edge.ts";
import type { WatchFailing, WatchFailingCause } from "../routines/routine-watch-monitor.ts";
import {
	parseWatchCondition,
	parseWatchFiredEvent,
	type WatchCondition,
	type WatchFiredEvent,
} from "../routines/watch-contract.ts";
import { parseWorkerWatchScope, type WorkerWatchScope } from "../routines/worker-watch-scope.ts";
import type { TurnAuthority } from "../turn-origin.ts";
import { atomicFileFamily, isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import {
	type GithubWatchResult,
	type GithubWatchSource,
	isGithubWatchSource,
	parseGithubWatchResult,
	parseGithubWatchSource,
} from "./github-watch-source.ts";

export const SESSION_WATCH_LEDGER_VERSION = 1;
/** The ledger's suffix beside a session's transcript; no reader of a session directory lists it. */
export const SESSION_WATCH_LEDGER_SUFFIX = ".watches.json";
/** Most ended watches a session keeps; the newest are kept. */
export const MAX_ENDED_SESSION_WATCHES = 32;
/** How long after the session last closed its ended watches are kept. */
export const ENDED_SESSION_WATCH_RETENTION_MS = 7 * 24 * 3_600_000;
/** Most wakes one watch records: its ending and its failing streaks; the oldest delivered ones go first. */
const MAX_WATCH_WAKES = 8;
/** Most unreadable records a ledger keeps set aside. */
const MAX_SET_ASIDE = 32;
const MAX_ID_CHARS = 256;
const MAX_REASON_CHARS = 512;

/**
 * Who armed a watch: the session itself, under the authority of the turn that armed it; the host on the session's behalf
 * (`auto`: a push or a dispatched run the turn's own tool call made, under that turn's authority); or one of its worker
 * runtimes.
 */
export type SessionWatchArmer =
	| { readonly kind: "session"; readonly authority: TurnAuthority }
	| { readonly kind: "auto"; readonly authority: TurnAuthority }
	| { readonly kind: "worker"; readonly runtimeId: string; readonly scope: WorkerWatchScope };

/** How a watch stands: still watching, or how it ended. */
export const SESSION_WATCH_STATUSES = ["live", "fired", "timed-out", "cancelled"] as const;
export type SessionWatchStatus = (typeof SESSION_WATCH_STATUSES)[number];

/** A wake its armer is owed: the firing, the end time reached, or a failing streak. */
export const SESSION_WATCH_WAKE_KINDS = ["fired", "timed-out", "failing"] as const;
export type SessionWatchWakeKind = (typeof SESSION_WATCH_WAKE_KINDS)[number];

const TURN_AUTHORITIES: readonly TurnAuthority[] = ["owner", "remote-owner", "third-party"];
const FAILING_CAUSES: readonly WatchFailingCause[] = ["check-failed", "journal-full"];

export interface SessionWatchWake {
	readonly kind: SessionWatchWakeKind;
	readonly deliveryId: string;
	readonly at: number;
	readonly delivered: boolean;
	/**
	 * When the owner's stop made at this time settled the wake without a turn (`delivered` is then true and nothing carried
	 * it): the bot's session armed the watch by the stop, so its wake is work the stop ended.
	 */
	readonly stopSettledAt?: number;
	/** A failing streak's words, as the monitor reported them. */
	readonly failing?: Pick<WatchFailing, "cause" | "failures" | "reason">;
}

export type SessionWatchCursor = Extract<RoutineCursor, { kind: "watch" }>;

/**
 * What a session watch waits on: a condition the routine watch monitor samples, as a routine watch's, or a typed GitHub
 * source (`github-watch-source.ts`) the host reads, which only this ledger ever holds.
 */
export type SessionWatchSource = WatchCondition | GithubWatchSource;

/** What a watch waits on, as the ledger keeps it and the `watch` tool takes it, or a TypeError. */
export function parseSessionWatchSource(value: unknown): SessionWatchSource {
	return isPlainRecord(value) && typeof value.type === "string" && isGithubWatchSource({ type: value.type })
		? parseGithubWatchSource(value)
		: parseWatchCondition(value);
}

export interface SessionWatchRecord {
	readonly watchId: string;
	/** Changes when a watch id is armed again after the earlier watch of that id ended. */
	readonly incarnationId: string;
	readonly purpose?: string;
	readonly onFire: string;
	readonly condition: SessionWatchSource;
	/** On the clock an owner's stop of a bot is dated on (`OWNER_STOP_CLOCK`), which the stop judges it by. */
	readonly armedAt: number;
	/** On the session's `routines` clock, as its samples and end-time alarm are. */
	readonly expiresAt: number;
	readonly armedBy: SessionWatchArmer;
	readonly cursor: SessionWatchCursor;
	readonly status: SessionWatchStatus;
	readonly endedAt?: number;
	/** The firing, kept for its wake. */
	readonly event?: WatchFiredEvent;
	/** What the watch last saw when it reached its end time. */
	readonly lastSeen?: WatchLastSeen;
	/** A typed source's last reading: pending while it watches, the done one it fired on. */
	readonly result?: GithubWatchResult;
	/**
	 * A `ci` watch fired on a failed attempt whose first failed job is still being read: its wake waits for that read, which
	 * names the job or says why it could not be read (`result.failedJobUnread`).
	 */
	readonly awaitingFailedJob?: true;
	/** The owner is told each result on the phone (`OwnerPush`), besides the armer's wake. */
	readonly tellOwner?: true;
	/** The goal requirement the watch waits for (`watch` arm `forRequirement`): the goal's continuation waits on it. */
	readonly forRequirement?: SessionWatchRequirement;
	/**
	 * The transcript entry the watch was armed from: its wakes carry it (`details.served`), so a bot's spend window that
	 * armed the watch is the one its wake turns are charged to (`bot-spend-window.ts`).
	 */
	readonly served?: SessionWatchServed;
	readonly wakes: readonly SessionWatchWake[];
}

/** A requirement of the session's goal, by the goal's id: a later goal's requirement of the same id is another. */
export interface SessionWatchRequirement {
	readonly goalId: string;
	readonly requirementId: string;
}

function parseRequirement(value: unknown): SessionWatchRequirement {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, ["goalId", "requirementId"]))
		throw new TypeError("Watch requirement is invalid.");
	return {
		goalId: boundedRoutineText(value.goalId, MAX_ID_CHARS, "goal"),
		requirementId: boundedRoutineText(value.requirementId, MAX_ID_CHARS, "requirement"),
	};
}

/** The session and transcript entry a watch serves. */
export interface SessionWatchServed {
	readonly sessionId: string;
	readonly leafId: string;
}

/** The ledger's path beside a session's transcript (`<stem>.jsonl` gives `<stem>.watches.json`). */
export function sessionWatchLedgerPath(sessionFile: string): string {
	return `${sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : sessionFile}${SESSION_WATCH_LEDGER_SUFFIX}`;
}

/** Whether a watch still holds one of its session's slots. */
export function isLiveSessionWatch(record: SessionWatchRecord, nowMs: number): boolean {
	return record.status === "live" && nowMs < record.expiresAt;
}

function instant(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new TypeError("Watch time is invalid.");
	return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) throw new TypeError(`Watch ${label} is invalid.`);
	return value as T;
}

function watchIdOf(value: unknown): string {
	if (typeof value !== "string" || !isRoutineId(value)) throw new TypeError("Watch id is invalid.");
	return value;
}

function parseArmer(value: unknown): SessionWatchArmer {
	if (
		isPlainRecord(value) &&
		(value.kind === "session" || value.kind === "auto") &&
		hasOnlyKeys(value, ["kind", "authority"])
	)
		return { kind: value.kind, authority: oneOf(value.authority, TURN_AUTHORITIES, "authority") };
	if (isPlainRecord(value) && value.kind === "worker" && hasOnlyKeys(value, ["kind", "runtimeId", "scope"]))
		return {
			kind: "worker",
			runtimeId: boundedRoutineText(value.runtimeId, MAX_ID_CHARS, "worker runtime"),
			scope: parseWorkerWatchScope(value.scope),
		};
	throw new TypeError("Watch armer is invalid.");
}

function parseServed(value: unknown): SessionWatchServed {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, ["sessionId", "leafId"]))
		throw new TypeError("Watch entry is invalid.");
	return {
		sessionId: boundedRoutineText(value.sessionId, MAX_ID_CHARS, "served session"),
		leafId: boundedRoutineText(value.leafId, MAX_ID_CHARS, "served entry"),
	};
}

/** A watch's cursor, read as a routine watch's is (`parseRoutineCursor`). */
function parseCursor(value: unknown): SessionWatchCursor {
	const cursor = parseRoutineCursor(value);
	if (cursor.kind !== "watch") throw new TypeError("Watch cursor is invalid.");
	return cursor;
}

function parseWake(value: unknown): SessionWatchWake {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["kind", "deliveryId", "at", "delivered", "stopSettledAt", "failing"]) ||
		typeof value.delivered !== "boolean" ||
		(value.stopSettledAt !== undefined && value.delivered !== true)
	)
		throw new TypeError("Watch wake is invalid.");
	const kind = oneOf(value.kind, SESSION_WATCH_WAKE_KINDS, "wake");
	let failing: SessionWatchWake["failing"];
	if (value.failing !== undefined) {
		const f = value.failing;
		if (
			!isPlainRecord(f) ||
			!hasOnlyKeys(f, ["cause", "failures", "reason"]) ||
			typeof f.failures !== "number" ||
			!Number.isSafeInteger(f.failures) ||
			f.failures < 1
		)
			throw new TypeError("Watch failing streak is invalid.");
		failing = {
			cause: oneOf(f.cause, FAILING_CAUSES, "failing cause"),
			failures: f.failures,
			reason: boundedRoutineText(f.reason, MAX_REASON_CHARS, "failing reason"),
		};
	}
	if ((kind === "failing") !== (failing !== undefined)) throw new TypeError("Watch wake is invalid.");
	return {
		kind,
		deliveryId: boundedRoutineText(value.deliveryId, MAX_ID_CHARS, "delivery"),
		at: instant(value.at),
		delivered: value.delivered,
		...(value.stopSettledAt === undefined ? {} : { stopSettledAt: instant(value.stopSettledAt) }),
		...(failing ? { failing } : {}),
	};
}

/** One record, or a TypeError when this build cannot read it. */
export function parseSessionWatchRecord(value: unknown): SessionWatchRecord {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, [
			"watchId",
			"incarnationId",
			"purpose",
			"onFire",
			"condition",
			"armedAt",
			"expiresAt",
			"armedBy",
			"cursor",
			"status",
			"endedAt",
			"event",
			"lastSeen",
			"result",
			"awaitingFailedJob",
			"tellOwner",
			"forRequirement",
			"served",
			"wakes",
		]) ||
		!Array.isArray(value.wakes) ||
		value.wakes.length > MAX_WATCH_WAKES
	)
		throw new TypeError("Watch record is invalid.");
	const status = oneOf(value.status, SESSION_WATCH_STATUSES, "status");
	const endedAt = value.endedAt === undefined ? undefined : instant(value.endedAt);
	if ((status === "live") !== (endedAt === undefined)) throw new TypeError("Watch record is invalid.");
	const armedAt = instant(value.armedAt);
	const expiresAt = instant(value.expiresAt);
	if (expiresAt <= armedAt) throw new TypeError("Watch end time is invalid.");
	if (value.tellOwner !== undefined && value.tellOwner !== true) throw new TypeError("Watch record is invalid.");
	const condition = parseSessionWatchSource(value.condition);
	if (value.result !== undefined && !isGithubWatchSource(condition)) throw new TypeError("Watch result is invalid.");
	if (
		value.awaitingFailedJob !== undefined &&
		(value.awaitingFailedJob !== true || condition.type !== "ci" || status !== "fired" || value.result === undefined)
	)
		throw new TypeError("Watch record is invalid.");
	return {
		watchId: watchIdOf(value.watchId),
		incarnationId: boundedRoutineText(value.incarnationId, MAX_ID_CHARS, "incarnation"),
		...(value.purpose === undefined
			? {}
			: { purpose: boundedRoutineText(value.purpose, MAX_ROUTINE_PROMPT_CHARS, "purpose") }),
		onFire: boundedRoutineText(value.onFire, MAX_ROUTINE_PROMPT_CHARS, "plan"),
		condition,
		armedAt,
		expiresAt,
		armedBy: parseArmer(value.armedBy),
		cursor: parseCursor(value.cursor),
		status,
		...(endedAt === undefined ? {} : { endedAt }),
		...(value.event === undefined ? {} : { event: parseWatchFiredEvent(value.event) }),
		...(value.lastSeen === undefined ? {} : { lastSeen: oneOf(value.lastSeen, WATCH_LAST_SEEN, "last seen") }),
		...(value.result === undefined ? {} : { result: parseGithubWatchResult(value.result) }),
		...(value.awaitingFailedJob === true ? { awaitingFailedJob: true as const } : {}),
		...(value.tellOwner === true ? { tellOwner: true as const } : {}),
		...(value.forRequirement === undefined ? {} : { forRequirement: parseRequirement(value.forRequirement) }),
		...(value.served === undefined ? {} : { served: parseServed(value.served) }),
		wakes: value.wakes.map(parseWake),
	};
}

/** The records kept: every live one and every one owed a wake, then ended ones by the retention rule, newest first. */
function retained(
	records: readonly SessionWatchRecord[],
	closedAt: number | undefined,
	nowMs: number,
): SessionWatchRecord[] {
	const owed = (record: SessionWatchRecord) =>
		record.status === "live" || record.wakes.some((wake) => !wake.delivered);
	const ended = records
		.filter((record) => !owed(record))
		.filter(
			(record) =>
				closedAt === undefined ||
				nowMs <= closedAt + ENDED_SESSION_WATCH_RETENTION_MS ||
				(record.endedAt ?? 0) > closedAt,
		)
		.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
		.slice(0, MAX_ENDED_SESSION_WATCHES);
	const kept = new Set([...records.filter(owed), ...ended]);
	return records.filter((record) => kept.has(record));
}

/**
 * A watch's wakes with one more, the oldest delivered ones dropped past the bound. At most one undelivered failing wake
 * is ever recorded beside its one firing or end (`SessionWatchService`), so the undelivered ones never pass the bound.
 */
export function withWake(record: SessionWatchRecord, wake: SessionWatchWake): readonly SessionWatchWake[] {
	const wakes = [...record.wakes, wake];
	while (wakes.length > MAX_WATCH_WAKES) {
		const index = wakes.findIndex((entry) => entry.delivered);
		if (index < 0) break;
		wakes.splice(index, 1);
	}
	return wakes;
}

/** What a session's ledger holds for a reader that does not host the session (a bot's roster, what reopens a bot). */
export interface SessionWatchWork {
	/** Watches still watching now. */
	readonly live: number;
	/** Whether the session is owed watch work: a watch not yet ended (its end time may have passed unrecorded) or an undelivered wake. */
	readonly owed: boolean;
	/** The nearest end time of a live watch. */
	readonly firstExpiresAt?: number;
}

/**
 * Reads the ledger beside a session's transcript without taking it: a missing file holds nothing, and so does one this
 * build cannot read as a whole (the session moves it aside, or leaves a newer build's alone, when it opens); a record it
 * cannot read counts for nothing.
 */
export function readSessionWatchWork(sessionFile: string, nowMs: number): SessionWatchWork {
	let text: string;
	try {
		text = readFileSync(sessionWatchLedgerPath(sessionFile), "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return { live: 0, owed: false };
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { live: 0, owed: false };
	}
	if (!isPlainRecord(parsed) || parsed.version !== SESSION_WATCH_LEDGER_VERSION || !Array.isArray(parsed.watches))
		return { live: 0, owed: false };
	const records = parsed.watches.flatMap((entry: unknown) => {
		try {
			return [parseSessionWatchRecord(entry)];
		} catch {
			return [];
		}
	});
	const live = records.filter((record) => isLiveSessionWatch(record, nowMs));
	const owed = records.some((record) => record.status === "live" || record.wakes.some((wake) => !wake.delivered));
	return live.length === 0
		? { live: 0, owed }
		: { live: live.length, owed, firstExpiresAt: Math.min(...live.map((record) => record.expiresAt)) };
}

/** What an owner's stop ended of a session's watches: the watches it cancelled and the wakes it settled without a turn. */
export interface WatchesEndedByStop {
	readonly records: readonly SessionWatchRecord[];
	readonly ended: number;
	readonly settled: number;
}

/**
 * The owner's stop made at `stopAt` over a session's watch records, at `nowMs`: every watch armed at or before then is
 * ended (a live one cancelled, waking nobody) and every wake it is still owed is settled: marked delivered, by the input
 * that carried it when `carried` says the session's transcript holds one (the delivery appended it while the stop
 * waited), otherwise as settled by the stop (`stopSettledAt`). A watch armed after the stop is the session's later work
 * and is kept as it is.
 */
export function endWatchesArmedByStop(
	records: readonly SessionWatchRecord[],
	stopAt: number,
	nowMs: number,
	carried: (deliveryId: string) => boolean,
): WatchesEndedByStop {
	let [ended, settled] = [0, 0];
	const next = records.map((record): SessionWatchRecord => {
		if (record.armedAt > stopAt) return record;
		const live = record.status === "live";
		const owed = record.wakes.some((wake) => !wake.delivered);
		if (!live && !owed) return record;
		if (live) ended++;
		return {
			...record,
			...(live ? { status: "cancelled" as const, endedAt: nowMs } : {}),
			wakes: record.wakes.map((wake): SessionWatchWake => {
				if (wake.delivered) return wake;
				if (carried(wake.deliveryId)) return { ...wake, delivered: true };
				settled++;
				return { ...wake, delivered: true, stopSettledAt: stopAt };
			}),
		};
	});
	return { records: next, ended, settled };
}

/**
 * The ledger files beside a session's transcript: the ledger, the unreadable ones set aside under its name and the
 * temporaries of its crashed atomic writes. They hold only the session's own watches, so they go with its transcript.
 */
export function sessionWatchLedgerFiles(sessionFile: string): string[] {
	return atomicFileFamily(sessionWatchLedgerPath(sessionFile));
}

export interface SessionWatchLedgerDeps {
	readonly sessionId: string;
	/** The ledger's file, from the session's transcript; undefined while the session has none (kept in memory). */
	path(): string | undefined;
	now(): number;
	warn(message: string): void;
}

/** One session's watch records: read once, then every change written whole and atomically before it is taken. */
export class SessionWatchLedger {
	private readonly deps: SessionWatchLedgerDeps;
	private records: readonly SessionWatchRecord[] = [];
	private setAside: readonly unknown[] = [];
	private closedAt: number | undefined;
	/** False when a newer build wrote the file: its watches stay its own, and this build's are kept in memory. */
	private writable = true;
	private readonly listeners = new Set<() => void>();

	constructor(deps: SessionWatchLedgerDeps) {
		this.deps = deps;
		this.load();
	}

	private load(): void {
		const path = this.deps.path();
		if (path === undefined) return;
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (error) {
			if (isMissingFileError(error)) return;
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}
		if (
			isPlainRecord(parsed) &&
			typeof parsed.version === "number" &&
			parsed.version > SESSION_WATCH_LEDGER_VERSION
		) {
			this.writable = false;
			this.deps.warn(
				"Session watches: the ledger was written by a newer build; watches armed now are kept in memory only.",
			);
			return;
		}
		if (
			!isPlainRecord(parsed) ||
			parsed.version !== SESSION_WATCH_LEDGER_VERSION ||
			parsed.sessionId !== this.deps.sessionId ||
			!Array.isArray(parsed.watches) ||
			(parsed.setAside !== undefined && !Array.isArray(parsed.setAside)) ||
			(parsed.closedAt !== undefined &&
				(typeof parsed.closedAt !== "number" || !Number.isSafeInteger(parsed.closedAt)))
		) {
			const aside = `${path}.unreadable-${this.deps.now()}`;
			try {
				renameSync(path, aside);
				this.deps.warn(`Session watches: the ledger could not be read and was moved aside to ${aside}.`);
			} catch (error) {
				// The unreadable file stays where it is, never overwritten; this build's watches are kept in memory.
				this.writable = false;
				this.deps.warn(
					`Session watches: the ledger could not be read or moved aside (${error instanceof Error ? error.message : String(error)}); watches armed now are kept in memory only.`,
				);
			}
			return;
		}
		const records: SessionWatchRecord[] = [];
		const setAside: unknown[] = Array.isArray(parsed.setAside) ? [...parsed.setAside] : [];
		const seen = new Set<string>();
		for (const entry of parsed.watches) {
			try {
				const record = parseSessionWatchRecord(entry);
				if (seen.has(record.watchId)) throw new TypeError("Watch id repeats.");
				seen.add(record.watchId);
				records.push(record);
			} catch {
				setAside.push(entry);
			}
		}
		this.closedAt = typeof parsed.closedAt === "number" ? parsed.closedAt : undefined;
		this.records = records;
		this.setAside = setAside.slice(-MAX_SET_ASIDE);
	}

	list(): readonly SessionWatchRecord[] {
		return this.records;
	}

	get(watchId: string): SessionWatchRecord | undefined {
		return this.records.find((record) => record.watchId === watchId);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Takes the next records once they are written; a write that fails leaves the ledger as it was and throws. Listeners
	 * are told after the change is taken.
	 */
	commit(next: readonly SessionWatchRecord[]): void {
		this.write(retained(next, this.closedAt, this.deps.now()), this.closedAt);
	}

	/** Applies the owner's stop made at `stopAt` ({@link endWatchesArmedByStop}); writes only when it ended or settled anything. */
	endArmedByStop(stopAt: number, carried: (deliveryId: string) => boolean): { ended: number; settled: number } {
		const { records, ended, settled } = endWatchesArmedByStop(this.records, stopAt, this.deps.now(), carried);
		if (ended + settled > 0 || records.some((record, index) => record !== this.records[index])) this.commit(records);
		return { ended, settled };
	}

	/** Records that the session closed now: ended watches are kept for {@link ENDED_SESSION_WATCH_RETENTION_MS} after it. */
	close(): void {
		const closedAt = this.deps.now();
		this.write(retained(this.records, closedAt, closedAt), closedAt);
	}

	private write(records: readonly SessionWatchRecord[], closedAt: number | undefined): void {
		const path = this.writable ? this.deps.path() : undefined;
		if (path !== undefined)
			writeFileAtomicSync(
				path,
				`${JSON.stringify({
					version: SESSION_WATCH_LEDGER_VERSION,
					sessionId: this.deps.sessionId,
					...(closedAt === undefined ? {} : { closedAt }),
					watches: records,
					...(this.setAside.length === 0 ? {} : { setAside: this.setAside }),
				})}\n`,
			);
		this.records = records;
		this.closedAt = closedAt;
		for (const listener of [...this.listeners]) listener();
	}
}
