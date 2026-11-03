/**
 * Who owns a record, and whether that owner is still there.
 *
 * Every durable record that a later process may need to reclaim (a lease, a lock, a journal, a matrix entry, a
 * controller binding) names its owner by the same four facts: pid, the owner's process start time, and the host,
 * identified by the stable OS machine id with the hostname as the fallback. This module is the one place that
 * writes those facts ({@link ownProcessOwner}) and the one place that judges them ({@link judgeOwner}), so a
 * store never compares `os.hostname()` or probes a pid on its own.
 *
 * The judgement has four outcomes and a store must treat each deliberately:
 * - `alive`: same host, the pid answers and (when a start time was recorded) it is the same process.
 * - `dead`: same host, and the owner is PROVEN gone (ESRCH, or the pid now names a process with another start time).
 *   The only outcome that authorizes reclaiming the owner's record.
 * - `foreign`: the record names another host. A pid means nothing here; the record is neither reclaimed nor judged
 *   by this host's pids. Age-based expiry (a heartbeat the owner keeps renewing) is the only way such a record ends.
 * - `unknown`: the judgement could not be made. Either the probe proved neither answer (EPERM with an unreadable
 *   procfs entry, an unclassified error), or the record names a machine id and this process cannot read its own yet
 *   (macOS/Windows read it asynchronously), so it cannot tell its own records from a foreign machine's. Never reclaim
 *   on `unknown`.
 */
import { type HostIdentity, isRecordedOnHost, readHostIdentity } from "./host-identity.ts";
import { type ProcessLivenessProbe, probeProcessIdentityLiveness, readOwnProcessStartTime } from "./process-tree.ts";

/** The persisted description of a process owner. Every field but `pid` is optional so older records still parse. */
export interface ProcessOwner {
	pid: number;
	/** The owner's Linux process start time ({@link readOwnProcessStartTime}); absent off Linux and on older records. */
	startTime?: string;
	/** `os.hostname()` when written. Decides locality only when {@link machineId} is absent. */
	hostname?: string;
	/** Digest of the OS machine id ({@link readHostIdentity}); absent until it is readable and on older records. */
	machineId?: string;
}

export type OwnerStanding = "alive" | "dead" | "foreign" | "unknown";

/** A {@link ProcessOwner} written by this host: it always names the hostname. */
export type OwnProcessOwner = ProcessOwner & { hostname: string };

const START_TIME_PATTERN = /^\d{1,32}$/;
const MACHINE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** A persisted optional start time: absent, or the digits {@link readOwnProcessStartTime} writes. */
export function isOwnerStartTimeField(value: unknown): value is string | undefined {
	return value === undefined || (typeof value === "string" && START_TIME_PATTERN.test(value));
}

/** A persisted optional machine id: absent, or the digest {@link readHostIdentity} writes. */
export function isOwnerMachineIdField(value: unknown): value is string | undefined {
	return value === undefined || (typeof value === "string" && MACHINE_ID_PATTERN.test(value));
}

/** Whether a parsed persisted value is a well-formed {@link ProcessOwner}; unknown extra keys are the caller's concern. */
export function isProcessOwnerRecord(value: unknown): value is ProcessOwner {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.pid === "number" &&
		Number.isSafeInteger(record.pid) &&
		record.pid > 0 &&
		isOwnerStartTimeField(record.startTime) &&
		(record.hostname === undefined || (typeof record.hostname === "string" && record.hostname.length <= 255)) &&
		isOwnerMachineIdField(record.machineId)
	);
}

/**
 * `pid` (default: this process) as a record owner on this host. Only this process can read its own start time, so any
 * other pid is described by its host facts alone and judged by the plain pid probe.
 */
export function ownProcessOwner(pid: number = process.pid): OwnProcessOwner {
	const host = readHostIdentity();
	const startTime = pid === process.pid ? readOwnProcessStartTime() : undefined;
	return {
		pid,
		...(startTime !== undefined ? { startTime } : {}),
		hostname: host.hostname,
		...(host.machineId !== undefined ? { machineId: host.machineId } : {}),
	};
}

export interface JudgeOwnerOptions {
	/** The host the judgement runs on. Default: this process's. */
	host?: HostIdentity;
	/** The same-host pid probe both observations use. Default: the OS probe. */
	observe?: (pid: number) => ProcessLivenessProbe;
	/**
	 * How to read a record that names no host at all (it predates host recording). `local` (default) means this host
	 * wrote it, which is what every pre-recording writer was; `foreign` refuses to judge it.
	 */
	unrecordedHost?: "local" | "foreign";
}

export function judgeOwner(owner: ProcessOwner, options: JudgeOwnerOptions = {}): OwnerStanding {
	const host = options.host ?? readHostIdentity();
	const unrecorded = owner.hostname === undefined && owner.machineId === undefined;
	// A record that names a machine id can only be placed by a process that knows its own: until then it is not foreign, just unplaceable.
	if (owner.machineId !== undefined && host.machineId === undefined) return "unknown";
	if (unrecorded ? options.unrecordedHost === "foreign" : !isRecordedOnHost(owner, host)) return "foreign";
	const probe = options.observe
		? probeProcessIdentityLiveness(owner.pid, owner.startTime, options.observe)
		: probeProcessIdentityLiveness(owner.pid, owner.startTime);
	return probe;
}

/** True only for a same-host owner PROVEN gone: the sole standing that authorizes reclaiming its record. */
export function isOwnerProvenDead(owner: ProcessOwner, options?: JudgeOwnerOptions): boolean {
	return judgeOwner(owner, options) === "dead";
}
