import { existsSync, rmSync } from "node:fs";
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

/**
 * Reopen admission after retention removed a bundle in full. Explicit deletion keeps its tombstone so
 * a deleted session's late worker cannot recreate context; retention removes bundles of sessions that
 * may still be resumed, and a resumed session must be able to start workers again.
 */
export function releaseSessionBundleDeletion(agentDir: string, parentSessionId: string): void {
	const tombstone = orchestrationSessionDeletionFile(agentDir, parentSessionId);
	withFileLockSync(tombstone, () => rmSync(tombstone, { force: true }));
}
