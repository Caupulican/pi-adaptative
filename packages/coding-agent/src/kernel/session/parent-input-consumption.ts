import {
	MAX_PARENT_WAKE_CHARS,
	PARENT_INPUT_CONSUMED_CUSTOM_TYPE,
	PARENT_INPUT_SETTLED_CUSTOM_TYPE,
	PARENT_INPUT_WAKE_CUSTOM_TYPE,
	PARENT_INPUT_WAKE_REQUEST_CUSTOM_TYPE,
	PARENT_NOTE_REQUEST_CUSTOM_TYPE,
	type ParentInputConsumption,
	type ParentInputConsumptionSource,
	type ParentInputEvidenceQuery,
	type ParentWakeInput,
	parentInputConsumptionOf,
	parentInputOf,
	parentInputRequestBindingOf,
	parentWakeOf,
	parentWakeSettlementOf,
} from "./parent-input-ledger.ts";
import type { SessionEntry } from "./session-entries.ts";

export interface ConsumedParentInput extends ParentWakeInput {
	readonly text: string;
	readonly timestamp: string;
}

async function read(
	source: ParentInputConsumptionSource,
	ids: readonly string[],
	signal?: AbortSignal,
): Promise<ReadonlyMap<string, SessionEntry>> {
	const unique = [...new Set(ids)];
	const entries = await source.readEntries(unique, signal);
	for (const id of unique)
		if (entries.get(id)?.id !== id) throw new Error("Parent input source returned a mismatched entry.");
	return entries;
}

async function onlyAncestor(
	source: ParentInputConsumptionSource,
	descendant: string,
	query: ParentInputEvidenceQuery,
	signal?: AbortSignal,
): Promise<string> {
	const ids = await source.findAncestors(descendant, { ...query, limit: 2 }, signal);
	if (ids.length !== 1) throw new Error("Parent input proof has missing or ambiguous predecessor evidence.");
	return ids[0]!;
}

/** Old turn receipts are resolved from their settlement, without rewriting or trusting their bodies. */
async function retrospective(
	source: ParentInputConsumptionSource,
	entry: SessionEntry,
	signal?: AbortSignal,
): Promise<ParentInputConsumption | undefined> {
	const settlement = parentWakeSettlementOf(entry);
	if (!settlement) return undefined;
	const bindingEntryId = await onlyAncestor(
		source,
		entry.id,
		{
			type: "custom",
			customType: PARENT_INPUT_WAKE_REQUEST_CUSTOM_TYPE,
			requestId: settlement.requestId,
			wakeId: settlement.wakeId,
		},
		signal,
	);
	const terminalEntryId = await onlyAncestor(
		source,
		entry.id,
		{ type: "provider_request_terminal", requestId: settlement.requestId },
		signal,
	);
	const authorizationEntryId = await onlyAncestor(
		source,
		entry.id,
		{ type: "custom_message", customType: PARENT_INPUT_WAKE_CUSTOM_TYPE, wakeId: settlement.wakeId },
		signal,
	);
	const entries = await read(source, [bindingEntryId, authorizationEntryId], signal);
	const binding = entries.get(bindingEntryId)!;
	const wake = parentWakeOf(entries.get(authorizationEntryId)!);
	if (!wake || !binding.parentId) throw new Error("Historical parent wake proof is incomplete.");
	const snapshots = await source.findAncestors(binding.parentId, { type: "request_snapshot", limit: 1 }, signal);
	if (!snapshots[0]) throw new Error("Historical parent wake has no request snapshot.");
	return {
		version: 1,
		mode: "turn",
		requestId: settlement.requestId,
		requestSnapshotEntryId: snapshots[0],
		bindingEntryId,
		authorizationEntryId,
		terminalEntryId,
		assistantMessageEntryId: settlement.assistantMessageEntryId,
		inputs: wake.inputs,
	};
}

/** A missing derived receipt cannot make a previously successful note appear pending again. */
async function assertNoteWasPending(
	source: ParentInputConsumptionSource,
	before: string,
	input: ParentWakeInput,
	signal?: AbortSignal,
): Promise<void> {
	const consumed = await source.findAncestors(
		before,
		{ type: "custom", customType: PARENT_INPUT_CONSUMED_CUSTOM_TYPE, deliveryId: input.deliveryId, limit: 1 },
		signal,
	);
	if (consumed.length) throw new Error("Parent note was consumed before this request.");
	let cursor: string | null = before;
	while (cursor) {
		const priorIds = await source.findAncestors(
			cursor,
			{ type: "custom", customType: PARENT_NOTE_REQUEST_CUSTOM_TYPE, deliveryId: input.deliveryId, limit: 64 },
			signal,
		);
		if (!priorIds.length) return;
		const bindings = await read(source, priorIds, signal);
		for (const id of priorIds) {
			const binding = parentInputRequestBindingOf(bindings.get(id)!);
			if (binding?.kind !== "owner") throw new Error("Parent note predecessor binding is invalid.");
			const terminals = await source.findAncestors(
				before,
				{ type: "provider_request_terminal", requestId: binding.requestId, limit: 2 },
				signal,
			);
			if (terminals.length > 1) throw new Error("Parent note predecessor terminal is ambiguous.");
			if (!terminals[0]) continue;
			const terminal = (await read(source, terminals, signal)).get(terminals[0])!;
			if (
				terminal.type !== "provider_request_terminal" ||
				terminal.outcome !== "completed" ||
				!terminal.assistantMessageEntryId
			)
				continue;
			const answer = (await read(source, [terminal.assistantMessageEntryId], signal)).get(
				terminal.assistantMessageEntryId,
			)!;
			if (
				answer.type === "message" &&
				answer.origin !== "local" &&
				answer.message.role === "assistant" &&
				(answer.message.stopReason === "stop" || answer.message.stopReason === "length")
			)
				throw new Error("Parent note has an earlier successful request.");
		}
		cursor = bindings.get(priorIds.at(-1)!)!.parentId;
	}
}

/** Same canonical proof and original body resolver for live ingestion and pinned historical imports. */
export async function resolveParentInputConsumption(
	entry: SessionEntry,
	source: ParentInputConsumptionSource,
	signal?: AbortSignal,
): Promise<readonly ConsumedParentInput[]> {
	const consumption = parentInputConsumptionOf(entry) ?? (await retrospective(source, entry, signal));
	if (!consumption) return [];
	signal?.throwIfAborted();
	const entries = await read(
		source,
		[
			consumption.requestSnapshotEntryId,
			consumption.bindingEntryId,
			consumption.authorizationEntryId,
			consumption.terminalEntryId,
			consumption.assistantMessageEntryId,
			...consumption.inputs.map((input) => input.entryId),
			...(entry.parentId ? [entry.parentId] : []),
		],
		signal,
	);
	const snapshot = entries.get(consumption.requestSnapshotEntryId)!;
	const bindingEntry = entries.get(consumption.bindingEntryId)!;
	const binding = parentInputRequestBindingOf(bindingEntry);
	const authorization = entries.get(consumption.authorizationEntryId)!;
	const terminal = entries.get(consumption.terminalEntryId)!;
	const answer = entries.get(consumption.assistantMessageEntryId)!;
	if (
		snapshot.type !== "request_snapshot" ||
		snapshot.requestId !== consumption.requestId ||
		!binding ||
		binding.requestId !== consumption.requestId ||
		terminal.type !== "provider_request_terminal" ||
		terminal.outcome !== "completed" ||
		terminal.requestId !== consumption.requestId ||
		terminal.assistantMessageEntryId !== answer.id ||
		answer.type !== "message" ||
		answer.origin === "local" ||
		answer.message.role !== "assistant" ||
		(answer.message.stopReason !== "stop" && answer.message.stopReason !== "length") ||
		!bindingEntry.parentId
	)
		throw new Error("Parent input work projection has no matching canonical request and answer.");
	const nearestSnapshot = await source.findAncestors(
		bindingEntry.parentId,
		{ type: "request_snapshot", limit: 1 },
		signal,
	);
	if (nearestSnapshot[0] !== snapshot.id) throw new Error("Parent input binding did not follow its current request.");
	let boundInputs: readonly ParentWakeInput[];
	if (consumption.mode === "next-owner-turn") {
		if (
			binding.kind !== "owner" ||
			authorization.type !== "message" ||
			authorization.message.role !== "user" ||
			binding.ownerEntryId !== authorization.id ||
			binding.ownerInputId !== authorization.ownerInputId ||
			entry.parentId !== terminal.id
		)
			throw new Error("Parent note work projection has no matching owner authority.");
		boundInputs = binding.inputs;
		for (const input of consumption.inputs) await assertNoteWasPending(source, bindingEntry.parentId, input, signal);
	} else {
		const wake = parentWakeOf(authorization);
		const settlementEntry = parentWakeSettlementOf(entry)
			? entry
			: entry.parentId
				? entries.get(entry.parentId)
				: undefined;
		const settlement = settlementEntry && parentWakeSettlementOf(settlementEntry);
		if (
			binding.kind !== "wake" ||
			!wake ||
			binding.wakeId !== wake.wakeId ||
			!settlement ||
			settlement.wakeId !== wake.wakeId ||
			settlement.requestId !== consumption.requestId ||
			settlement.assistantMessageEntryId !== answer.id
		)
			throw new Error("Parent wake work projection has no matching settled manifest.");
		const priorSettled = await source.findAncestors(
			bindingEntry.parentId,
			{ type: "custom", customType: PARENT_INPUT_SETTLED_CUSTOM_TYPE, wakeId: wake.wakeId, limit: 1 },
			signal,
		);
		const newestWake = await source.findAncestors(
			bindingEntry.parentId,
			{ type: "custom_message", customType: PARENT_INPUT_WAKE_CUSTOM_TYPE, limit: 1 },
			signal,
		);
		if (priorSettled.length || newestWake[0] !== wake.entryId)
			throw new Error("Parent wake was not the active pending manifest.");
		if (authorization.parentId) {
			const previous = await source.findAncestors(
				authorization.parentId,
				{
					type: "custom_message",
					customType: PARENT_INPUT_WAKE_CUSTOM_TYPE,
					limit: 1,
				},
				signal,
			);
			if (previous[0]) {
				const previousWake = parentWakeOf((await read(source, previous, signal)).get(previous[0])!);
				const settled =
					previousWake &&
					(await source.findAncestors(
						authorization.parentId,
						{
							type: "custom",
							customType: PARENT_INPUT_SETTLED_CUSTOM_TYPE,
							wakeId: previousWake.wakeId,
							limit: 1,
						},
						signal,
					));
				if (!settled?.length) throw new Error("Parent wake overlaps an unsettled predecessor.");
			}
			for (const input of consumption.inputs) {
				const previousInput = await source.findAncestors(
					authorization.parentId,
					{
						type: "custom_message",
						customType: PARENT_INPUT_WAKE_CUSTOM_TYPE,
						deliveryId: input.deliveryId,
						limit: 1,
					},
					signal,
				);
				if (previousInput.length) throw new Error("Parent input was selected by an earlier wake.");
			}
		}
		boundInputs = wake.inputs;
	}
	if (JSON.stringify(boundInputs) !== JSON.stringify(consumption.inputs))
		throw new Error("Parent input work projection changed its exact selected inputs.");
	for (const [ancestor, descendant] of [
		[authorization.id, snapshot.id],
		[snapshot.id, bindingEntry.id],
		[bindingEntry.id, answer.id],
		[answer.id, terminal.id],
		[terminal.id, entry.id],
	] as const)
		if (!(await source.isAncestor(ancestor, descendant, signal)))
			throw new Error("Parent input work projection crosses canonical branches.");
	let chars = 0;
	const result: ConsumedParentInput[] = [];
	for (const selected of consumption.inputs) {
		const original = entries.get(selected.entryId)!;
		const input = parentInputOf(original);
		if (
			!input ||
			input.metadata.mode !== consumption.mode ||
			input.metadata.origin.sessionId !== source.sessionId ||
			input.metadata.deliveryId !== selected.deliveryId ||
			input.metadata.payloadDigest !== selected.payloadDigest ||
			original.type !== "custom_message" ||
			typeof original.content !== "string" ||
			!(await source.isAncestor(original.id, authorization.id, signal)) ||
			!(await source.isAncestor(input.metadata.origin.leafId, original.id, signal))
		)
			throw new Error("Parent input work projection refers to a different source.");
		chars += original.content.length;
		if (chars > MAX_PARENT_WAKE_CHARS) throw new Error("Parent input work projection exceeds its content bound.");
		result.push({ ...selected, text: original.content, timestamp: original.timestamp });
	}
	signal?.throwIfAborted();
	return result;
}
