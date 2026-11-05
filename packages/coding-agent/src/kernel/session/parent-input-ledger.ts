import { createHash } from "node:crypto";
import type { CustomMessage } from "../messages.ts";
import { isPlainRecord } from "../utils/value-guards.ts";
import type { SessionAppendReceipt } from "./session-append-receipt.ts";
import type { SessionEntry } from "./session-entries.ts";

export interface ParentInputAppendReceipt extends SessionAppendReceipt {
	readonly created: boolean;
}

export const PARENT_INPUT_SETTLED_CUSTOM_TYPE = "parent_input_wake_settled";
export const MAX_PENDING_PARENT_INPUTS = 256;
export const MAX_PARENT_WAKE_CHARS = 64 * 1024;
const parentInputCache = new WeakMap<SessionEntry, PersistedParentInput | undefined>();

export interface ParentInputOrigin {
	readonly sessionId: string;
	readonly sessionFile?: string;
	readonly leafId: string;
}

export interface ParentInputIdentity {
	readonly deliveryId: string;
	readonly payloadDigest: string;
	readonly origin: ParentInputOrigin;
	readonly goalId?: string;
}

export interface ParentInputMetadata extends ParentInputIdentity {
	readonly version: 1;
	readonly messageDigest: string;
}

export interface PersistedParentInput {
	readonly entryId: string;
	readonly metadata: ParentInputMetadata;
}

/** Caller identity and physical body identity are both checked on replay. */
export function parentInputMessage(
	identity: ParentInputIdentity,
	message: Pick<CustomMessage<unknown>, "customType" | "content" | "display" | "details">,
): CustomMessage<unknown> {
	if (!identity.deliveryId || identity.deliveryId.length > 256 || !/^[a-f0-9]{64}$/.test(identity.payloadDigest))
		throw new TypeError("Parent input requires a bounded delivery ID and SHA-256 payload digest.");
	const body = {
		customType: message.customType,
		content: structuredClone(message.content),
		display: message.display,
		details: structuredClone(message.details),
	};
	if (typeof body.content !== "string") throw new TypeError("Parent input requires a text payload.");
	if (JSON.stringify(body).length > MAX_PARENT_WAKE_CHARS)
		throw new RangeError("Parent input exceeds its bounded payload.");
	const metadata: ParentInputMetadata = {
		...structuredClone(identity),
		version: 1,
		messageDigest: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
	};
	return {
		...body,
		role: "custom",
		details: { parentInput: metadata, originalDetails: body.details },
		timestamp: Date.now(),
	};
}

/** Malformed reserved metadata is an error, not evidence that a delivery never existed. */
export function parentInputOf(entry: SessionEntry): PersistedParentInput | undefined {
	if (parentInputCache.has(entry)) return parentInputCache.get(entry);
	const value = parseParentInput(entry);
	parentInputCache.set(entry, value);
	return value;
}

function parseParentInput(entry: SessionEntry): PersistedParentInput | undefined {
	if (entry.type !== "custom_message" || !isPlainRecord(entry.details) || !("parentInput" in entry.details))
		return undefined;
	const value = entry.details.parentInput;
	if (
		!isPlainRecord(value) ||
		value.version !== 1 ||
		typeof value.deliveryId !== "string" ||
		!value.deliveryId ||
		value.deliveryId.length > 256 ||
		typeof value.payloadDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.payloadDigest) ||
		typeof value.messageDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.messageDigest) ||
		!isPlainRecord(value.origin) ||
		typeof value.origin.sessionId !== "string" ||
		typeof value.origin.leafId !== "string" ||
		(value.origin.sessionFile !== undefined && typeof value.origin.sessionFile !== "string") ||
		(value.goalId !== undefined && typeof value.goalId !== "string")
	)
		throw new Error("Parent input metadata requires inspection.");
	const body = {
		customType: entry.customType,
		content: entry.content,
		display: entry.display,
		details: entry.details.originalDetails,
	};
	if (createHash("sha256").update(JSON.stringify(body)).digest("hex") !== value.messageDigest)
		throw new Error("Parent input payload does not match its saved digest.");
	return {
		entryId: entry.id,
		metadata: {
			version: 1,
			deliveryId: value.deliveryId,
			payloadDigest: value.payloadDigest,
			messageDigest: value.messageDigest,
			origin: {
				sessionId: value.origin.sessionId,
				leafId: value.origin.leafId,
				...(value.origin.sessionFile === undefined ? {} : { sessionFile: value.origin.sessionFile }),
			},
			...(value.goalId === undefined ? {} : { goalId: value.goalId }),
		},
	};
}

export const PARENT_INPUT_WAKE_CUSTOM_TYPE = "parent_input_wake";
export const PARENT_INPUT_WAKE_REQUEST_CUSTOM_TYPE = "parent_input_wake_request";
export const MAX_PARENT_WAKE_INPUTS = 32;

export interface ParentWakeInput {
	readonly entryId: string;
	readonly deliveryId: string;
	readonly payloadDigest: string;
}
export interface ParentInputWake {
	readonly entryId: string;
	readonly wakeId: string;
	readonly inputs: readonly ParentWakeInput[];
	readonly completed?: { readonly requestId: string; readonly assistantMessageEntryId: string };
}

export function parentWakeContent(wakeId: string, inputs: readonly ParentWakeInput[]): string {
	return `${parentWakeMarker(wakeId)}\nRespond to this detached batch of background inputs in the preceding canonical history. It does not continue any active goal.\n${JSON.stringify(inputs)}`;
}

export function parentWakeMarker(wakeId: string): string {
	return `[Parent input wake ${wakeId}]`;
}

export function parentWakeOf(entry: SessionEntry): ParentInputWake | undefined {
	if (entry.type !== "custom_message" || entry.customType !== PARENT_INPUT_WAKE_CUSTOM_TYPE) return undefined;
	const data = entry.details;
	if (
		!isPlainRecord(data) ||
		data.version !== 1 ||
		data.detached !== true ||
		typeof data.wakeId !== "string" ||
		!/^[a-f0-9]{64}$/.test(data.wakeId) ||
		!Array.isArray(data.inputs) ||
		!data.inputs.length ||
		data.inputs.length > MAX_PARENT_WAKE_INPUTS
	)
		throw new Error("Parent wake manifest requires inspection.");
	const ids = new Set<string>();
	const inputs = data.inputs.map((value): ParentWakeInput => {
		if (
			!isPlainRecord(value) ||
			typeof value.entryId !== "string" ||
			!value.entryId ||
			typeof value.deliveryId !== "string" ||
			!value.deliveryId ||
			value.deliveryId.length > 256 ||
			typeof value.payloadDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(value.payloadDigest) ||
			ids.has(value.entryId)
		)
			throw new Error("Parent wake input identity requires inspection.");
		ids.add(value.entryId);
		return { entryId: value.entryId, deliveryId: value.deliveryId, payloadDigest: value.payloadDigest };
	});
	if (
		createHash("sha256").update(JSON.stringify(inputs)).digest("hex") !== data.wakeId ||
		typeof entry.content !== "string" ||
		entry.content !== parentWakeContent(data.wakeId, inputs)
	)
		throw new Error("Parent wake content does not match its manifest.");
	return { entryId: entry.id, wakeId: data.wakeId, inputs };
}

/** SessionManager owns this incremental projection; encoded bodies are verified once per append/load. */
export class ParentInputIndex {
	private readonly accepted = new Map<string, PersistedParentInput>();
	private readonly pending = new Map<string, PersistedParentInput>();
	private readonly wakes = new Map<string, ParentInputWake>();
	private readonly settled = new Set<string>();
	private currentRequestId: string | undefined;
	private currentWakeId: string | undefined;
	private readonly requestWakes = new Map<string, string>();

	apply(entry: SessionEntry, lookup: (id: string) => SessionEntry | undefined): void {
		const input = parentInputOf(entry);
		if (input) {
			if (this.accepted.has(input.metadata.deliveryId))
				throw new Error("Duplicate parent input delivery requires inspection.");
			this.accepted.set(input.metadata.deliveryId, input);
			this.pending.set(input.metadata.deliveryId, input);
			if (this.pending.size > MAX_PENDING_PARENT_INPUTS) throw new Error("Pending parent input capacity exceeded.");
			return;
		}
		const wake = parentWakeOf(entry);
		if (wake) {
			if (this.openWake() || this.wakes.has(wake.wakeId))
				throw new Error("Overlapping parent wake manifests require inspection.");
			for (const item of wake.inputs) {
				const accepted = this.pending.get(item.deliveryId);
				if (accepted?.entryId !== item.entryId || accepted.metadata.payloadDigest !== item.payloadDigest)
					throw new Error("Parent wake does not name exact pending input.");
			}
			this.wakes.set(wake.wakeId, wake);
			this.currentWakeId = wake.wakeId;
			return;
		}
		if (entry.type === "request_snapshot") this.currentRequestId = this.currentWakeId ? entry.requestId : undefined;
		if (entry.type === "custom" && entry.customType === PARENT_INPUT_WAKE_REQUEST_CUSTOM_TYPE) {
			const data = entry.data;
			if (
				!isPlainRecord(data) ||
				data.version !== 1 ||
				typeof data.wakeId !== "string" ||
				typeof data.requestId !== "string" ||
				this.currentRequestId !== data.requestId ||
				!this.wakes.has(data.wakeId) ||
				this.settled.has(data.wakeId) ||
				this.requestWakes.has(data.requestId)
			)
				throw new Error("Parent wake request binding requires inspection.");
			this.requestWakes.set(data.requestId, data.wakeId);
			const current = this.wakes.get(data.wakeId)!;
			const { completed: _completed, ...pendingWake } = current;
			this.wakes.set(data.wakeId, pendingWake);
		}
		if (
			entry.type === "provider_request_terminal" &&
			entry.outcome === "completed" &&
			entry.assistantMessageEntryId
		) {
			const wakeId = this.requestWakes.get(entry.requestId);
			const current = wakeId && this.wakes.get(wakeId);
			const answer = lookup(entry.assistantMessageEntryId);
			if (
				current &&
				answer?.type === "message" &&
				answer.origin !== "local" &&
				answer.message.role === "assistant" &&
				(answer.message.stopReason === "stop" || answer.message.stopReason === "length")
			)
				this.wakes.set(current.wakeId, {
					...current,
					completed: { requestId: entry.requestId, assistantMessageEntryId: answer.id },
				});
		}
		if (entry.type === "custom" && entry.customType === PARENT_INPUT_SETTLED_CUSTOM_TYPE) {
			const data = entry.data;
			if (!isPlainRecord(data) || data.version !== 1 || typeof data.wakeId !== "string")
				throw new Error("Parent wake settlement requires inspection.");
			const current = this.wakes.get(data.wakeId);
			if (
				!current?.completed ||
				this.settled.has(data.wakeId) ||
				data.requestId !== current.completed.requestId ||
				data.assistantMessageEntryId !== current.completed.assistantMessageEntryId
			)
				throw new Error("Parent wake settlement lacks matching provider evidence.");
			for (const item of current.inputs) this.pending.delete(item.deliveryId);
			this.settled.add(current.wakeId);
			this.currentWakeId = undefined;
			this.currentRequestId = undefined;
			this.requestWakes.clear();
		}
	}

	find(deliveryId: string): PersistedParentInput | undefined {
		return this.accepted.get(deliveryId);
	}
	pendingInputs(): readonly PersistedParentInput[] {
		return [...this.pending.values()];
	}
	openWake(): ParentInputWake | undefined {
		return this.currentWakeId ? this.wakes.get(this.currentWakeId) : undefined;
	}
}

export function pendingParentInputs(entries: readonly SessionEntry[]): PersistedParentInput[] {
	const index = new ParentInputIndex();
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	for (const entry of entries) index.apply(entry, (id) => byId.get(id));
	return [...index.pendingInputs()];
}

export function parentInputContextIds(entries: readonly SessionEntry[]): ReadonlySet<string> {
	const index = new ParentInputIndex();
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	for (const entry of entries) index.apply(entry, (id) => byId.get(id));
	return new Set([
		...index.pendingInputs().map((input) => input.entryId),
		...[index.openWake()?.entryId].filter((id): id is string => id !== undefined),
	]);
}
