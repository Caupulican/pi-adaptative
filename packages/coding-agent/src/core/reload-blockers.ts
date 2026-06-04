import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

export const ACTIVE_TURN_TTL_MS = 5 * 60_000;
export const AUTO_RELOAD_COORDINATOR_TTL_MS = 10 * 60_000;

export interface ReloadSessionRecord {
	key: string;
	source: "active-turn" | "coordinator";
	pid?: number;
	sessionId?: string;
	sessionFile?: string;
	cwd?: string;
	active?: boolean;
	updatedAt?: number;
	seenAt?: number;
	reloadedAt?: number;
	reason?: string;
}

export interface PendingReloadBlockers {
	pending: boolean;
	reason: string;
	blockers: ReloadSessionRecord[];
	descriptions: string[];
}

export interface ReloadBlockerOptions {
	agentDir?: string;
	now?: number;
	ownKey?: string;
	ownPid?: number;
	ownSessionId?: string;
	ownSessionFile?: string;
	activeTurnTtlMs?: number;
	coordinatorTtlMs?: number;
	/** Auto Learn workers are memory-first, short-lived, and should not block foreground reload/adaptive work by default. */
	includeAutoLearnSessions?: boolean;
	isProcessAlive?: (pid: number | undefined) => boolean;
}

interface ParsedSession {
	pid?: number;
	sessionId?: string;
	sessionFile?: string;
	cwd?: string;
	active?: boolean;
	updatedAt?: number;
	seenAt?: number;
	reloadedAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonFile(file: string): unknown {
	try {
		if (!existsSync(file)) return undefined;
		return JSON.parse(readFileSync(file, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function parseSession(value: unknown): ParsedSession | undefined {
	if (!isRecord(value)) return undefined;
	return {
		pid: numberValue(value.pid),
		sessionId: stringValue(value.sessionId),
		sessionFile: stringValue(value.sessionFile),
		cwd: stringValue(value.cwd),
		active: booleanValue(value.active),
		updatedAt: numberValue(value.updatedAt),
		seenAt: numberValue(value.seenAt),
		reloadedAt: numberValue(value.reloadedAt),
	};
}

export function isReloadSessionProcessAlive(pid: number | undefined): boolean {
	if (pid === undefined || !Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
		return code === "EPERM";
	}
}

function isOwnSession(key: string, session: ParsedSession, options: ReloadBlockerOptions): boolean {
	if (options.ownKey && key === options.ownKey) return true;
	if (options.ownPid !== undefined && session.pid === options.ownPid) return true;
	if (options.ownSessionId && session.sessionId === options.ownSessionId) return true;
	if (options.ownSessionFile && session.sessionFile === options.ownSessionFile) return true;
	return false;
}

function isAutoLearnSession(session: ParsedSession): boolean {
	return !!session.sessionId?.startsWith("auto-learn-");
}

function shouldIgnoreSession(session: ParsedSession, options: ReloadBlockerOptions): boolean {
	return options.includeAutoLearnSessions !== true && isAutoLearnSession(session);
}

function addBlocker(blockers: Map<string, ReloadSessionRecord>, record: ReloadSessionRecord): void {
	const identity = [
		record.key,
		record.pid ?? "",
		record.sessionId ?? "",
		record.sessionFile ?? "",
		record.cwd ?? "",
	].join("\0");
	const existing = blockers.get(identity);
	if (!existing || (existing.source === "coordinator" && record.source === "active-turn")) {
		blockers.set(identity, record);
	}
}

function activeTurnBlockers(options: ReloadBlockerOptions): ReloadSessionRecord[] {
	const agentDir = options.agentDir ?? getAgentDir();
	const now = options.now ?? Date.now();
	const ttl = options.activeTurnTtlMs ?? ACTIVE_TURN_TTL_MS;
	const isAlive = options.isProcessAlive ?? isReloadSessionProcessAlive;
	const registry = readJsonFile(join(agentDir, "pi-active-turns.json"));
	if (!isRecord(registry) || !isRecord(registry.sessions)) return [];

	const blockers: ReloadSessionRecord[] = [];
	for (const [key, rawSession] of Object.entries(registry.sessions)) {
		const session = parseSession(rawSession);
		if (!session?.active) continue;
		if (isOwnSession(key, session, options) || shouldIgnoreSession(session, options)) continue;
		if (session.updatedAt === undefined || now - session.updatedAt > ttl) continue;
		if (!isAlive(session.pid)) continue;
		blockers.push({ key, source: "active-turn", ...session });
	}
	return blockers;
}

function coordinatorBlockers(options: ReloadBlockerOptions): { blockers: ReloadSessionRecord[]; reason: string } {
	const agentDir = options.agentDir ?? getAgentDir();
	const now = options.now ?? Date.now();
	const ttl = options.coordinatorTtlMs ?? AUTO_RELOAD_COORDINATOR_TTL_MS;
	const isAlive = options.isProcessAlive ?? isReloadSessionProcessAlive;
	const coordinator = readJsonFile(join(agentDir, "pi-auto-reload-state.json"));
	if (!isRecord(coordinator) || !isRecord(coordinator.changes)) return { blockers: [], reason: "" };

	const blockers: ReloadSessionRecord[] = [];
	let reason = "";
	for (const rawChange of Object.values(coordinator.changes)) {
		if (!isRecord(rawChange)) continue;
		const firstSeenAt = numberValue(rawChange.firstSeenAt);
		if (firstSeenAt === undefined || now - firstSeenAt > ttl) continue;
		reason ||= stringValue(rawChange.reason) ?? "";
		if (!isRecord(rawChange.sessions)) continue;
		for (const [key, rawSession] of Object.entries(rawChange.sessions)) {
			const session = parseSession(rawSession);
			if (!session) continue;
			if (session.reloadedAt !== undefined) continue;
			if (isOwnSession(key, session, options) || shouldIgnoreSession(session, options)) continue;
			if (!isAlive(session.pid)) continue;
			blockers.push({ key, source: "coordinator", reason: stringValue(rawChange.reason), ...session });
		}
	}
	return { blockers, reason };
}

export function describeReloadSession(
	record: Pick<ReloadSessionRecord, "key" | "pid" | "sessionId" | "sessionFile" | "cwd">,
): string {
	const label = record.sessionId ?? record.sessionFile ?? record.cwd ?? String(record.pid ?? "unknown");
	const parts = [`${record.key}:${label}`];
	if (record.pid !== undefined) parts.push(`pid=${record.pid}`);
	if (record.cwd) parts.push(`cwd=${record.cwd}`);
	if (record.sessionFile) parts.push(`file=${record.sessionFile}`);
	return parts.join(" ");
}

export function getPendingReloadBlockers(options: ReloadBlockerOptions = {}): PendingReloadBlockers {
	const byIdentity = new Map<string, ReloadSessionRecord>();
	for (const blocker of activeTurnBlockers(options)) addBlocker(byIdentity, blocker);
	const coordinator = coordinatorBlockers(options);
	for (const blocker of coordinator.blockers) addBlocker(byIdentity, blocker);
	const blockers = [...byIdentity.values()].sort((a, b) =>
		describeReloadSession(a).localeCompare(describeReloadSession(b)),
	);
	return {
		pending: blockers.length > 0,
		reason:
			coordinator.reason ||
			(blockers.length ? "Pi auto-reload is waiting for active peer/background session(s)." : ""),
		blockers,
		descriptions: blockers.map(describeReloadSession),
	};
}
