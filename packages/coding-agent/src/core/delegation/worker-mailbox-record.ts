import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { workerAgentMailboxFile } from "../agent-paths.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

/** Storage framing ceiling; the mailbox owner separately enforces its smaller payload budgets. */
const MAX_RECORD_BYTES = 64 * 1024 * 1024;
export interface WorkerMailboxContextReference {
	parentSessionId: string;
	logicalAgentId: string;
	sessionId: string;
	sessionFile: string;
}

export function workerMailboxPath(agentDir: string, parentSessionId: string, agentId: string): string {
	const digest = createHash("sha256")
		.update("pi-worker-agent-mailbox-v1")
		.update("\0")
		.update(parentSessionId)
		.update("\0")
		.update(agentId)
		.digest("hex");
	return workerAgentMailboxFile(agentDir, parentSessionId, digest);
}

export function readWorkerMailboxRecord(file: string): {
	reference?: WorkerMailboxContextReference;
	mailbox?: unknown;
} {
	if (!existsSync(file)) return {};
	const value: unknown = JSON.parse(readBoundedTextFileSync(file, MAX_RECORD_BYTES, "Worker mailbox record"));
	if (!isPlainRecord(value) || value.format === undefined) return { mailbox: value };
	if (
		value.format !== "worker-project-mailbox-v1" ||
		Object.keys(value).length !== 3 ||
		!isPlainRecord(value.reference)
	)
		throw new Error("Worker project mailbox envelope is invalid.");
	const ref = value.reference;
	if (
		Object.keys(ref).length !== 4 ||
		![ref.parentSessionId, ref.logicalAgentId, ref.sessionId].every(
			(field) => typeof field === "string" && field.trim().length > 0 && field.length <= 512,
		) ||
		typeof ref.sessionFile !== "string" ||
		!ref.sessionFile.trim() ||
		ref.sessionFile.length > 32768
	)
		throw new Error("Worker project mailbox reference is invalid.");
	return {
		mailbox: value.mailbox,
		reference: {
			parentSessionId: ref.parentSessionId as string,
			logicalAgentId: ref.logicalAgentId as string,
			sessionId: ref.sessionId as string,
			sessionFile: ref.sessionFile,
		},
	};
}

export function writeWorkerMailboxRecord(
	file: string,
	mailbox: unknown,
	reference?: WorkerMailboxContextReference,
): void {
	const text = JSON.stringify(reference ? { format: "worker-project-mailbox-v1", reference, mailbox } : mailbox);
	if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error("Worker mailbox record exceeds its storage bound.");
	writeFileAtomicSync(file, `${text}\n`, { mode: 0o600 });
}

/** Caller holds the mailbox lock and the transcript's ownership lock, in that order. */
export function bindWorkerMailboxRecord(
	file: string,
	reference: WorkerMailboxContextReference,
	parentSessionId: string,
	agentId: string,
): void {
	const current = readWorkerMailboxRecord(file);
	if (current.reference && !isDeepStrictEqual(current.reference, reference))
		throw new Error("Worker mailbox context identity changed.");
	const mailbox = current.mailbox ?? {
		version: 1,
		parentSessionId,
		agentId,
		messages: [],
		replyAcknowledgements: [],
		replayReceipts: [],
	};
	if (
		!isPlainRecord(mailbox) ||
		mailbox.version !== 1 ||
		mailbox.parentSessionId !== parentSessionId ||
		mailbox.agentId !== agentId
	)
		throw new Error("Worker mailbox binding identity changed.");
	if (!current.reference) writeWorkerMailboxRecord(file, mailbox, reference);
}
