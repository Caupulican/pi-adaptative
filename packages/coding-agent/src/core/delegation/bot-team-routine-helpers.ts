import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isPositiveSafePid, probeProcessLiveness } from "../../kernel/reliability/process-tree.ts";
import {
	isMissingFileError,
	LOW_LATENCY_FILE_LOCK_OPTIONS,
	withFileLockSync,
	writeFileAtomicSync,
} from "../util/atomic-file.ts";
import { isRecordObject } from "../util/value-guards.ts";
import {
	normalizeBotOrTeamId,
	type PersistentBotRecord,
	type PersistentTeamMessage,
	type PersistentTeamRecord,
	teamIncarnation,
} from "./persistent-bot-team-store.ts";

export type PersistentRoutineTarget =
	| { readonly kind: "bot"; readonly agentId: string }
	| { readonly kind: "team"; readonly teamId: string };

export interface PersistentRoutineScheduleRecord {
	readonly routineId: string;
	readonly target: PersistentRoutineTarget;
	readonly prompt: string;
	readonly intervalMs: number;
	readonly enabled: boolean;
	readonly nextRunAt: number;
	readonly lastRunAt?: number;
	readonly lastStatus?: "queued" | "running" | "succeeded" | "failed";
	readonly lastSummary?: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface UpsertPersistentRoutineInput {
	readonly routineId: string;
	readonly target: PersistentRoutineTarget;
	readonly prompt: string;
	readonly intervalMs: number;
	readonly enabled?: boolean;
	readonly nextRunAt?: number;
}

export interface PersistentBotInboxEntry {
	readonly id: string;
	readonly kind: "bot" | "team";
	readonly targetId: string;
	readonly sender: string;
	readonly text: string;
	readonly timestamp: number;
	readonly unread: boolean;
}

export interface PersistentBotDaemonStatus {
	readonly running: boolean;
	readonly pid?: number;
	readonly startedAt?: string;
	readonly lastHeartbeatAt?: number;
	readonly lastTickAt?: number;
	readonly activeRoutines: number;
	readonly dueRoutines: number;
}

export const MIN_ROUTINE_INTERVAL_MS = 10_000;
const DAEMON_STALE_MS = 60_000;
const BOT_OR_TEAM_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function parseDurationIntervalMs(raw: string): number {
	const trimmed = raw.trim().toLowerCase();
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/u.exec(trimmed);
	if (!match) {
		throw new Error(`Invalid schedule interval "${raw}". Expected e.g. 30s, 5m, 1h, 1d.`);
	}
	const amount = Number.parseFloat(match[1]!);
	const unit = match[2] ?? "s";
	const multiplier =
		unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
	const ms = Math.round(amount * multiplier);
	if (!Number.isFinite(ms) || ms < MIN_ROUTINE_INTERVAL_MS) {
		throw new Error(`Schedule interval must be at least ${MIN_ROUTINE_INTERVAL_MS / 1000}s.`);
	}
	return ms;
}

export function formatDurationIntervalMs(intervalMs: number): string {
	if (intervalMs % 86_400_000 === 0) return `${intervalMs / 86_400_000}d`;
	if (intervalMs % 3_600_000 === 0) return `${intervalMs / 3_600_000}h`;
	if (intervalMs % 60_000 === 0) return `${intervalMs / 60_000}m`;
	if (intervalMs % 1000 === 0) return `${intervalMs / 1000}s`;
	return `${intervalMs}ms`;
}

export function parseRoutineRecord(value: unknown): PersistentRoutineScheduleRecord | undefined {
	if (!isRecordObject(value)) return undefined;
	const {
		routineId,
		target,
		prompt,
		intervalMs,
		enabled,
		nextRunAt,
		lastRunAt,
		lastStatus,
		lastSummary,
		createdAt,
		updatedAt,
	} = value;
	if (
		typeof routineId !== "string" ||
		!BOT_OR_TEAM_ID_REGEX.test(routineId) ||
		typeof prompt !== "string" ||
		prompt.trim().length === 0 ||
		typeof intervalMs !== "number" ||
		!Number.isFinite(intervalMs) ||
		intervalMs < MIN_ROUTINE_INTERVAL_MS ||
		typeof nextRunAt !== "number" ||
		!Number.isFinite(nextRunAt) ||
		typeof createdAt !== "string" ||
		typeof updatedAt !== "string" ||
		!isRecordObject(target)
	) {
		return undefined;
	}
	let parsedTarget: PersistentRoutineTarget | undefined;
	if (target.kind === "bot" && typeof target.agentId === "string" && BOT_OR_TEAM_ID_REGEX.test(target.agentId)) {
		parsedTarget = { kind: "bot", agentId: target.agentId };
	} else if (target.kind === "team" && typeof target.teamId === "string" && BOT_OR_TEAM_ID_REGEX.test(target.teamId)) {
		parsedTarget = { kind: "team", teamId: target.teamId };
	}
	if (!parsedTarget) return undefined;
	const validStatus =
		lastStatus === "queued" || lastStatus === "running" || lastStatus === "succeeded" || lastStatus === "failed"
			? lastStatus
			: undefined;
	return {
		routineId,
		target: parsedTarget,
		prompt: prompt.trim(),
		intervalMs: Math.round(intervalMs),
		enabled: typeof enabled === "boolean" ? enabled : true,
		nextRunAt,
		lastRunAt: typeof lastRunAt === "number" && Number.isFinite(lastRunAt) ? lastRunAt : undefined,
		lastStatus: validStatus,
		lastSummary: typeof lastSummary === "string" ? lastSummary : undefined,
		createdAt,
		updatedAt,
	};
}

export function buildUpsertedRoutineRecord(
	routines: ReadonlyMap<string, PersistentRoutineScheduleRecord>,
	input: UpsertPersistentRoutineInput,
	nowMs = Date.now(),
): PersistentRoutineScheduleRecord {
	const routineId = normalizeBotOrTeamId(input.routineId, "routineId");
	const prompt = input.prompt.trim();
	if (!prompt) throw new Error("Routine prompt cannot be empty.");
	const intervalMs = Math.max(MIN_ROUTINE_INTERVAL_MS, Math.round(input.intervalMs));
	const target: PersistentRoutineTarget =
		input.target.kind === "bot"
			? { kind: "bot", agentId: normalizeBotOrTeamId(input.target.agentId, "agentId") }
			: { kind: "team", teamId: normalizeBotOrTeamId(input.target.teamId, "teamId") };
	const existing = routines.get(routineId);
	const nowIso = new Date(nowMs).toISOString();
	return {
		routineId,
		target,
		prompt,
		intervalMs,
		enabled: input.enabled ?? existing?.enabled ?? true,
		nextRunAt: input.nextRunAt ?? nowMs + intervalMs,
		lastRunAt: existing?.lastRunAt,
		lastStatus: existing?.lastStatus,
		lastSummary: existing?.lastSummary,
		createdAt: existing?.createdAt ?? nowIso,
		updatedAt: nowIso,
	};
}

export function claimDueRoutinesInMap(
	routines: Map<string, PersistentRoutineScheduleRecord>,
	nowMs = Date.now(),
	routineIdFilter?: string,
): PersistentRoutineScheduleRecord[] {
	const claimed: PersistentRoutineScheduleRecord[] = [];
	const nowIso = new Date(nowMs).toISOString();
	for (const [id, routine] of routines.entries()) {
		if (routineIdFilter && id !== routineIdFilter) continue;
		if (!routineIdFilter && (!routine.enabled || routine.nextRunAt > nowMs)) continue;
		const updated: PersistentRoutineScheduleRecord = {
			...routine,
			lastRunAt: nowMs,
			nextRunAt: nowMs + routine.intervalMs,
			lastStatus: "running",
			updatedAt: nowIso,
		};
		routines.set(id, updated);
		claimed.push(structuredClone(updated));
	}
	return claimed;
}

export function collectTeamInboxEntries(
	team: PersistentTeamRecord,
	messages: readonly PersistentTeamMessage[],
	readAt: number,
): PersistentBotInboxEntry[] {
	const currentIncarnation = teamIncarnation(team);
	const entries: PersistentBotInboxEntry[] = [];
	for (const msg of messages) {
		if (msg.teamIncarnationId && msg.teamIncarnationId !== currentIncarnation) continue;
		const sender = msg.sender.kind === "bot" ? msg.sender.agentId : msg.sender.kind;
		entries.push({
			id: msg.messageId,
			kind: "team",
			targetId: team.teamId,
			sender,
			text: msg.text,
			timestamp: msg.timestamp,
			unread: msg.sender.kind !== "operator" && msg.timestamp > readAt,
		});
	}
	return entries;
}

export function collectBotInboxEntries(
	normId: string,
	bot: PersistentBotRecord | undefined,
	teams: Iterable<PersistentTeamRecord>,
	teamMessages: ReadonlyMap<string, readonly PersistentTeamMessage[]>,
	limit = 20,
): PersistentBotInboxEntry[] {
	const entries: PersistentBotInboxEntry[] = [];
	const readAt = bot?.lastReadAt ?? 0;
	if (bot?.lastSummary && bot.lastMessageAt) {
		entries.push({
			id: `bot:${normId}:${bot.lastMessageAt}`,
			kind: "bot",
			targetId: normId,
			sender: normId,
			text: bot.lastSummary,
			timestamp: bot.lastMessageAt,
			unread: bot.lastMessageAt > readAt,
		});
	}
	for (const team of teams) {
		if (!team.memberAgentIds.includes(normId)) continue;
		entries.push(
			...collectTeamInboxEntries(team, teamMessages.get(team.teamId) ?? [], Math.max(readAt, team.lastReadAt ?? 0)),
		);
	}
	entries.sort((a, b) => b.timestamp - a.timestamp);
	return entries.slice(0, Math.max(1, limit));
}

/**
 * The detached bot daemon's lease. Its identity is the random token the starting session wrote under the lease lock
 * before spawning the daemon and handed to it in argv; a recorded pid is display data and a fast negative only (a dead
 * pid means the daemon is gone), never authority to signal, because a pid can be reused once its process exits.
 * The daemon renews the lease under the same lock while the token is still its own and exits once it is not, so
 * stopping the daemon is releasing its lease: nothing is ever sent to a pid read from disk.
 */
interface DaemonLeaseRecord {
	readonly token: string;
	readonly startedAt: string;
	readonly pid?: number;
	readonly lastHeartbeatAt?: number;
	readonly lastTickAt?: number;
}

const DAEMON_LEASE_TOKEN_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `value` is a daemon lease token (`crypto.randomUUID()` spelling). */
export function isDaemonLeaseToken(value: string): boolean {
	return DAEMON_LEASE_TOKEN_REGEX.test(value);
}

export function daemonLeasePath(storeFilePath: string): string {
	return join(dirname(storeFilePath), "bot-daemon-lease.json");
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The current lease, or undefined when there is none: no file, a released lease, or a record without a token. */
function readDaemonLease(leasePath: string): DaemonLeaseRecord | undefined {
	let raw: string;
	try {
		raw = readFileSync(leasePath, "utf8");
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (
		!isRecordObject(parsed) ||
		typeof parsed.token !== "string" ||
		!isDaemonLeaseToken(parsed.token) ||
		typeof parsed.startedAt !== "string"
	)
		return undefined;
	const pid = isPositiveSafePid(parsed.pid) ? parsed.pid : undefined;
	const lastHeartbeatAt = finiteNumber(parsed.lastHeartbeatAt);
	const lastTickAt = finiteNumber(parsed.lastTickAt);
	return {
		token: parsed.token,
		startedAt: parsed.startedAt,
		...(pid !== undefined ? { pid } : {}),
		...(lastHeartbeatAt !== undefined ? { lastHeartbeatAt } : {}),
		...(lastTickAt !== undefined ? { lastTickAt } : {}),
	};
}

/**
 * A lease is held while its holder renewed it (or, before the first renewal, claimed it) within the stale window and
 * its recorded pid is not proven gone. Only the token holder renews, so a reused pid cannot keep a lease held.
 */
function isDaemonLeaseHeld(lease: DaemonLeaseRecord, nowMs: number): boolean {
	const renewedAt = lease.lastHeartbeatAt ?? Date.parse(lease.startedAt);
	if (!Number.isFinite(renewedAt) || nowMs - renewedAt > DAEMON_STALE_MS) return false;
	return lease.pid === undefined || probeProcessLiveness(lease.pid) !== "dead";
}

function withDaemonLease<T>(storeFilePath: string, action: (leasePath: string) => T): T {
	const leasePath = daemonLeasePath(storeFilePath);
	return withFileLockSync(leasePath, () => action(leasePath), LOW_LATENCY_FILE_LOCK_OPTIONS);
}

function writeDaemonLease(leasePath: string, lease: DaemonLeaseRecord): void {
	writeFileAtomicSync(leasePath, JSON.stringify(lease, null, 2));
}

export function readDaemonLeaseStatus(
	storeFilePath: string,
	routines: Iterable<PersistentRoutineScheduleRecord>,
	nowMs = Date.now(),
): PersistentBotDaemonStatus {
	let activeRoutines = 0;
	let dueRoutines = 0;
	for (const r of routines) {
		if (!r.enabled) continue;
		activeRoutines++;
		if (r.nextRunAt <= nowMs) dueRoutines++;
	}
	const lease = readDaemonLease(daemonLeasePath(storeFilePath));
	if (!lease) return { running: false, activeRoutines, dueRoutines };
	const running = isDaemonLeaseHeld(lease, nowMs);
	return {
		running,
		pid: running ? lease.pid : undefined,
		startedAt: lease.startedAt,
		lastHeartbeatAt: lease.lastHeartbeatAt,
		lastTickAt: lease.lastTickAt,
		activeRoutines,
		dueRoutines,
	};
}

/** Takes the lease for a daemon about to be started with `token`; false while another holder keeps it. */
export function claimDaemonLeaseFile(storeFilePath: string, token: string, nowMs = Date.now()): boolean {
	return withDaemonLease(storeFilePath, (leasePath) => {
		const current = readDaemonLease(leasePath);
		if (current && isDaemonLeaseHeld(current, nowMs)) return false;
		writeDaemonLease(leasePath, { token, startedAt: new Date(nowMs).toISOString() });
		return true;
	});
}

/** Records the spawned daemon's pid while the lease is still the one claimed for it and not yet renewed. */
export function recordDaemonLeasePidFile(storeFilePath: string, token: string, pid: number): void {
	withDaemonLease(storeFilePath, (leasePath) => {
		const current = readDaemonLease(leasePath);
		if (current?.token === token && current.pid === undefined) writeDaemonLease(leasePath, { ...current, pid });
	});
}

/** The daemon's renewal: true while the lease is still `token`'s, false once released or claimed by another start. */
export function renewDaemonLeaseFile(storeFilePath: string, token: string, pid: number, nowMs = Date.now()): boolean {
	return withDaemonLease(storeFilePath, (leasePath) => {
		const current = readDaemonLease(leasePath);
		if (current?.token !== token) return false;
		writeDaemonLease(leasePath, { ...current, pid, lastHeartbeatAt: nowMs, lastTickAt: nowMs });
		return true;
	});
}

/** Whether the lease currently names `token`; read without the lock, which atomic replacement makes consistent. */
export function daemonLeaseBelongsTo(storeFilePath: string, token: string): boolean {
	return readDaemonLease(daemonLeasePath(storeFilePath))?.token === token;
}

export type DaemonLeaseRelease =
	| { readonly released: false }
	| { readonly released: true; readonly held: boolean; readonly pid?: number };

/**
 * Releases the lease (only when it is `token`'s, if one is given). `held` says whether a live holder had it, which
 * is the daemon that now exits on observing the release; a lease that was not held was stale and is simply cleared.
 */
export function releaseDaemonLeaseFile(storeFilePath: string, token?: string, nowMs = Date.now()): DaemonLeaseRelease {
	return withDaemonLease(storeFilePath, (leasePath) => {
		const current = readDaemonLease(leasePath);
		if (!current || (token !== undefined && current.token !== token)) return { released: false };
		writeFileAtomicSync(leasePath, JSON.stringify({ releasedAt: nowMs }));
		return { released: true, held: isDaemonLeaseHeld(current, nowMs), ...(current.pid ? { pid: current.pid } : {}) };
	});
}
