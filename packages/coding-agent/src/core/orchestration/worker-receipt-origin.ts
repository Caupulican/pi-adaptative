import { readWireRecord } from "../../kernel/wire-record.ts";
import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH, MAX_WORKER_AUTHORITY_PATH_LENGTH } from "./contracts.ts";

/** Parent lineage that admitted work, independent of a reusable worker's immutable birth context. */
export interface WorkerReceiptAnchor {
	readonly sessionId: string;
	readonly sessionFile?: string;
	readonly leafId: string | null;
}

export interface WorkerReceiptOrigin extends WorkerReceiptAnchor {
	readonly leafId: string;
}

const admissions = new WeakMap<WorkerReceiptOrigin, () => void>();

/** Live admission fences are deliberately absent from serialized and recovered origins. */
export function retainWorkerReceiptAdmission(origin: WorkerReceiptOrigin, assertCurrent: () => void): void {
	admissions.set(origin, assertCurrent);
}

export function inheritWorkerReceiptAdmission(
	source: WorkerReceiptOrigin | undefined,
	target: WorkerReceiptOrigin | undefined,
): void {
	if (!source || !target) return;
	const guard = admissions.get(source);
	if (guard) admissions.set(target, guard);
}

export function assertWorkerReceiptAdmission(origin: WorkerReceiptOrigin | undefined): void {
	if (origin) admissions.get(origin)?.();
}

const ORIGIN_KEYS = new Set(["sessionId", "sessionFile", "leafId"]);

function boundedIdentity(value: unknown, limit: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= limit && !value.includes("\0");
}

/** One strict value decoder shared by durable dispatch and mailbox storage. */
export function workerReceiptOriginFromValue(value: unknown): WorkerReceiptOrigin {
	const origin = readWireRecord(value, ORIGIN_KEYS);
	if (
		!origin ||
		!boundedIdentity(origin.sessionId, MAX_ORCHESTRATION_IDENTIFIER_LENGTH) ||
		!boundedIdentity(origin.leafId, MAX_ORCHESTRATION_IDENTIFIER_LENGTH) ||
		(origin.sessionFile !== undefined && !boundedIdentity(origin.sessionFile, MAX_WORKER_AUTHORITY_PATH_LENGTH))
	)
		throw new TypeError("Worker receipt origin is invalid.");
	return {
		sessionId: origin.sessionId,
		leafId: origin.leafId,
		...(origin.sessionFile === undefined ? {} : { sessionFile: origin.sessionFile }),
	};
}
