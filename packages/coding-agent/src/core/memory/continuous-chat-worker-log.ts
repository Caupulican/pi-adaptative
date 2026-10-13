/**
 * Worker-log port behind `zoom("Name")`: one worker's own chat, rendered with the chat's kinds. Its steps never enter
 * the main chat. They are read here on demand, by a name the navigator has already validated, in bounded pages.
 */

import type { Message } from "@caupulican/pi-ai";
import { continuousChatMessageParts } from "./continuous-chat-ingest.ts";
import {
	type ContinuousChatWorkerLogPage,
	type ContinuousChatWorkerLogPort,
	pageContinuousChatText,
} from "./continuous-chat-navigation.ts";

/** The streaming read side of a worker's durable transcript. */
export interface ContinuousChatWorkerTranscript {
	streamRawTranscriptMessages(): Iterable<Message>;
}

export interface ContinuousChatWorkerLogDeps {
	/** The worker's transcript for a navigator-validated agent name; undefined when no such worker exists. */
	resolve(name: string): ContinuousChatWorkerTranscript | undefined;
}

/**
 * The transcript's `kind: text` lines, one durable entry at a time. The pager stops after the requested bounded page
 * and one-page lookahead, so a large message remains readable and an early page does not traverse the complete log.
 */
function* workerTranscriptLines(transcript: ContinuousChatWorkerTranscript): Generator<string> {
	let first = true;
	for (const message of transcript.streamRawTranscriptMessages()) {
		for (const part of continuousChatMessageParts(message)) {
			yield first ? `${part.kind}: ${part.text}` : `\n${part.kind}: ${part.text}`;
			first = false;
		}
	}
}

export class ContinuousChatWorkerLog implements ContinuousChatWorkerLogPort {
	private readonly deps: ContinuousChatWorkerLogDeps;

	constructor(deps: ContinuousChatWorkerLogDeps) {
		this.deps = deps;
	}

	async readPage(name: string, page: number, maxBytes: number): Promise<ContinuousChatWorkerLogPage | undefined> {
		const transcript = this.deps.resolve(name);
		if (transcript === undefined) return undefined;
		const paged = pageContinuousChatText(workerTranscriptLines(transcript), maxBytes, page, true);
		if (paged.text === undefined) return undefined;
		return { name, page, hasMore: paged.hasMore, text: paged.text };
	}
}
