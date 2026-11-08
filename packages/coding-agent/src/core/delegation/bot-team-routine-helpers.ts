import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VERSION, VERSION_SOURCE_AVAILABLE } from "../../config.ts";
import { judgeOwner, type ProcessOwner } from "../../kernel/reliability/owner-identity.ts";
import { isPositiveSafePid, probeProcessLiveness } from "../../kernel/reliability/process-tree.ts";
import { comparePackageVersions } from "../../utils/version-check.ts";
import {
	MIN_ROUTINE_INTERVAL_MS,
	nextRoutineAt,
	type RoutineDefinitionView,
	type RoutineOccurrence,
	routineEnded,
	routineOpensAt,
} from "../routines/routine-contract.ts";
import {
	isMissingFileError,
	LOW_LATENCY_FILE_LOCK_OPTIONS,
	withFileLockSync,
	writeFileAtomicSync,
} from "../util/atomic-file.ts";
import { isRecordObject } from "../util/value-guards.ts";
import {
	type PersistentBotRecord,
	type PersistentTeamMessage,
	type PersistentTeamRecord,
	teamIncarnation,
} from "./persistent-bot-team-store.ts";

export interface PersistentBotInboxEntry {
	readonly id: string;
	readonly kind: "bot" | "team";
	readonly targetId: string;
	readonly sender: string;
	readonly text: string;
	readonly timestamp: number;
	readonly unread: boolean;
}

/**
 * A daemon of an earlier build still renewing the old `bot-daemon-lease.json`. `inline-script`: a `<runtime> -e
 * <script>` daemon (tokenless heartbeat with its own pid); `token-daemon`: a first-generation `pi --bot-daemon`.
 */
export interface LegacyBotDaemonClaim {
	readonly kind: "inline-script" | "token-daemon";
	readonly pid?: number;
	readonly lastHeartbeatAt?: number;
}

export interface PersistentBotDaemonStatus {
	/** The current lease is held: claimed or renewed within the stale window, its daemon not proven gone. */
	readonly running: boolean;
	/** The daemon's own pid once it renewed; before that, the advisory pid of the process the starter spawned. */
	readonly pid?: number;
	readonly startedAt?: string;
	/**
	 * The build the daemon renewed its lease with (its package version); before its first renewal, its starter's.
	 * Absent for a lease an earlier build wrote, which stamps none.
	 */
	readonly build?: string;
	/** Absent while the daemon has not renewed its lease yet (starting). */
	readonly lastHeartbeatAt?: number;
	readonly lastTickAt?: number;
	readonly activeRoutines: number;
	readonly dueRoutines: number;
	/** Enabled routines whose due run could not run away, with why; each runs when its session opens. */
	readonly awayRefusals: readonly { readonly routineId: string; readonly reason: string; readonly at: number }[];
	/** The latest daemon's own reports (refusals, open failures, diagnostics), oldest first and bounded. */
	readonly reports: readonly BotDaemonReport[];
	/** How the last daemon ended, while no daemon has claimed the lease since. */
	readonly lastEnd?: BotDaemonEnd;
	readonly legacy?: LegacyBotDaemonClaim;
}

/** One report of the detached daemon, kept in its lease record: the handoff a session reads back. */
export interface BotDaemonReport {
	readonly at: number;
	readonly message: string;
}

/**
 * The terminal record a released lease keeps: `released` by a session (`/bot daemon stop`), `signal` when the
 * daemon process was asked to stop, `failed` when an error ended it (`detail` says which).
 */
export interface BotDaemonEnd {
	readonly reason: "released" | "signal" | "failed";
	readonly at: number;
	readonly detail?: string;
}

const DAEMON_STALE_MS = 60_000;
/** Reports kept in the lease record; older ones are dropped first. */
const MAX_DAEMON_REPORTS = 20;
const MAX_DAEMON_REPORT_CHARS = 500;

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
	if (!Number.isSafeInteger(ms) || ms < MIN_ROUTINE_INTERVAL_MS) {
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
 * The detached bot daemon's lease, in `bot-daemon-token-lease.json`. Its identity is the random token the starting
 * session wrote under the lease lock before spawning the daemon and handed to it in argv. Only the daemon renews it,
 * under the same lock, recording its own process identity; it exits once the token is no longer its own, so stopping
 * the daemon is releasing its lease and nothing is ever sent to a pid read from disk.
 *
 * Ownership and status derive from the token and the freshness of the last renewal. Pids are advisory:
 * `launcherPid` is whatever process the starter spawned (on Windows a managed install's `cmd.exe` wrapper) and is
 * display data only, never probed; the renewing daemon's own identity ({@link ProcessOwner}) is the one fast negative,
 * when {@link judgeOwner} proves it gone.
 *
 * Earlier builds used `bot-daemon-lease.json` (see `bot-daemon-legacy.ts`). The current lease never lives there, so a
 * legacy daemon's unlocked rewrites of that file cannot displace it: the old file is read to report a legacy claim and
 * written only to release a first-generation token lease.
 *
 * `build` is the package version: the claim writes its starter's, and every renewal the daemon process's own, since the
 * launch target can run newer code than the session that started it. A claim by a newer build takes over a held lease
 * of an older one ({@link isOlderDaemonBuild}); that daemon exits as any daemon whose lease another start took.
 */
interface DaemonLeaseRecord {
	readonly token: string;
	readonly startedAt: string;
	readonly build?: string;
	readonly launcherPid?: number;
	readonly owner?: ProcessOwner;
	readonly lastHeartbeatAt?: number;
	readonly lastTickAt?: number;
	readonly reports?: readonly BotDaemonReport[];
}

const DAEMON_LEASE_TOKEN_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A build stamp is a package version: short and printable; anything else in a lease reads as no stamp. */
const DAEMON_BUILD_REGEX = /^[0-9A-Za-z.+-]{1,64}$/;

function parseDaemonBuild(value: unknown): string | undefined {
	return typeof value === "string" && DAEMON_BUILD_REGEX.test(value) ? value : undefined;
}

/** This process's build, stamped into each lease it claims or renews; undefined when no package metadata named it. */
export const OWN_DAEMON_BUILD: string | undefined = VERSION_SOURCE_AVAILABLE ? parseDaemonBuild(VERSION) : undefined;

/**
 * Whether a lease stamped `leaseBuild` is of an older build than `own`, so a start of `own` replaces its daemon. No
 * stamp is older (an earlier build stamps none); an equal, newer or incomparable one is not, so only a strictly newer
 * build replaces and builds never alternate. An unknown own build replaces nothing.
 */
export function isOlderDaemonBuild(leaseBuild: string | undefined, own: string | undefined): boolean {
	if (own === undefined) return false;
	if (leaseBuild === undefined) return true;
	const order = comparePackageVersions(leaseBuild, own);
	return order !== undefined && order < 0;
}

/** The daemon's build for status lines, and the session's when they differ. */
export function describeDaemonBuild(build: string | undefined, sessionBuild: string | undefined): string {
	const running = build === undefined ? "build unstamped (an earlier build)" : `build ${build}`;
	return build === sessionBuild ? running : `${running}; this session runs ${sessionBuild ?? "an unknown build"}`;
}

/** The daemon a newer build's claim took the lease from: it exits on observing the new lease. */
export interface ReplacedBotDaemon {
	readonly build?: string;
	readonly pid?: number;
}

export function describeDaemonReplacement(replaced: ReplacedBotDaemon, own: string | undefined): string {
	return `Replaced the daemon of ${replaced.build === undefined ? "an earlier build" : `build ${replaced.build}`}${replaced.pid !== undefined ? ` (pid ${replaced.pid})` : ""} with build ${own ?? "unknown"}; it exits on observing the new lease.`;
}

/** Whether `value` is a daemon lease token (`crypto.randomUUID()` spelling). */
export function isDaemonLeaseToken(value: string): boolean {
	return DAEMON_LEASE_TOKEN_REGEX.test(value);
}

export function daemonLeasePath(storeFilePath: string): string {
	return join(dirname(storeFilePath), "bot-daemon-token-lease.json");
}

/** The lease file of earlier builds: an inline-script daemon's heartbeat, or a first-generation token lease. */
function legacyDaemonLeasePath(storeFilePath: string): string {
	return join(dirname(storeFilePath), "bot-daemon-lease.json");
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isFresh(renewedAt: number | undefined, nowMs: number): boolean {
	return renewedAt !== undefined && Number.isFinite(renewedAt) && nowMs - renewedAt <= DAEMON_STALE_MS;
}

/** The JSON record in a lease file; undefined for no file or unreadable content (a legacy writer is not atomic). */
function readLeaseJson(path: string): Record<string, unknown> | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
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
	return isRecordObject(parsed) ? parsed : undefined;
}

function parseProcessOwner(value: unknown): ProcessOwner | undefined {
	if (!isRecordObject(value) || !isPositiveSafePid(value.pid)) return undefined;
	const { startTime, hostname, machineId } = value;
	return {
		pid: value.pid,
		...(typeof startTime === "string" ? { startTime } : {}),
		...(typeof hostname === "string" ? { hostname } : {}),
		...(typeof machineId === "string" ? { machineId } : {}),
	};
}

function parseDaemonReports(value: unknown): BotDaemonReport[] {
	if (!Array.isArray(value)) return [];
	const reports: BotDaemonReport[] = [];
	for (const item of value.slice(-MAX_DAEMON_REPORTS)) {
		if (!isRecordObject(item) || typeof item.message !== "string") continue;
		const at = finiteNumber(item.at);
		if (at !== undefined) reports.push({ at, message: item.message.slice(0, MAX_DAEMON_REPORT_CHARS) });
	}
	return reports;
}

function parseDaemonEnd(value: unknown): BotDaemonEnd | undefined {
	if (!isRecordObject(value)) return undefined;
	const at = finiteNumber(value.at);
	const { reason, detail } = value;
	if (at === undefined || (reason !== "released" && reason !== "signal" && reason !== "failed")) return undefined;
	return { reason, at, ...(typeof detail === "string" ? { detail: detail.slice(0, MAX_DAEMON_REPORT_CHARS) } : {}) };
}

/** The current lease, or undefined when there is none: no file, a released lease, or a record without a token. */
function readDaemonLease(leasePath: string): DaemonLeaseRecord | undefined {
	return daemonLeaseOf(readLeaseJson(leasePath));
}

function daemonLeaseOf(parsed: Record<string, unknown> | undefined): DaemonLeaseRecord | undefined {
	if (
		!parsed ||
		typeof parsed.token !== "string" ||
		!isDaemonLeaseToken(parsed.token) ||
		typeof parsed.startedAt !== "string"
	)
		return undefined;
	const build = parseDaemonBuild(parsed.build);
	const launcherPid = isPositiveSafePid(parsed.launcherPid) ? parsed.launcherPid : undefined;
	const owner = parseProcessOwner(parsed.owner);
	const lastHeartbeatAt = finiteNumber(parsed.lastHeartbeatAt);
	const lastTickAt = finiteNumber(parsed.lastTickAt);
	const reports = parseDaemonReports(parsed.reports);
	return {
		token: parsed.token,
		startedAt: parsed.startedAt,
		...(build !== undefined ? { build } : {}),
		...(launcherPid !== undefined ? { launcherPid } : {}),
		...(owner !== undefined ? { owner } : {}),
		...(lastHeartbeatAt !== undefined ? { lastHeartbeatAt } : {}),
		...(lastTickAt !== undefined ? { lastTickAt } : {}),
		...(reports.length > 0 ? { reports } : {}),
	};
}

/**
 * A lease is held while its daemon renewed it (or, before the first renewal, the starter claimed it) within the stale
 * window and that daemon is not proven gone. Only the token holder renews, so a reused pid cannot keep a lease held,
 * and a daemon on another host or one this host cannot judge is decided by freshness alone.
 */
function isDaemonLeaseHeld(lease: DaemonLeaseRecord, nowMs: number): boolean {
	if (!isFresh(lease.lastHeartbeatAt ?? Date.parse(lease.startedAt), nowMs)) return false;
	return lease.owner === undefined || judgeOwner(lease.owner) !== "dead";
}

function withLeaseLock<T>(leasePath: string, action: () => T): T {
	return withFileLockSync(leasePath, action, LOW_LATENCY_FILE_LOCK_OPTIONS);
}

function writeDaemonLease(leasePath: string, lease: DaemonLeaseRecord): void {
	writeFileAtomicSync(leasePath, JSON.stringify(lease, null, 2));
}

/** A released lease: when, how its daemon ended (when known) and the reports it left, so a later session reads them. */
function writeReleasedLease(
	leasePath: string,
	nowMs: number,
	end?: BotDaemonEnd,
	reports?: readonly BotDaemonReport[],
): void {
	writeFileAtomicSync(
		leasePath,
		JSON.stringify({
			releasedAt: nowMs,
			...(end ? { end } : {}),
			...(reports && reports.length > 0 ? { reports } : {}),
		}),
	);
}

/** An earlier build's daemon still renewing the old lease file: renewed in the stale window, pid not proven gone. */
function legacyDaemonClaimOf(
	parsed: Record<string, unknown> | undefined,
	nowMs: number,
): LegacyBotDaemonClaim | undefined {
	if (!parsed) return undefined;
	const lastHeartbeatAt = finiteNumber(parsed.lastHeartbeatAt);
	const startedAt = typeof parsed.startedAt === "string" ? Date.parse(parsed.startedAt) : undefined;
	if (!isFresh(lastHeartbeatAt ?? startedAt, nowMs)) return undefined;
	const pid = isPositiveSafePid(parsed.pid) ? parsed.pid : undefined;
	if (pid !== undefined && probeProcessLiveness(pid) === "dead") return undefined;
	const tokenDaemon = typeof parsed.token === "string" && isDaemonLeaseToken(parsed.token);
	return {
		kind: tokenDaemon ? "token-daemon" : "inline-script",
		...(pid !== undefined ? { pid } : {}),
		...(lastHeartbeatAt !== undefined ? { lastHeartbeatAt } : {}),
	};
}

/**
 * The daemon lease's state and the store's routine counts. A clock routine is due once its run may be claimed: at its
 * slot, or from its `readyBy` window's opening, which the unfinished `occurrences` of the routine hold shut as for the
 * claim ({@link routineOpensAt}).
 */
export function readDaemonLeaseStatus(
	storeFilePath: string,
	routines: Iterable<RoutineDefinitionView>,
	occurrences: readonly RoutineOccurrence[],
	nowMs = Date.now(),
): PersistentBotDaemonStatus {
	let activeRoutines = 0;
	let dueRoutines = 0;
	const awayRefusals: { routineId: string; reason: string; at: number }[] = [];
	for (const r of routines) {
		if (!r.enabled) continue;
		// An event routine has no slot: it stays active until it ends, and the daemon follows it for its closed session.
		const next = nextRoutineAt(r.schedule, r.cursor);
		// A watch is evaluated only while its session is open: the daemon has nothing to follow for it.
		if (r.schedule.kind === "event" && r.schedule.source === "watch") continue;
		if (r.schedule.kind === "event" ? routineEnded(r, nowMs) !== undefined : next === undefined) continue;
		activeRoutines++;
		if (next !== undefined && routineOpensAt(r, occurrences) <= nowMs) dueRoutines++;
		if (r.awayRefusal) awayRefusals.push({ routineId: r.routineId, ...r.awayRefusal });
	}
	const legacy = legacyDaemonClaimOf(readLeaseJson(legacyDaemonLeasePath(storeFilePath)), nowMs);
	const parsed = readLeaseJson(daemonLeasePath(storeFilePath));
	const lease = daemonLeaseOf(parsed);
	if (!lease) {
		const lastEnd = parseDaemonEnd(parsed?.end);
		return {
			running: false,
			activeRoutines,
			dueRoutines,
			awayRefusals,
			reports: parseDaemonReports(parsed?.reports),
			...(lastEnd ? { lastEnd } : {}),
			...(legacy ? { legacy } : {}),
		};
	}
	const running = isDaemonLeaseHeld(lease, nowMs);
	const pid = running ? (lease.owner?.pid ?? lease.launcherPid) : undefined;
	return {
		running,
		...(pid !== undefined ? { pid } : {}),
		startedAt: lease.startedAt,
		...(lease.build !== undefined ? { build: lease.build } : {}),
		...(lease.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: lease.lastHeartbeatAt } : {}),
		...(lease.lastTickAt !== undefined ? { lastTickAt: lease.lastTickAt } : {}),
		activeRoutines,
		dueRoutines,
		awayRefusals,
		reports: lease.reports ?? [],
		...(legacy ? { legacy } : {}),
	};
}

/** How the last daemon ended, while its released lease is still the current record (no later claim). */
export function readDaemonEnd(storeFilePath: string): BotDaemonEnd | undefined {
	const parsed = readLeaseJson(daemonLeasePath(storeFilePath));
	return daemonLeaseOf(parsed) ? undefined : parseDaemonEnd(parsed?.end);
}

export type DaemonLeaseClaim =
	| { readonly claimed: false }
	| { readonly claimed: true; readonly replaced?: ReplacedBotDaemon };

/**
 * Takes the lease for a daemon of `build` about to be started with `token`; not claimed while another holder of the
 * same or a newer build keeps it. A held lease of an older build is taken over under the same lock (`replaced`), so no
 * other start can claim between; its daemon exits on observing the new token, and its reports are kept, after one
 * naming the replacement.
 */
export function claimDaemonLeaseFile(
	storeFilePath: string,
	token: string,
	build: string | undefined,
	nowMs = Date.now(),
): DaemonLeaseClaim {
	const leasePath = daemonLeasePath(storeFilePath);
	return withLeaseLock(leasePath, () => {
		const current = readDaemonLease(leasePath);
		const held = current !== undefined && isDaemonLeaseHeld(current, nowMs);
		if (held && !isOlderDaemonBuild(current.build, build)) return { claimed: false };
		const pid = held ? (current.owner?.pid ?? current.launcherPid) : undefined;
		const replaced: ReplacedBotDaemon | undefined = held
			? { ...(current.build !== undefined ? { build: current.build } : {}), ...(pid !== undefined ? { pid } : {}) }
			: undefined;
		const reports = replaced
			? [...(current?.reports ?? []), { at: nowMs, message: describeDaemonReplacement(replaced, build) }].slice(
					-MAX_DAEMON_REPORTS,
				)
			: [];
		writeDaemonLease(leasePath, {
			token,
			startedAt: new Date(nowMs).toISOString(),
			...(build !== undefined ? { build } : {}),
			...(reports.length > 0 ? { reports } : {}),
		});
		return { claimed: true, ...(replaced ? { replaced } : {}) };
	});
}

/** Records the pid of the process the starter spawned for `token` (display only) while the lease is still `token`'s. */
export function recordDaemonLaunchPidFile(storeFilePath: string, token: string, launcherPid: number): void {
	const leasePath = daemonLeasePath(storeFilePath);
	withLeaseLock(leasePath, () => {
		const current = readDaemonLease(leasePath);
		if (current?.token === token) writeDaemonLease(leasePath, { ...current, launcherPid });
	});
}

/**
 * The daemon's renewal, stamping its own process identity and `build`: true while the lease is still `token`'s, false
 * once released or claimed by another start.
 */
export function renewDaemonLeaseFile(
	storeFilePath: string,
	token: string,
	owner: ProcessOwner,
	build: string | undefined,
	nowMs = Date.now(),
): boolean {
	const leasePath = daemonLeasePath(storeFilePath);
	return withLeaseLock(leasePath, () => {
		const current = readDaemonLease(leasePath);
		if (current?.token !== token) return false;
		const { build: _starterBuild, ...rest } = current;
		writeDaemonLease(leasePath, {
			...rest,
			...(build !== undefined ? { build } : {}),
			owner,
			lastHeartbeatAt: nowMs,
			lastTickAt: nowMs,
		});
		return true;
	});
}

/** Appends reports to `token`'s lease record, the oldest dropped past the bound; nothing once the lease is not `token`'s. */
export function recordDaemonReportsFile(
	storeFilePath: string,
	token: string,
	reports: readonly BotDaemonReport[],
): void {
	const leasePath = daemonLeasePath(storeFilePath);
	withLeaseLock(leasePath, () => {
		const current = readDaemonLease(leasePath);
		if (current?.token !== token) return;
		const kept = [
			...(current.reports ?? []),
			...reports.map((report) => ({ at: report.at, message: report.message.slice(0, MAX_DAEMON_REPORT_CHARS) })),
		].slice(-MAX_DAEMON_REPORTS);
		writeDaemonLease(leasePath, { ...current, reports: kept });
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
 * The released record keeps the daemon's reports and how it ended (`released` unless the daemon says otherwise).
 */
export function releaseDaemonLeaseFile(
	storeFilePath: string,
	token?: string,
	nowMs = Date.now(),
	end: Omit<BotDaemonEnd, "at"> = { reason: "released" },
): DaemonLeaseRelease {
	const leasePath = daemonLeasePath(storeFilePath);
	return withLeaseLock(leasePath, () => {
		const current = readDaemonLease(leasePath);
		if (!current || (token !== undefined && current.token !== token)) return { released: false };
		const detail = end.detail?.slice(0, MAX_DAEMON_REPORT_CHARS);
		writeReleasedLease(
			leasePath,
			nowMs,
			{ reason: end.reason, at: nowMs, ...(detail !== undefined ? { detail } : {}) },
			current.reports,
		);
		const pid = current.owner?.pid ?? current.launcherPid;
		return { released: true, held: isDaemonLeaseHeld(current, nowMs), ...(pid !== undefined ? { pid } : {}) };
	});
}

/**
 * Releases a first-generation `pi --bot-daemon` lease in the old lease file, under the lock that build renews it
 * with; that daemon exits once it observes the release. An inline-script heartbeat (no token) is left alone: the
 * process rewrites it regardless, and it stays the evidence of that daemon.
 */
export function releaseLegacyTokenDaemonLeaseFile(storeFilePath: string, nowMs = Date.now()): DaemonLeaseRelease {
	const leasePath = legacyDaemonLeasePath(storeFilePath);
	return withLeaseLock(leasePath, () => {
		const parsed = readLeaseJson(leasePath);
		if (!parsed || typeof parsed.token !== "string" || !isDaemonLeaseToken(parsed.token)) return { released: false };
		const claim = legacyDaemonClaimOf(parsed, nowMs);
		writeReleasedLease(leasePath, nowMs);
		return {
			released: true,
			held: claim !== undefined,
			...(claim?.pid !== undefined ? { pid: claim.pid } : {}),
		};
	});
}
