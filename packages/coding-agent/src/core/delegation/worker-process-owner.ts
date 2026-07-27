const MAX_OWNER_ID_CHARS = 256;
const LOCAL_WORKER_OWNER_PATTERN =
	/^pi-worker:([1-9]\d*):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export interface LocalWorkerProcessOwner {
	pid: number;
	instanceId: string;
}

export type LocalWorkerProcessOwnerLiveness = "live" | "dead" | "unknown";

/** Process liveness probe shared by lifecycle and reservation recovery. Permission denial means live. */
export function isLocalProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && (error as { code?: string }).code === "EPERM";
	}
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
