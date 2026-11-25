/** Reuses converted Anthropic message history up to the stable transformed row boundary. */
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import { countHistoryWork, freezeOwnedJson, providerMessagePrefix, recordProviderInput } from "../history-work.ts";
import { modelImageProjection } from "../image-support.ts";
import type { Message, Model } from "../types.ts";
import type { IndexedToolNameMap } from "../utils/tool-names.ts";
import { MessageTransformCursor } from "./transform-messages.ts";

export interface AnthropicWireRow {
	readonly end: number;
	readonly names: number;
	readonly message?: MessageParam;
	/** Block positions, including -1 for a marked block that was filtered out. */
	readonly boundaries?: readonly number[];
}

interface AnthropicHistoryFrame {
	scope: string;
	cursor: MessageTransformCursor;
	transformed: Message[];
	checkpoints: { length: number; cursor: number }[];
	rows: AnthropicWireRow[];
	names: IndexedToolNameMap;
	source?: WeakRef<Message[]>;
	emitted?: WeakRef<MessageParam[]>;
}

const historyFrames = new WeakMap<readonly Message[], AnthropicHistoryFrame>();

export function prepareAnthropicHistory(
	source: Message[],
	model: Model<"anthropic-messages">,
	scope: string | undefined,
	names: IndexedToolNameMap,
	normalizeToolCallId: (id: string) => string,
	convert: (source: Message[], from: number, rows: AnthropicWireRow[]) => void,
) {
	const proof = scope !== undefined ? providerMessagePrefix(source) : undefined;
	const previous = proof?.previous;
	const candidate = previous && historyFrames.get(previous);
	const prior = candidate?.scope === scope && candidate?.source?.deref() === previous ? candidate : undefined;
	const previousWire = prior?.emitted?.deref();
	const frame: AnthropicHistoryFrame = prior ?? {
		scope: scope ?? "",
		cursor: new MessageTransformCursor(!!proof),
		transformed: [],
		checkpoints: [],
		rows: [],
		names,
	};
	// A failed conversion leaves the speculative cursor unavailable for reuse.
	if (prior && previous) historyFrames.delete(previous);
	frame.source = undefined;
	const from = prior ? Math.min(proof!.count, frame.checkpoints.length) : 0;
	const checkpoint = frame.checkpoints[from - 1];
	const retained = checkpoint?.length ?? 0;
	const { cursor, transformed, rows } = frame;
	if (prior) cursor.rewind(checkpoint?.cursor ?? 0);
	frame.checkpoints.length = from;
	transformed.length = retained;
	while (rows.length && rows.at(-1)!.end > retained) rows.pop();
	// An append can join the last consecutive tool-result group.
	if (rows.at(-1)?.end === retained && transformed.at(-1)?.role === "toolResult") rows.pop();
	const encodeFrom = rows.at(-1)?.end ?? 0;
	const oldRows = rows.length;
	const checkpointNames = rows.at(-1)?.names;
	if (prior && checkpointNames !== undefined) frame.names.copyAllocationsTo(names, checkpointNames);
	frame.names = names;
	const projectImages = modelImageProjection(model);
	for (let i = from; i < source.length; i++) {
		const message = source[i]!;
		cursor.append(projectImages ? projectImages(message) : message, model, transformed, normalizeToolCallId);
		if (proof) frame.checkpoints.push({ length: transformed.length, cursor: cursor.checkpoint });
	}
	const stableLength = transformed.length;
	cursor.finish(transformed);
	convert(transformed, encodeFrom, rows);
	countHistoryWork(source, "wireRowsConverted", transformed.length - encodeFrom);
	transformed.length = stableLength;
	if (proof) {
		for (let i = oldRows; i < rows.length; i++) freezeOwnedJson(rows[i]?.message);
	}

	return {
		rows,
		shared: !!proof,
		publish(messages: MessageParam[]) {
			if (!proof) return;
			let count = 0;
			const limit = Math.min(previousWire?.length ?? 0, messages.length);
			while (count < limit && messages[count] === previousWire![count]) count++;
			Object.freeze(messages);
			recordProviderInput(messages, source, count, previousWire);
			frame.source = new WeakRef(source);
			frame.emitted = new WeakRef(messages);
			historyFrames.set(source, frame);
		},
	};
}
