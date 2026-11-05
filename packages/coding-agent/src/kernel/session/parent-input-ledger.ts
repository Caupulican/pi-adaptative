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
export const PARENT_NOTE_REQUEST_CUSTOM_TYPE = "parent_note_request";
export const PARENT_INPUT_CONSUMED_CUSTOM_TYPE = "parent_input_consumed";
export type ParentInputMode = "turn" | "next-owner-turn";
const parentInputCache = new WeakMap<SessionEntry, PersistedParentInput | undefined>();
const parentMessageCache = new WeakMap<CustomMessage<unknown>, ParentInputMetadata | undefined>();

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
	readonly mode?: ParentInputMode;
}

export interface ParentInputMetadata extends ParentInputIdentity {
	readonly version: 2;
	readonly mode: ParentInputMode;
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
	if (identity.mode !== undefined && identity.mode !== "turn" && identity.mode !== "next-owner-turn")
		throw new TypeError("Parent input delivery mode is invalid.");
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
		version: 2,
		mode: identity.mode ?? "turn",
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

export function parentInputMetadataOfMessage(message: CustomMessage<unknown>): ParentInputMetadata | undefined {
	if (parentMessageCache.has(message)) return parentMessageCache.get(message);
	const input = parentInputOf({
		type: "custom_message",
		id: "message",
		parentId: null,
		timestamp: String(message.timestamp),
		customType: message.customType,
		content: message.content,
		display: message.display,
		details: message.details,
	});
	parentMessageCache.set(message, input?.metadata);
	return input?.metadata;
}

function parseParentInput(entry: SessionEntry): PersistedParentInput | undefined {
	if (entry.type !== "custom_message" || !isPlainRecord(entry.details) || !("parentInput" in entry.details))
		return undefined;
	const value = entry.details.parentInput;
	if (
		!isPlainRecord(value) ||
		(value.version !== 1 && value.version !== 2) ||
		(value.version === 2 && value.mode !== "turn" && value.mode !== "next-owner-turn") ||
		(value.version === 1 && value.mode !== undefined) ||
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
			// Version one represented only immediately waking deliveries.
			version: 2,
			mode: value.version === 1 ? "turn" : (value.mode as ParentInputMode),
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

export interface ParentNoteSelection {
	readonly ownerInputId: string;
	readonly inputs: readonly ParentWakeInput[];
	readonly messages: readonly CustomMessage<unknown>[];
	readonly selectionId: string;
	readonly isCurrent: () => boolean;
}

export interface ParentInputConsumptionSource {
	readonly sessionId: string;
	readEntries(ids: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, SessionEntry>>;
	isAncestor(ancestorId: string, descendantId: string, signal?: AbortSignal): Promise<boolean>;
	findAncestors(
		descendantId: string,
		query: ParentInputEvidenceQuery,
		signal?: AbortSignal,
	): Promise<readonly string[]>;
}

export interface ParentInputEvidenceQuery {
	readonly type: SessionEntry["type"];
	readonly customType?: string;
	readonly requestId?: string;
	readonly wakeId?: string;
	readonly deliveryId?: string;
	readonly limit?: number;
}

export function isParentNoteOwnerId(value: string): boolean {
	return /^(prompt|steer|followUp):.+/.test(value) && value.length <= 256;
}

function parseParentInputReferences(value: unknown): readonly ParentWakeInput[] {
	if (!Array.isArray(value) || !value.length || value.length > MAX_PARENT_WAKE_INPUTS)
		throw new Error("Parent input selection exceeds its bound.");
	const ids = new Set<string>();
	const deliveries = new Set<string>();
	return value.map((item) => {
		if (
			!isPlainRecord(item) ||
			typeof item.entryId !== "string" ||
			!item.entryId ||
			typeof item.deliveryId !== "string" ||
			!item.deliveryId ||
			item.deliveryId.length > 256 ||
			typeof item.payloadDigest !== "string" ||
			!/^[a-f0-9]{64}$/.test(item.payloadDigest) ||
			ids.has(item.entryId) ||
			deliveries.has(item.deliveryId)
		)
			throw new Error("Parent input reference is invalid.");
		ids.add(item.entryId);
		deliveries.add(item.deliveryId);
		return { entryId: item.entryId, deliveryId: item.deliveryId, payloadDigest: item.payloadDigest };
	});
}

export type ParentInputRequestBinding =
	| {
			readonly kind: "owner";
			readonly requestId: string;
			readonly ownerEntryId: string;
			readonly ownerInputId: string;
			readonly inputs: readonly ParentWakeInput[];
	  }
	| { readonly kind: "wake"; readonly requestId: string; readonly wakeId: string };

export function parentInputRequestBindingOf(entry: SessionEntry): ParentInputRequestBinding | undefined {
	if (
		entry.type !== "custom" ||
		(entry.customType !== PARENT_NOTE_REQUEST_CUSTOM_TYPE &&
			entry.customType !== PARENT_INPUT_WAKE_REQUEST_CUSTOM_TYPE)
	)
		return undefined;
	const data = entry.data;
	if (!isPlainRecord(data) || data.version !== 1 || typeof data.requestId !== "string" || !data.requestId)
		throw new Error("Parent request binding is invalid.");
	if (entry.customType === PARENT_NOTE_REQUEST_CUSTOM_TYPE) {
		if (
			typeof data.ownerEntryId !== "string" ||
			!data.ownerEntryId ||
			typeof data.ownerInputId !== "string" ||
			!isParentNoteOwnerId(data.ownerInputId)
		)
			throw new Error("Parent request owner is invalid.");
		return {
			kind: "owner",
			requestId: data.requestId,
			ownerEntryId: data.ownerEntryId,
			ownerInputId: data.ownerInputId,
			inputs: parseParentInputReferences(data.inputs),
		};
	}
	if (typeof data.wakeId !== "string" || !/^[a-f0-9]{64}$/.test(data.wakeId))
		throw new Error("Parent request wake is invalid.");
	return { kind: "wake", requestId: data.requestId, wakeId: data.wakeId };
}

export interface ParentWakeSettlement {
	readonly wakeId: string;
	readonly requestId: string;
	readonly assistantMessageEntryId: string;
}
export function parentWakeSettlementOf(entry: SessionEntry): ParentWakeSettlement | undefined {
	if (entry.type !== "custom" || entry.customType !== PARENT_INPUT_SETTLED_CUSTOM_TYPE) return undefined;
	const data = entry.data;
	if (
		!isPlainRecord(data) ||
		data.version !== 1 ||
		typeof data.wakeId !== "string" ||
		!/^[a-f0-9]{64}$/.test(data.wakeId) ||
		typeof data.requestId !== "string" ||
		!data.requestId ||
		typeof data.assistantMessageEntryId !== "string" ||
		!data.assistantMessageEntryId
	)
		throw new Error("Parent wake settlement is invalid.");
	return { wakeId: data.wakeId, requestId: data.requestId, assistantMessageEntryId: data.assistantMessageEntryId };
}

/** Sparse immutable keys for the shared source index; no content bodies are retained. */
export function parentInputEvidenceMetadata(entry: SessionEntry): readonly ParentInputEvidenceQuery[] {
	const key: ParentInputEvidenceQuery = { type: entry.type };
	if (entry.type === "request_snapshot" || entry.type === "provider_request_terminal")
		return [{ ...key, requestId: entry.requestId }];
	if (entry.type !== "custom" && entry.type !== "custom_message") return [];
	const base = { ...key, customType: entry.customType };
	const wake = parentWakeOf(entry);
	if (wake)
		return [
			{ ...base, wakeId: wake.wakeId },
			...wake.inputs.map((item) => ({ ...base, wakeId: wake.wakeId, deliveryId: item.deliveryId })),
		];
	const binding = parentInputRequestBindingOf(entry);
	if (binding?.kind === "wake") return [{ ...base, requestId: binding.requestId, wakeId: binding.wakeId }];
	if (binding?.kind === "owner")
		return [
			{ ...base, requestId: binding.requestId },
			...binding.inputs.map((item) => ({ ...base, requestId: binding.requestId, deliveryId: item.deliveryId })),
		];
	const settlement = parentWakeSettlementOf(entry);
	if (settlement) return [{ ...base, requestId: settlement.requestId, wakeId: settlement.wakeId }];
	const consumed = parentInputConsumptionOf(entry);
	if (consumed)
		return [
			{ ...base, requestId: consumed.requestId },
			...consumed.inputs.map((item) => ({ ...base, requestId: consumed.requestId, deliveryId: item.deliveryId })),
		];
	return [];
}

export interface ParentInputConsumption {
	readonly version: 1;
	readonly mode: ParentInputMode;
	readonly requestId: string;
	readonly requestSnapshotEntryId: string;
	readonly bindingEntryId: string;
	readonly authorizationEntryId: string;
	readonly terminalEntryId: string;
	readonly assistantMessageEntryId: string;
	readonly inputs: readonly ParentWakeInput[];
}

/** Reference-only work projection; bodies remain owned by their original accepted inputs. */
export function parentInputConsumptionOf(entry: SessionEntry): ParentInputConsumption | undefined {
	if (entry.type !== "custom" || entry.customType !== PARENT_INPUT_CONSUMED_CUSTOM_TYPE) return undefined;
	const data = entry.data;
	if (
		!isPlainRecord(data) ||
		data.version !== 1 ||
		typeof data.requestId !== "string" ||
		!data.requestId ||
		(data.mode !== "turn" && data.mode !== "next-owner-turn") ||
		typeof data.requestSnapshotEntryId !== "string" ||
		!data.requestSnapshotEntryId ||
		typeof data.bindingEntryId !== "string" ||
		!data.bindingEntryId ||
		typeof data.authorizationEntryId !== "string" ||
		!data.authorizationEntryId ||
		typeof data.terminalEntryId !== "string" ||
		!data.terminalEntryId ||
		typeof data.assistantMessageEntryId !== "string" ||
		!data.assistantMessageEntryId ||
		!Array.isArray(data.inputs) ||
		!data.inputs.length ||
		data.inputs.length > MAX_PARENT_WAKE_INPUTS
	)
		throw new Error("Consumed parent note projection requires inspection.");
	const inputs = parseParentInputReferences(data.inputs);
	return {
		version: 1,
		mode: data.mode,
		requestId: data.requestId,
		requestSnapshotEntryId: data.requestSnapshotEntryId,
		bindingEntryId: data.bindingEntryId,
		authorizationEntryId: data.authorizationEntryId,
		terminalEntryId: data.terminalEntryId,
		assistantMessageEntryId: data.assistantMessageEntryId,
		inputs,
	};
}

export function parentNoteMarker(selectionId: string): string {
	return `[Parent notes ${selectionId}]`;
}

/** Both wake modes bind only to a request that actually carries every selected canonical body. */
export function assertParentInputVisible(
	messages: readonly { content: unknown }[],
	marker: string,
	contents: readonly string[],
): void {
	const texts = messages.flatMap(({ content }) =>
		typeof content === "string"
			? [content]
			: Array.isArray(content)
				? content.flatMap((block) =>
						block && typeof block === "object" && "text" in block && typeof block.text === "string"
							? [block.text]
							: [],
					)
				: [],
	);
	if (![marker, ...contents].every((text) => texts.some((part) => part.includes(text))))
		throw new Error("The provider request does not carry every exact selected parent input.");
}
export interface ParentInputWake {
	readonly entryId: string;
	readonly wakeId: string;
	readonly inputs: readonly ParentWakeInput[];
	readonly completed?: {
		readonly requestId: string;
		readonly assistantMessageEntryId: string;
		readonly terminalEntryId: string;
	};
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
	const inputs = parseParentInputReferences(data.inputs);
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
	private currentRequestEntryId: string | undefined;
	private currentWakeId: string | undefined;
	private readonly requestWakes = new Map<string, string>();
	private readonly requestNotes = new Map<string, readonly ParentWakeInput[]>();
	private readonly requestBindings = new Map<string, { entryId: string; snapshotEntryId: string }>();
	private readonly expectedConsumptions = new Map<string, ParentInputConsumption>();
	private awaitingImmediateConsumption: string | undefined;

	/** Prepared before the atomic terminal+projection publication; no independent receipt state. */
	consumption(
		terminal: SessionEntry,
		lookup: (id: string) => SessionEntry | undefined,
	): ParentInputConsumption | undefined {
		if (
			terminal.type !== "provider_request_terminal" ||
			terminal.outcome !== "completed" ||
			!terminal.assistantMessageEntryId
		)
			return undefined;
		const wakeId = this.requestWakes.get(terminal.requestId);
		const inputs = this.requestNotes.get(terminal.requestId) ?? (wakeId ? this.wakes.get(wakeId)?.inputs : undefined);
		const binding = this.requestBindings.get(terminal.requestId);
		if (!inputs?.length || !binding) return undefined;
		const answer = lookup(terminal.assistantMessageEntryId);
		if (
			answer?.type !== "message" ||
			answer.origin === "local" ||
			answer.message.role !== "assistant" ||
			(answer.message.stopReason !== "stop" && answer.message.stopReason !== "length")
		)
			return undefined;
		const bindingEntry = lookup(binding.entryId);
		const authorizationEntryId = wakeId
			? this.wakes.get(wakeId)?.entryId
			: bindingEntry?.type === "custom" &&
					isPlainRecord(bindingEntry.data) &&
					typeof bindingEntry.data.ownerEntryId === "string"
				? bindingEntry.data.ownerEntryId
				: undefined;
		if (!authorizationEntryId) throw new Error("Parent consumption authority is missing.");
		return {
			version: 1,
			mode: wakeId ? "turn" : "next-owner-turn",
			requestId: terminal.requestId,
			requestSnapshotEntryId: binding.snapshotEntryId,
			bindingEntryId: binding.entryId,
			authorizationEntryId,
			terminalEntryId: terminal.id,
			assistantMessageEntryId: terminal.assistantMessageEntryId,
			inputs,
		};
	}

	wakeConsumption(wakeId: string): ParentInputConsumption | undefined {
		const terminalId = this.wakes.get(wakeId)?.completed?.terminalEntryId;
		return terminalId ? this.expectedConsumptions.get(terminalId) : undefined;
	}

	apply(entry: SessionEntry, lookup: (id: string) => SessionEntry | undefined): void {
		const consumption = parentInputConsumptionOf(entry);
		if (this.awaitingImmediateConsumption && consumption?.terminalEntryId !== this.awaitingImmediateConsumption)
			this.expectedConsumptions.delete(this.awaitingImmediateConsumption);
		this.awaitingImmediateConsumption = undefined;
		if (consumption) {
			const expected = this.expectedConsumptions.get(consumption.terminalEntryId);
			if (!expected || JSON.stringify(expected) !== JSON.stringify(consumption))
				throw new Error("Consumed parent note projection has no exact terminal proof.");
			if (consumption.mode === "turn" && this.openWake())
				throw new Error("Parent wake must settle before its work projection.");
			this.expectedConsumptions.delete(consumption.terminalEntryId);
			return;
		}
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
				if (
					accepted?.entryId !== item.entryId ||
					accepted.metadata.payloadDigest !== item.payloadDigest ||
					accepted.metadata.mode !== "turn"
				)
					throw new Error("Parent wake does not name exact pending input.");
			}
			this.wakes.set(wake.wakeId, wake);
			this.currentWakeId = wake.wakeId;
			return;
		}
		if (entry.type === "request_snapshot") {
			this.currentRequestId = entry.requestId;
			this.currentRequestEntryId = entry.id;
		}
		const requestBinding = parentInputRequestBindingOf(entry);
		if (requestBinding?.kind === "owner") {
			if (requestBinding.requestId !== this.currentRequestId || this.requestNotes.has(requestBinding.requestId))
				throw new Error("Parent note request binding requires inspection.");
			const owner = lookup(requestBinding.ownerEntryId);
			if (
				owner?.type !== "message" ||
				owner.message.role !== "user" ||
				owner.ownerInputId !== requestBinding.ownerInputId
			)
				throw new Error("Parent note request has no exact owner input.");
			let chars = 0;
			for (const item of requestBinding.inputs) {
				const input = this.pending.get(item.deliveryId);
				const saved = input && lookup(input.entryId);
				if (
					input?.metadata.mode !== "next-owner-turn" ||
					input.entryId !== item.entryId ||
					input.metadata.payloadDigest !== item.payloadDigest ||
					saved?.type !== "custom_message" ||
					typeof saved.content !== "string"
				)
					throw new Error("Parent note request does not name exact pending notes.");
				chars += saved.content.length;
				if (chars > MAX_PARENT_WAKE_CHARS) throw new Error("Parent note request exceeds its bounded payload.");
			}
			this.requestNotes.set(requestBinding.requestId, requestBinding.inputs);
			this.requestBindings.set(requestBinding.requestId, {
				entryId: entry.id,
				snapshotEntryId: this.currentRequestEntryId!,
			});
		}
		if (requestBinding?.kind === "wake") {
			if (
				requestBinding.requestId !== this.currentRequestId ||
				!this.wakes.has(requestBinding.wakeId) ||
				this.settled.has(requestBinding.wakeId) ||
				this.requestWakes.has(requestBinding.requestId)
			)
				throw new Error("Parent wake request binding requires inspection.");
			this.requestWakes.set(requestBinding.requestId, requestBinding.wakeId);
			this.requestBindings.set(requestBinding.requestId, {
				entryId: entry.id,
				snapshotEntryId: this.currentRequestEntryId!,
			});
			const current = this.wakes.get(requestBinding.wakeId)!;
			if (current.completed) this.expectedConsumptions.delete(current.completed.terminalEntryId);
			const { completed: _completed, ...pendingWake } = current;
			this.wakes.set(requestBinding.wakeId, pendingWake);
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
					completed: { requestId: entry.requestId, assistantMessageEntryId: answer.id, terminalEntryId: entry.id },
				});
			const consumed = this.consumption(entry, lookup);
			if (consumed) {
				this.expectedConsumptions.set(entry.id, consumed);
				if (consumed.mode === "next-owner-turn") {
					for (const input of consumed.inputs) this.pending.delete(input.deliveryId);
					this.awaitingImmediateConsumption = entry.id;
				}
			}
		}
		if (entry.type === "provider_request_terminal") {
			this.requestNotes.delete(entry.requestId);
			this.requestBindings.delete(entry.requestId);
		}
		const settlement = parentWakeSettlementOf(entry);
		if (settlement) {
			const data = settlement;
			const current = this.wakes.get(data.wakeId);
			if (
				!current?.completed ||
				this.settled.has(data.wakeId) ||
				data.requestId !== current.completed.requestId ||
				data.assistantMessageEntryId !== current.completed.assistantMessageEntryId
			)
				throw new Error("Parent wake settlement lacks matching provider evidence.");
			for (const item of current.inputs) this.pending.delete(item.deliveryId);
			this.awaitingImmediateConsumption = current.completed.terminalEntryId;
			this.settled.add(current.wakeId);
			this.currentWakeId = undefined;
			this.currentRequestId = undefined;
			this.requestWakes.clear();
		}
	}

	find(deliveryId: string): PersistedParentInput | undefined {
		return this.accepted.get(deliveryId);
	}
	pendingInputs(mode?: ParentInputMode): readonly PersistedParentInput[] {
		return [...this.pending.values()].filter((input) => mode === undefined || input.metadata.mode === mode);
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
