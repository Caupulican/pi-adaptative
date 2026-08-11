import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import type { WorkerClaim, WorkerRequest } from "../autonomy/contracts.ts";
import {
	decodeSessionSnapshotPayload,
	getActiveSessionBranchEntries,
	getSessionSnapshots,
	isVersionOneSessionSnapshotPayload,
	type SessionBranchEntrySource,
	type SessionSnapshotCodec,
	type SessionSnapshotPayload,
} from "../session-snapshot.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	cloneWorkerClaimForStorage,
	isParentReviewRequired,
	isWorkerClaim,
	normalizeWorkerClaimForHost,
} from "./worker-claim.ts";

export const WORKER_CLAIM_CUSTOM_TYPE = "worker_claim";

export type WorkerClaimSnapshotPayload = SessionSnapshotPayload<"claim", WorkerClaim> & {
	/** The originating request, when the host has one, makes a claim auditable against the
	 * instructions, route, and capability envelope that bounded it. */
	request?: WorkerRequest;
};

const WORKER_CLAIM_SNAPSHOT_CODEC: SessionSnapshotCodec<WorkerClaim, "claim"> = {
	customType: WORKER_CLAIM_CUSTOM_TYPE,
	valueKey: "claim",
	isValue: isWorkerClaim,
	clone: cloneWorkerClaimForStorage,
};

export function appendWorkerClaimSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	claim: WorkerClaim,
	request?: WorkerRequest,
	/** Baseline for relative changedFiles when re-deriving the review marker; forwarded to
	 * `isParentReviewRequired`/`validateWorkerClaim`. Defaults to `process.cwd()`, matching the
	 * validator's own documented default for single-cwd-per-process callers. */
	options?: { cwd?: string },
): string {
	const normalizedClaim = normalizeWorkerClaimForHost(claim);
	const stored = cloneWorkerClaimForStorage(normalizedClaim);
	// Stamp the parent-review marker here by re-running the SAME gate
	// (validateWorkerClaim, via isParentReviewRequired) that originally decided
	// ask-user/parent_review_required, so the marker can never drift from the gate's own verdict.
	// Only computable when `request` is available; externally managed lanes leave the field unset —
	// "unknown", never falsely "false".
	if (request) {
		stored.parentReviewRequired = isParentReviewRequired({ request, claim: normalizedClaim, cwd: options?.cwd });
	}
	const payload: WorkerClaimSnapshotPayload = {
		version: 1,
		claim: stored,
		...(request ? { request: structuredClone(request) } : {}),
	};
	return sessionManager.appendCustomEntry(WORKER_CLAIM_CUSTOM_TYPE, payload);
}

/** Requests persisted alongside worker claims. */
export function getWorkerRequestSnapshots(entries: readonly SessionEntry[]): WorkerRequest[] {
	const requests: WorkerRequest[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== WORKER_CLAIM_CUSTOM_TYPE) continue;
		const payload = entry.data;
		if (!isVersionOneSessionSnapshotPayload(payload)) continue;
		const request = payload.request;
		if (isPlainRecord(request) && typeof request.id === "string") {
			requests.push(structuredClone(request) as unknown as WorkerRequest);
		}
	}
	return requests;
}

export function getWorkerClaimSnapshots(entries: readonly SessionEntry[]): WorkerClaim[] {
	return getSessionSnapshots(entries, WORKER_CLAIM_SNAPSHOT_CODEC);
}

/**
 * Latest persisted snapshot (claim + originating request, when available) for one worker
 * requestId — "latest wins" over the append-only entries, the same collapse `delegate status`
 * performs when it maps results by requestId. Used to read, and durably update, the
 * parent-review marker.
 */
export function getLatestWorkerClaimSnapshot(
	entries: readonly SessionEntry[],
	requestId: string,
): WorkerClaimSnapshotPayload | undefined {
	let latest: WorkerClaimSnapshotPayload | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== WORKER_CLAIM_CUSTOM_TYPE) continue;
		const payload = entry.data;
		if (!isVersionOneSessionSnapshotPayload(payload)) continue;
		const claim = decodeSessionSnapshotPayload(payload, WORKER_CLAIM_SNAPSHOT_CODEC);
		if (!claim || claim.requestId !== requestId) continue;
		const request = payload.request;
		latest = {
			version: 1,
			claim,
			...(isPlainRecord(request) && typeof request.id === "string"
				? { request: structuredClone(request) as unknown as WorkerRequest }
				: {}),
		};
	}
	return latest;
}

export type AcknowledgeWorkerReviewReason = "unknown_worker_claim" | "not_flagged" | "already_reviewed";

export type AcknowledgeWorkerReviewResult =
	| { ok: true; requestId: string; reviewedAt: string }
	| { ok: false; reason: AcknowledgeWorkerReviewReason };

/**
 * Durably acknowledge an unreviewed worker mutation. Re-appends the latest snapshot for
 * `requestId` with `parentReviewedAt` set, so the ack is a first-class entry in the same
 * append-only audit trail as the original claim — it survives reload and any future re-read of
 * `getWorkerClaimSnapshots`/`getLatestWorkerClaimSnapshot` (both are "latest wins"). Never
 * write-blocking: this only marks the mutation reviewed, it does not touch the worker's files.
 */
export function acknowledgeWorkerClaimReview(
	sessionManager: Pick<SessionManager, "appendCustomEntry"> & SessionBranchEntrySource,
	requestId: string,
	now: () => string = () => new Date().toISOString(),
): AcknowledgeWorkerReviewResult {
	const latest = getLatestWorkerClaimSnapshot(getActiveSessionBranchEntries(sessionManager), requestId);
	if (!latest) return { ok: false, reason: "unknown_worker_claim" };
	if (!latest.claim.parentReviewRequired) return { ok: false, reason: "not_flagged" };
	if (latest.claim.parentReviewedAt) return { ok: false, reason: "already_reviewed" };
	const reviewedAt = now();
	appendWorkerClaimSnapshot(sessionManager, { ...latest.claim, parentReviewedAt: reviewedAt }, latest.request);
	return { ok: true, requestId, reviewedAt };
}
