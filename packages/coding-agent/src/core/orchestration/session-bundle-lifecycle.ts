import { existsSync } from "node:fs";
import { orchestrationSessionDeletionFile } from "../agent-paths.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";

/** Lock order is bundle admission, then transcript. Never hold either across asynchronous removal. */
export function withSessionBundleAdmission<T>(agentDir: string, parentSessionId: string, operation: () => T): T {
	const tombstone = orchestrationSessionDeletionFile(agentDir, parentSessionId);
	return withFileLockSync(tombstone, () => {
		if (existsSync(tombstone)) throw new Error("Worker session bundle deletion has been reserved.");
		return operation();
	});
}

/**
 * The reservation survives removal errors and crashes. Explicit deletion may retry it; context
 * creation and transfer cannot. The adapter inspects its authoritative claims under this lock.
 */
export function reserveSessionBundleDeletion(
	agentDir: string,
	parentSessionId: string,
	canDelete: () => boolean,
): boolean {
	const tombstone = orchestrationSessionDeletionFile(agentDir, parentSessionId);
	return withFileLockSync(tombstone, () => {
		if (!canDelete()) return false;
		if (!existsSync(tombstone)) writeFileAtomicSync(tombstone, JSON.stringify({ schemaVersion: 1, parentSessionId }));
		return true;
	});
}
