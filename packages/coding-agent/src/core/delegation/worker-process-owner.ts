import { probeProcessLiveness } from "@caupulican/pi-agent-core/process-tree";

const MAX_OWNER_ID_CHARS = 256;
const LOCAL_WORKER_OWNER_PATTERN =
	/^pi-worker:([1-9]\d*):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export interface LocalWorkerProcessOwner {
	pid: number;
	instanceId: string;
}

export type LocalWorkerProcessOwnerLiveness = "live" | "dead" | "unknown";

/**
 * Process liveness probe shared by lifecycle and reservation recovery. The raw OS classification is
 * owned once, by `@caupulican/pi-agent-core/process-tree`; this is only its boolean view.
 *
 * BOUND: `false` means ESRCH — proven absence. `true` means "not proven absent": a live process, a
 * process we may not signal (EPERM), or a probe that failed for an unclassified reason. Recovery must
 * therefore treat `true` as "do not take over", never as evidence the owner is running.
 */
export function isLocalProcessAlive(pid: number): boolean {
	return probeProcessLiveness(pid) !== "dead";
}

/** Create the durable identity for one local pi worker process instance. */
export function createLocalWorkerProcessOwnerId(pid: number, instanceId: string): string {
	if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError("Worker owner pid must be a positive safe integer.");
	const normalizedInstanceId = instanceId.trim().toLowerCase();
	const ownerId = `pi-worker:${pid}:${normalizedInstanceId}`;
	if (ownerId.length > MAX_OWNER_ID_CHARS || !parseLocalWorkerProcessOwnerId(ownerId)) {
		throw new TypeError("Worker owner instance id must be a UUID.");
	}
	return ownerId;
}

/** Parse only a complete, bounded pi-owned process identity. Unknown owner schemes remain untrusted. */
export function parseLocalWorkerProcessOwnerId(ownerId: string): LocalWorkerProcessOwner | undefined {
	if (ownerId.length === 0 || ownerId.length > MAX_OWNER_ID_CHARS || ownerId.trim() !== ownerId) return undefined;
	const matched = LOCAL_WORKER_OWNER_PATTERN.exec(ownerId);
	if (!matched) return undefined;
	const pid = Number(matched[1]);
	if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
	return { pid, instanceId: matched[2]!.toLowerCase() };
}

/**
 * Resolve a local owner exactly once through the caller's liveness seam. Invalid identities and
 * liveness probe failures stay unknown so recovery cannot steal a potentially active worker.
 *
 * The seam is a boolean by contract, so a probe that could not classify its failure arrives here as
 * `true` and is reported `live`. That is deliberate and conservative: only `dead` authorizes a
 * takeover, so an unclassified probe withholds authority exactly like an explicitly unknown one. A
 * seam that throws instead of answering is still reported `unknown`.
 */
export function localWorkerProcessOwnerLiveness(
	ownerId: string,
	isProcessAlive: (pid: number) => boolean,
): LocalWorkerProcessOwnerLiveness {
	const owner = parseLocalWorkerProcessOwnerId(ownerId);
	if (!owner) return "unknown";
	try {
		return isProcessAlive(owner.pid) ? "live" : "dead";
	} catch {
		return "unknown";
	}
}

export function isLocalWorkerProcessOwnerProvenDead(
	ownerId: string,
	isProcessAlive: (pid: number) => boolean,
): boolean {
	return localWorkerProcessOwnerLiveness(ownerId, isProcessAlive) === "dead";
}
