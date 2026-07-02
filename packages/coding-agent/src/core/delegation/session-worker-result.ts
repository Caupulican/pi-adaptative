import type { WorkerRequest, WorkerResult } from "../autonomy/contracts.ts";
import type { SessionEntry, SessionManager } from "../session-manager.ts";
import { cloneWorkerResultForStorage, isWorkerResult } from "./worker-result.ts";

export const WORKER_RESULT_CUSTOM_TYPE = "worker_result";

export interface WorkerResultSnapshotPayload {
	version: 1;
	result: WorkerResult;
	/** The originating request (G2): persisted so a result is auditable against exactly what was
	 * asked — instructions, route, and the capability envelope that bounded it. Optional for
	 * backward compatibility with pre-G2 entries. */
	request?: WorkerRequest;
}

export function appendWorkerResultSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	result: WorkerResult,
	request?: WorkerRequest,
): string {
	const payload: WorkerResultSnapshotPayload = {
		version: 1,
		result: cloneWorkerResultForStorage(result),
		...(request ? { request: structuredClone(request) } : {}),
	};
	return sessionManager.appendCustomEntry(WORKER_RESULT_CUSTOM_TYPE, payload);
}

/** Requests persisted alongside results (absent for pre-G2 entries). */
export function getWorkerRequestSnapshots(entries: readonly SessionEntry[]): WorkerRequest[] {
	const requests: WorkerRequest[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== WORKER_RESULT_CUSTOM_TYPE) continue;
		const payload = entry.data;
		if (!isPlainRecord(payload) || payload.version !== 1) continue;
		const request = payload.request;
		if (isPlainRecord(request) && typeof request.id === "string") {
			requests.push(structuredClone(request) as unknown as WorkerRequest);
		}
	}
	return requests;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function getWorkerResultSnapshots(entries: readonly SessionEntry[]): WorkerResult[] {
	const results: WorkerResult[] = [];

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== WORKER_RESULT_CUSTOM_TYPE) {
			continue;
		}

		const payload = entry.data;
		if (!isPlainRecord(payload)) continue;
		if (payload.version !== 1) continue;
		if (!("result" in payload)) continue;
		const result = payload.result;
		if (isWorkerResult(result)) {
			results.push(cloneWorkerResultForStorage(result));
		}
	}

	return results;
}
