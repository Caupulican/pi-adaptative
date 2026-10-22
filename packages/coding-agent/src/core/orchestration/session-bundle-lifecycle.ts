import { randomUUID } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { probeProcessLiveness } from "../../kernel/reliability/process-tree.ts";
import { orchestrationSessionDeletionFile, orchestrationSessionDir } from "../agent-paths.ts";
import { isMissingFileError, withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readOptionalBoundedTextFileSync } from "../util/bounded-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

export type SessionBundleDeletionPolicy = "retention" | "permanent";

export interface SessionBundleDeletionReservation {
	readonly parentSessionId: string;
	readonly token: string;
}

interface DeletionOperation {
	token: string;
	host: string;
	pid: number;
	processInstanceId: string;
	/** Only this operation created the absent marker; a resumed operation never inherits it. */
	fresh: boolean;
}

interface DeletionMarker {
	schemaVersion: 2;
	parentSessionId: string;
	policy: SessionBundleDeletionPolicy;
	operation?: DeletionOperation;
}

const MAX_MARKER_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROCESS_INSTANCE_ID = randomUUID();
const activeOperations = new Set<string>();

function readMarker(file: string, parentSessionId: string): DeletionMarker | undefined {
	const text = readOptionalBoundedTextFileSync(file, MAX_MARKER_BYTES, "Session bundle deletion marker");
	if (text === undefined) return undefined;
	const value: unknown = JSON.parse(text);
	if (
		!isPlainRecord(value) ||
		value.schemaVersion !== 2 ||
		value.parentSessionId !== parentSessionId ||
		(value.policy !== "retention" && value.policy !== "permanent") ||
		Object.keys(value).some((key) => !["schemaVersion", "parentSessionId", "policy", "operation"].includes(key))
	) {
		throw new Error("Session bundle deletion marker requires inspection; its ownership or policy is unknown.");
	}
	const operation = value.operation;
	if (
		operation !== undefined &&
		(!isPlainRecord(operation) ||
			Object.keys(operation).length !== 5 ||
			typeof operation.token !== "string" ||
			!UUID_PATTERN.test(operation.token) ||
			typeof operation.processInstanceId !== "string" ||
			!UUID_PATTERN.test(operation.processInstanceId) ||
			typeof operation.host !== "string" ||
			!operation.host ||
			operation.host.length > 512 ||
			typeof operation.pid !== "number" ||
			!Number.isSafeInteger(operation.pid) ||
			operation.pid < 1 ||
			typeof operation.fresh !== "boolean")
	) {
		throw new Error("Session bundle deletion operation is invalid.");
	}
	return value as unknown as DeletionMarker;
}

function writeMarker(file: string, marker: DeletionMarker): void {
	const text = `${JSON.stringify(marker)}\n`;
	if (Buffer.byteLength(text) > MAX_MARKER_BYTES) throw new Error("Session bundle deletion marker is too large.");
	writeFileAtomicSync(file, text);
}

function canRecoverOperation(operation: DeletionOperation): boolean {
	if (operation.host !== hostname()) return false;
	if (operation.pid === process.pid && operation.processInstanceId === PROCESS_INSTANCE_ID) {
		return !activeOperations.has(operation.token);
	}
	return probeProcessLiveness(operation.pid) === "dead";
}

/** A retained cleanup already passed age admission; its own partial writes do not restart that age. */
export function hasPendingSessionBundleRetention(agentDir: string, parentSessionId: string): boolean {
	return (
		readMarker(orchestrationSessionDeletionFile(agentDir, parentSessionId), parentSessionId)?.policy === "retention"
	);
}

/** Lock order is bundle admission, then transcript. No filesystem lock spans asynchronous removal. */
export function withSessionBundleAdmission<T>(agentDir: string, parentSessionId: string, operation: () => T): T {
	const tombstone = orchestrationSessionDeletionFile(agentDir, parentSessionId);
	return withFileLockSync(tombstone, () => {
		const marker = readMarker(tombstone, parentSessionId);
		if (marker) {
			let removalConfirmed = false;
			if (marker.policy === "retention" && (!marker.operation || canRecoverOperation(marker.operation))) {
				try {
					lstatSync(orchestrationSessionDir(agentDir, parentSessionId));
				} catch (error) {
					if (!isMissingFileError(error)) throw error;
					removalConfirmed = true;
				}
			}
			if (!removalConfirmed) throw new Error("Worker session bundle deletion has been reserved.");
			// The original remover is settled/dead and its bundle is absent. Recover an interrupted
			// marker cleanup here: a directory-only sweep can no longer discover this completed removal.
			unlinkSync(tombstone);
		}
		return operation();
	});
}

/** One removal owns a token; permanent intent can be promoted without admitting a second remover. */
export function reserveSessionBundleDeletion(
	agentDir: string,
	parentSessionId: string,
	policy: SessionBundleDeletionPolicy,
	canDelete: () => boolean,
	/** A caller that bypassed age checks must not acquire a fresh deletion after a stale hint. */
	requireExistingRetention = false,
): SessionBundleDeletionReservation | undefined {
	const tombstone = orchestrationSessionDeletionFile(agentDir, parentSessionId);
	return withFileLockSync(tombstone, () => {
		let marker = readMarker(tombstone, parentSessionId);
		if (requireExistingRetention && marker?.policy !== "retention") return undefined;
		const fresh = marker === undefined;
		if (marker?.policy === "permanent" && policy === "retention") return undefined;
		// Explicit foreground deletion may already have happened, so preserve its intent even while
		// another remover or a live worker prevents this request from acquiring removal ownership.
		if (policy === "permanent" && marker?.policy !== "permanent") {
			marker = { ...(marker ?? { schemaVersion: 2, parentSessionId }), policy };
			writeMarker(tombstone, marker);
		}
		if (marker?.operation && !canRecoverOperation(marker.operation)) return undefined;
		if (!canDelete()) return undefined;
		const token = randomUUID();
		const next: DeletionMarker = {
			schemaVersion: 2,
			parentSessionId,
			policy: marker?.policy ?? policy,
			operation: { token, host: hostname(), pid: process.pid, processInstanceId: PROCESS_INSTANCE_ID, fresh },
		};
		activeOperations.add(token);
		try {
			writeMarker(tombstone, next);
			return Object.freeze({ parentSessionId, token });
		} catch (error) {
			activeOperations.delete(token);
			throw error;
		}
	});
}

/** Settle only after physical removal ends. A failed/partial removal keeps the admission barrier. */
export function settleSessionBundleDeletion(
	agentDir: string,
	reservation: SessionBundleDeletionReservation,
	outcome: "removed" | "deferred" | "retained",
): void {
	const tombstone = orchestrationSessionDeletionFile(agentDir, reservation.parentSessionId);
	try {
		withFileLockSync(tombstone, () => {
			const marker = readMarker(tombstone, reservation.parentSessionId);
			if (!marker?.operation || marker.operation.token !== reservation.token) {
				throw new Error("Session bundle deletion ownership changed before settlement.");
			}
			// Consult current durable policy: an explicit deletion may have promoted this reservation
			// while its original retention owner was awaiting physical removal.
			if (
				marker.policy === "retention" &&
				(outcome === "removed" || (outcome === "deferred" && marker.operation.fresh))
			) {
				unlinkSync(tombstone);
			} else {
				writeMarker(tombstone, {
					schemaVersion: 2,
					parentSessionId: marker.parentSessionId,
					policy: marker.policy,
				});
			}
		});
	} finally {
		// Even failed metadata settlement follows a physically settled operation. This exact process
		// can safely reclaim it; peers still need proven process absence before taking it over.
		activeOperations.delete(reservation.token);
	}
}
