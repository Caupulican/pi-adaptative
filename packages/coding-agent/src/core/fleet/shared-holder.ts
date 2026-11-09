/**
 * Liveness of a record a process left in a shared fleet file: the holders alive in this process, and the pid check for
 * every other process. A record is void past its age bound whoever wrote it (a hung holder, or a reused pid).
 */

/** A record a holder left in a shared fleet file: whose it is, the process that wrote it, and when it was made. */
export interface HolderRecord {
	readonly holder: string;
	readonly pid: number;
	readonly at: number;
}

/** The holder ids of every instance alive in this process. */
const liveHolders = new Set<string>();

export function addLiveHolder(holder: string): void {
	liveHolders.add(holder);
}

export function removeLiveHolder(holder: string): void {
	liveHolders.delete(holder);
}

export function isLiveHolder(holder: string): boolean {
	return liveHolders.has(holder);
}

/** Whether another process is still running on this machine. */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * False past `maxAgeMs`; true for a holder alive in this process; otherwise true only for a record of another process
 * whose pid still runs.
 */
export function holderAlive(record: HolderRecord, now: number, maxAgeMs: number): boolean {
	if (now - record.at > maxAgeMs) return false;
	if (liveHolders.has(record.holder)) return true;
	return record.pid !== process.pid && processAlive(record.pid);
}
