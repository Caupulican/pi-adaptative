import type { WorkerResult } from "../autonomy/contracts.ts";
import type { SessionEntry, SessionManager } from "../session-manager.ts";
import { cloneWorkerResultForStorage, isWorkerResult } from "./worker-result.ts";

export const WORKER_RESULT_CUSTOM_TYPE = "worker_result";

export interface WorkerResultSnapshotPayload {
	version: 1;
	result: WorkerResult;
}

export function appendWorkerResultSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	result: WorkerResult,
): string {
	const payload: WorkerResultSnapshotPayload = {
		version: 1,
		result: cloneWorkerResultForStorage(result),
	};
	return sessionManager.appendCustomEntry(WORKER_RESULT_CUSTOM_TYPE, payload);
}

export function getWorkerResultSnapshots(entries: readonly SessionEntry[]): WorkerResult[] {
	const results: WorkerResult[] = [];

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== WORKER_RESULT_CUSTOM_TYPE) {
			continue;
		}

		const payload = entry.data;
		if (!payload || typeof payload !== "object" || !("version" in payload)) continue;
		const record = payload as Record<string, unknown>;
		if (record.version !== 1) continue;
		if (!("result" in record)) continue;
		const result = record.result;
		if (isWorkerResult(result)) {
			results.push(cloneWorkerResultForStorage(result));
		}
	}

	return results;
}
