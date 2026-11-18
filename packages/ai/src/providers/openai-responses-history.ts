/** Checkpoints and immutable wire-input receipts owned by the native Responses encoder. */
import type { ResponseInput } from "openai/resources/responses/responses.js";
import type { Api, Message, Model } from "../types.ts";
import type { IndexedToolNameMap } from "../utils/tool-names.ts";
import type { MessageTransformCursor } from "./transform-messages.ts";

interface ResponsesCheckpoint {
	readonly output: number;
	readonly messageIndex: number;
	readonly transform: number;
	readonly names: number;
}
export interface ResponsesFrame {
	readonly scope: string;
	readonly systemPrompt: string | undefined;
	readonly transform: MessageTransformCursor;
	readonly output: ResponseInput;
	readonly names?: IndexedToolNameMap;
	readonly checkpoints: ResponsesCheckpoint[];
	current?: ResponsesReceipt;
	prior?: ResponsesReceipt;
}

interface ResponsesReceipt {
	readonly frame: ResponsesFrame;
	readonly emitted: WeakRef<ResponseInput>;
	readonly source: WeakRef<readonly Message[]>;
	reusableRows: number;
}

const acceptedInputs = new WeakMap<readonly Message[], ResponsesReceipt>();

export function findResponsesPredecessor(source: readonly Message[]): ResponsesReceipt | undefined {
	const receipt = acceptedInputs.get(source);
	if (receipt && (receipt.frame.current === receipt || receipt.frame.prior === receipt)) return receipt;
	return undefined;
}

/** Reserve the reusable checkpoint before a speculative conversion can mutate the frame. */
export function beginResponsesFork(receipt: ResponsesReceipt, retainedRows: number): void {
	const { frame } = receipt;
	for (const outdated of [frame.current, frame.prior]) {
		if (!outdated || outdated === receipt) continue;
		const source = outdated.source.deref();
		if (source && acceptedInputs.get(source) === outdated) acceptedInputs.delete(source);
	}
	receipt.reusableRows = retainedRows;
	frame.prior = receipt;
	frame.current = undefined;
}

export function rememberResponsesInput(frame: ResponsesFrame, source: readonly Message[], input: ResponseInput): void {
	const receipt = {
		frame,
		source: new WeakRef(source),
		emitted: new WeakRef(input),
		reusableRows: frame.checkpoints.length,
	};
	frame.current = receipt;
	acceptedInputs.set(source, receipt);
}

export function withoutForeignThinking<TApi extends Api>(msg: Message, model: Model<TApi>): Message {
	if (
		msg.role === "assistant" &&
		(msg.provider !== model.provider || msg.api !== model.api || msg.model !== model.id) &&
		msg.content.some((block) => block.type === "thinking")
	) {
		return {
			...msg,
			content: msg.content.filter((block) => block.type !== "thinking"),
		};
	}
	return msg;
}

/** A native Responses input array records its actual stable output extent, excluding provisional results. */
const wirePrefixes = new WeakMap<object, { source: readonly Message[]; count: number; previous?: WeakRef<object> }>();
export function recordResponsesInput(
	input: object,
	source: readonly Message[],
	count: number,
	previous?: object,
): void {
	wirePrefixes.set(input, { source, count, previous: previous && new WeakRef(previous) });
}
export function responsesInputPrefix(input: object) {
	const receipt = wirePrefixes.get(input);
	if (!receipt) return undefined;
	const previous = receipt.previous?.deref();
	return { source: receipt.source, count: previous ? receipt.count : 0, previous };
}
