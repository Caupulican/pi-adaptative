import { isDeepStrictEqual } from "node:util";
import { isPositiveSafePid } from "../../kernel/reliability/process-tree.ts";
import { MAX_PERSISTED_CUSTOM_ENTRY_BYTES } from "../session-entry-persistence.ts";
import type { SessionAppendAnchor } from "../session-snapshot.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { isLearningAuditRecord, type LearningAuditRecord } from "./learning-audit.ts";

export interface LearningWriteRecord {
	version: 1;
	id: string;
	sessionFile: string | null;
	anchor: SessionAppendAnchor;
	phase: "intent" | "settled" | "publishing" | "cancelled";
	planned: LearningAuditRecord;
	receipt?: LearningAuditRecord;
	publisher?: { host: string; pid: number; ownerId: string; active: boolean };
}

const MAX_AUDIT_BYTES = MAX_PERSISTED_CUSTOM_ENTRY_BYTES - 4096;
export const MAX_LEARNING_WRITE_RECORD_BYTES = 2 * MAX_AUDIT_BYTES + 4096;

export function canonicalLearningWriteRecord(record: LearningWriteRecord): LearningWriteRecord {
	for (const audit of [record.planned, record.receipt]) {
		if (
			audit !== undefined &&
			(!isLearningAuditRecord(audit) || Buffer.byteLength(JSON.stringify(audit)) > MAX_AUDIT_BYTES)
		) {
			throw new Error("Learning audit is invalid or exceeds its publication bound");
		}
	}
	const text = JSON.stringify(record);
	if (Buffer.byteLength(text) > MAX_LEARNING_WRITE_RECORD_BYTES)
		throw new Error("Learning write journal exceeds its byte bound");
	return JSON.parse(text) as LearningWriteRecord;
}

export function parseLearningWriteRecord(value: unknown, id: string): LearningWriteRecord {
	if (
		!isPlainRecord(value) ||
		value.version !== 1 ||
		value.id !== id ||
		!/^audit-[a-f0-9-]{36}$/.test(id) ||
		(value.sessionFile !== null && typeof value.sessionFile !== "string") ||
		!isPlainRecord(value.anchor) ||
		typeof value.anchor.sessionId !== "string" ||
		(value.anchor.leafId !== null && typeof value.anchor.leafId !== "string") ||
		!["intent", "settled", "publishing", "cancelled"].includes(String(value.phase)) ||
		!isLearningAuditRecord(value.planned) ||
		value.planned.id !== id ||
		((value.phase === "settled" || value.phase === "publishing") &&
			(!isLearningAuditRecord(value.receipt) || value.receipt.id !== id)) ||
		(value.phase === "publishing" &&
			(!isPlainRecord(value.publisher) ||
				typeof value.publisher.host !== "string" ||
				!isPositiveSafePid(value.publisher.pid) ||
				typeof value.publisher.active !== "boolean" ||
				typeof value.publisher.ownerId !== "string" ||
				!/^[a-f0-9-]{36}$/.test(value.publisher.ownerId)))
	)
		throw new Error("Invalid learning write journal");
	return canonicalLearningWriteRecord(value as unknown as LearningWriteRecord);
}

export function sameLearningWriteOutcome(left: LearningWriteRecord, right: LearningWriteRecord): boolean {
	return isDeepStrictEqual(
		JSON.parse(JSON.stringify({ ...left, phase: "settled", publisher: undefined })),
		JSON.parse(JSON.stringify({ ...right, phase: "settled", publisher: undefined })),
	);
}

export function sameLearningWriteIntent(left: LearningWriteRecord, right: LearningWriteRecord): boolean {
	return isDeepStrictEqual(
		{ id: left.id, sessionFile: left.sessionFile, anchor: left.anchor, planned: left.planned },
		{ id: right.id, sessionFile: right.sessionFile, anchor: right.anchor, planned: right.planned },
	);
}
