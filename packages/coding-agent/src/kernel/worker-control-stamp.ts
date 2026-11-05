/**
 * The typed identity of a message the host wrote into a worker's transcript: a mailbox control message
 * (`steer`, `follow_up`) or the attempt's task prompt (`task`).
 *
 * The rendered text of such a message is for the model. Everything that must recognize the message (the mailbox
 * acknowledgement, transcript reconciliation, the context-fork sanitizer, the lane's last words, the bot chat)
 * reads this record instead. It follows the owner-input design: a non-enumerable stamp on the message object, so it
 * travels with the object through the agent loop and never reaches a serialized message or a provider request; the
 * session manager writes it on the message's entry (`SessionMessageEntry.workerControl`) beside the message and
 * rebuilds the stamp when it rebuilds a context from entries. A copy of the message does not carry it.
 */

import { parseWorkerHostEventRecord, type WorkerHostEventRecord } from "./host-event-stamp.ts";
import type { AgentMessage } from "./types.ts";

/** What kind of host-written message this is. `task` is the attempt's task prompt; the others are mailbox delivery modes. */
export type WorkerControlKind = "steer" | "follow_up" | "task" | "host_event";

/** Where the sender's own words sit inside the rendered text, in UTF-16 code units. */
export interface WorkerControlBody {
	readonly from: number;
	readonly to: number;
}

export interface WorkerControlRecord {
	readonly v: 1;
	readonly k: WorkerControlKind;
	/** The mailbox message id, or for a task the attempt id. */
	readonly id: string;
	/** Host-stamped sender agent. */
	readonly from?: string;
	readonly th?: string;
	/** The message this one answers. */
	readonly to?: string;
	readonly reply?: true;
	readonly body?: WorkerControlBody;
	/** A host event is operational evidence bound to one exact execution, never a parent instruction. */
	readonly hostEvent?: WorkerHostEventRecord;
}

const MAX_WORKER_CONTROL_FIELD_CHARS = 512;
const WORKER_CONTROL_KINDS: ReadonlySet<unknown> = new Set<WorkerControlKind>([
	"steer",
	"follow_up",
	"task",
	"host_event",
]);
const WORKER_CONTROL = Symbol("pi.workerControl");

function boundedField(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_WORKER_CONTROL_FIELD_CHARS;
}

/**
 * Reads a record back from a persisted entry or any foreign value, or `undefined` when it is not a well-formed
 * record. The returned record is rebuilt field by field in the persisted key order.
 */
export function parseWorkerControlRecord(value: unknown): WorkerControlRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.v !== 1 || !WORKER_CONTROL_KINDS.has(record.k) || !boundedField(record.id)) return undefined;
	if (record.from !== undefined && !boundedField(record.from)) return undefined;
	if (record.th !== undefined && !boundedField(record.th)) return undefined;
	if (record.to !== undefined && !boundedField(record.to)) return undefined;
	if (record.reply !== undefined && record.reply !== true) return undefined;
	const hostEvent = record.k === "host_event" ? parseWorkerHostEventRecord(record.hostEvent) : undefined;
	if (record.k === "host_event" ? !hostEvent || hostEvent.messageId !== record.id : record.hostEvent !== undefined)
		return undefined;
	let body: WorkerControlBody | undefined;
	if (record.body !== undefined) {
		const candidate = record.body as Record<string, unknown> | null;
		if (
			typeof candidate !== "object" ||
			candidate === null ||
			!Number.isSafeInteger(candidate.from) ||
			!Number.isSafeInteger(candidate.to) ||
			(candidate.from as number) < 0 ||
			(candidate.to as number) < (candidate.from as number)
		) {
			return undefined;
		}
		body = { from: candidate.from as number, to: candidate.to as number };
	}
	return {
		v: 1,
		k: record.k as WorkerControlKind,
		id: record.id,
		...(record.from !== undefined ? { from: record.from as string } : {}),
		...(record.th !== undefined ? { th: record.th as string } : {}),
		...(record.to !== undefined ? { to: record.to as string } : {}),
		...(record.reply === true ? { reply: true as const } : {}),
		...(body ? { body } : {}),
		...(hostEvent ? { hostEvent } : {}),
	};
}

/** Stamps `message` as the host-written message `record` describes. A message carries one record, once. */
export function stampWorkerControl(message: AgentMessage, record: WorkerControlRecord): void {
	const current = workerControlOf(message);
	if (current !== undefined) {
		if (
			current.id === record.id &&
			current.k === record.k &&
			current.hostEvent?.bindingDigest === record.hostEvent?.bindingDigest
		)
			return;
		throw new Error(`A message already carries worker control ${current.id}; it cannot carry ${record.id}.`);
	}
	const parsed = parseWorkerControlRecord(record);
	if (!parsed) throw new TypeError("A worker control record is invalid.");
	Object.defineProperty(message, WORKER_CONTROL, {
		value: parsed,
		enumerable: false,
		writable: false,
		configurable: false,
	});
}

/** The record `message` carries, if it carries one. */
export function workerControlOf(message: object): WorkerControlRecord | undefined {
	const record: unknown = Reflect.get(message, WORKER_CONTROL);
	return parseWorkerControlRecord(record);
}

/** Shared live/replay provenance: external evidence cannot advance owner intent or a failed-tool retry epoch. */
export function isExternalEvidenceMessage(message: object): boolean {
	return (
		workerControlOf(message)?.k === "host_event" ||
		(Reflect.get(message, "role") === "custom" && Reflect.get(message, "customType") === "host-event")
	);
}
