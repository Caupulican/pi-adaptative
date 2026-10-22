import type { SessionManager } from "../../kernel/session/session-manager.ts";
import {
	retainWorkerReceiptAdmission,
	type WorkerReceiptAnchor,
	type WorkerReceiptOrigin,
	workerReceiptOriginFromValue,
} from "../orchestration/worker-receipt-origin.ts";
import { isSessionAppendAnchorCurrent } from "../session-snapshot.ts";

/** Capture the command's original lineage without writing during a possible replay. */
export function captureWorkerReceiptAnchor(manager: SessionManager): WorkerReceiptAnchor {
	return { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), leafId: manager.getLeafId() };
}

/** Capture before admission can await. An empty branch gets an explicit, non-null lineage anchor. */
export function captureWorkerReceiptOrigin(
	manager: SessionManager,
	assertOuterCurrent?: () => void,
	anchor: WorkerReceiptAnchor = captureWorkerReceiptAnchor(manager),
): WorkerReceiptOrigin {
	assertOuterCurrent?.();
	if (manager.isPersistenceStateUncertain()) throw new Error("Worker receipt origin persistence is uncertain.");
	const assertCurrent = manager.captureBranchContext();
	const { sessionId, sessionFile } = anchor;
	if (manager.getSessionFile() !== sessionFile || !isSessionAppendAnchorCurrent(manager, anchor)) {
		throw new Error("Worker receipt origin changed before capture.");
	}
	const leafId = anchor.leafId ?? manager.appendCustomEntry("worker_receipt_origin", { version: 1 });
	manager.flushBufferedEntries();
	assertCurrent();
	const origin = Object.freeze(workerReceiptOriginFromValue({ sessionId, sessionFile, leafId }));
	if (manager.getSessionFile() !== sessionFile || !isSessionAppendAnchorCurrent(manager, origin)) {
		throw new Error("Worker receipt origin changed during capture.");
	}
	if (manager.isPersisted() && !manager.isEntryPersisted(leafId)) {
		throw new Error("Worker receipt origin was not persisted before admission.");
	}
	retainWorkerReceiptAdmission(origin, () => {
		assertOuterCurrent?.();
		assertCurrent();
		if (manager.isPersistenceStateUncertain()) throw new Error("Worker receipt origin persistence is uncertain.");
	});
	return origin;
}
