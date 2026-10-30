import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
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
	const leasePath = join(dirname(storeFilePath), "bot-daemon-lease.json");
	try {
		const raw = readFileSync(leasePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (isRecordObject(parsed) && typeof parsed.pid === "number" && Number.isInteger(parsed.pid)) {
			const lastHeartbeatAt =
				typeof parsed.lastHeartbeatAt === "number" && Number.isFinite(parsed.lastHeartbeatAt)
					? parsed.lastHeartbeatAt
					: 0;
			let alive = false;
			try {
				process.kill(parsed.pid, 0);
				alive = nowMs - lastHeartbeatAt <= DAEMON_STALE_MS;
			} catch {
				alive = false;
			}
			return {
				running: alive,
				pid: alive ? parsed.pid : undefined,
				startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
				lastHeartbeatAt: lastHeartbeatAt || undefined,
				lastTickAt:
					typeof parsed.lastTickAt === "number" && Number.isFinite(parsed.lastTickAt)
						? parsed.lastTickAt
						: undefined,
				activeRoutines,
				dueRoutines,
			};
		}
	} catch {
		// Absent or unreadable lease file means no detached daemon is running.
	}
	return { running: false, activeRoutines, dueRoutines };
}

export function writeDaemonLeaseFile(
	storeFilePath: string,
	routines: Iterable<PersistentRoutineScheduleRecord>,
	input: { pid: number; startedAt?: string; lastTickAt?: number },
	nowMs = Date.now(),
): PersistentBotDaemonStatus {
	const leasePath = join(dirname(storeFilePath), "bot-daemon-lease.json");
	mkdirSync(dirname(leasePath), { recursive: true });
	const payload = {
		pid: input.pid,
		startedAt: input.startedAt ?? new Date(nowMs).toISOString(),
		lastHeartbeatAt: nowMs,
		...(input.lastTickAt !== undefined ? { lastTickAt: input.lastTickAt } : {}),
	};
	writeFileAtomicSync(leasePath, JSON.stringify(payload, null, 2));
	return readDaemonLeaseStatus(storeFilePath, routines, nowMs);
}

export function releaseDaemonLeaseFile(storeFilePath: string, pid?: number): boolean {
	const leasePath = join(dirname(storeFilePath), "bot-daemon-lease.json");
	try {
		if (!existsSync(leasePath)) return false;
		if (pid !== undefined) {
			const raw = readFileSync(leasePath, "utf8");
			const parsed: unknown = JSON.parse(raw);
			if (isRecordObject(parsed) && typeof parsed.pid === "number" && parsed.pid !== pid) {
				return false;
			}
		}
		writeFileAtomicSync(leasePath, JSON.stringify({ releasedAt: Date.now() }));
		return true;
	} catch {
		return false;
	}
}
