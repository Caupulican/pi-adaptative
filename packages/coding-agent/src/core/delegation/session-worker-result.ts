import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import type { WorkerRequest, WorkerResult } from "../autonomy/contracts.ts";
import { cloneWorkerResultForStorage, isParentReviewRequired, isWorkerResult } from "./worker-result.ts";

export const WORKER_RESULT_CUSTOM_TYPE = "worker_result";

export interface WorkerResultSnapshotPayload {
	version: 1;
	result: WorkerResult;
	/** The originating request: persisted so a result is auditable against exactly what was
	 * asked — instructions, route, and the capability envelope that bounded it. Optional for
	 * backward compatibility with entries recorded before this field existed. */
	request?: WorkerRequest;
}

export function appendWorkerResultSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	result: WorkerResult,
	request?: WorkerRequest,
	/** Baseline for relative changedFiles when re-deriving the review marker; forwarded to
	 * `isParentReviewRequired`/`validateWorkerResult`. Defaults to `process.cwd()`, matching the
	 * validator's own documented default for single-cwd-per-process callers. */
	options?: { cwd?: string },
): string {
	const stored = cloneWorkerResultForStorage(result);
	// Stamp the parent-review marker here by re-running the SAME gate
	// (validateWorkerResult, via isParentReviewRequired) that originally decided
	// ask-user/parent_review_required, so the marker can never drift from the gate's own verdict.
	// Only computable when `request` is available; callers that omit it (legacy callers) leave the
	// field unset — "unknown", never falsely "false".
	if (request) {
		stored.parentReviewRequired = isParentReviewRequired({ request, result, cwd: options?.cwd });
	}
	const payload: WorkerResultSnapshotPayload = {
		version: 1,
		result: stored,
		...(request ? { request: structuredClone(request) } : {}),
	};
	return sessionManager.appendCustomEntry(WORKER_RESULT_CUSTOM_TYPE, payload);
}

/** Requests persisted alongside results (absent for entries recorded before this field existed). */
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

/**
 * Latest persisted snapshot (result + originating request, when available) for one worker
 * requestId — "latest wins" over the append-only entries, the same collapse `delegate_status`
 * already performs when it maps results by requestId. Used to read, and durably update, the
 * parent-review marker.
 */
export function getLatestWorkerResultSnapshot(
	entries: readonly SessionEntry[],
	requestId: string,
): WorkerResultSnapshotPayload | undefined {
	let latest: WorkerResultSnapshotPayload | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== WORKER_RESULT_CUSTOM_TYPE) continue;
		const payload = entry.data;
		if (!isPlainRecord(payload) || payload.version !== 1 || !("result" in payload)) continue;
		const result = payload.result;
		if (!isWorkerResult(result) || result.requestId !== requestId) continue;
		const request = payload.request;
		latest = {
			version: 1,
			result: cloneWorkerResultForStorage(result),
			...(isPlainRecord(request) && typeof request.id === "string"
				? { request: structuredClone(request) as unknown as WorkerRequest }
				: {}),
		};
	}
	return latest;
}

export type AcknowledgeWorkerReviewReason = "unknown_worker_result" | "not_flagged" | "already_reviewed";

export type AcknowledgeWorkerReviewResult =
	| { ok: true; requestId: string; reviewedAt: string }
	| { ok: false; reason: AcknowledgeWorkerReviewReason };

/**
 * Durably acknowledge an unreviewed worker mutation. Re-appends the latest snapshot for
 * `requestId` with `parentReviewedAt` set, so the ack is a first-class entry in the same
 * append-only audit trail as the original result — it survives reload and any future re-read of
 * `getWorkerResultSnapshots`/`getLatestWorkerResultSnapshot` (both are "latest wins"). Never
 * write-blocking: this only marks the mutation reviewed, it does not touch the worker's files.
 */
export function acknowledgeWorkerResultReview(
	sessionManager: Pick<SessionManager, "appendCustomEntry" | "getEntries">,
	requestId: string,
	now: () => string = () => new Date().toISOString(),
): AcknowledgeWorkerReviewResult {
	const latest = getLatestWorkerResultSnapshot(sessionManager.getEntries(), requestId);
	if (!latest) return { ok: false, reason: "unknown_worker_result" };
	if (!latest.result.parentReviewRequired) return { ok: false, reason: "not_flagged" };
	if (latest.result.parentReviewedAt) return { ok: false, reason: "already_reviewed" };
	const reviewedAt = now();
	appendWorkerResultSnapshot(sessionManager, { ...latest.result, parentReviewedAt: reviewedAt }, latest.request);
	return { ok: true, requestId, reviewedAt };
}
