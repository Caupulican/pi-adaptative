import { createHash } from "node:crypto";
import { assertMemoryReadActive, type MemoryReadContext } from "./memory-read-context.ts";
import {
	formatTranscriptSourceHandle,
	type TranscriptIndexObservation,
	type TranscriptSearchResult,
	type TranscriptSourcePageResult,
	type TranscriptSourceReader,
} from "./transcript-memory-contracts.ts";

function readDigest(result: TranscriptSearchResult | TranscriptSourcePageResult): string {
	const payload = result.status === "ok" ? (({ observation: _observation, ...value }) => value)(result) : result;
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Records native index observations before rendering discards their typed source identities. */
export function observedTranscriptReader(
	reader: TranscriptSourceReader,
	context?: MemoryReadContext,
): TranscriptSourceReader {
	const observe = (
		result: TranscriptSearchResult | TranscriptSourcePageResult,
		observation: TranscriptIndexObservation,
		handles: readonly string[],
		complete: boolean,
		reread: (context: MemoryReadContext) => Promise<TranscriptSearchResult | TranscriptSourcePageResult>,
	): void => {
		const captured = Object.freeze({
			...observation,
			sessions: Object.freeze(observation.sessions.map((session) => Object.freeze({ ...session }))),
		});
		const revision = JSON.stringify(captured);
		const digest = readDigest(result);
		const isCurrent = (): boolean => reader.observationCurrent(captured).status === "current";
		context?.observe?.(
			Object.freeze({
				sources: Object.freeze(
					(handles.length ? handles : ["transcript:index"]).map((ref) =>
						Object.freeze({ kind: "transcript" as const, ref, revision }),
					),
				),
				complete,
				isCurrent,
				revalidate: async (next: MemoryReadContext) => {
					assertMemoryReadActive(next);
					if (!isCurrent()) return false;
					const current = await reread(next);
					assertMemoryReadActive(next);
					return isCurrent() && readDigest(current) === digest;
				},
			}),
		);
	};
	return {
		search: async (request) => {
			assertMemoryReadActive(context);
			const input = {
				...request,
				signal: context?.signal ?? request.signal,
				deadlineAt: context?.deadlineAt ?? request.deadlineAt,
			};
			const result = await reader.search(input);
			assertMemoryReadActive(context);
			if (result.status === "ok")
				observe(
					result,
					result.observation,
					result.hits.map((hit) => formatTranscriptSourceHandle(hit.span.ref)),
					!result.coverage.truncated && result.coverage.activeFailures === 0,
					(next) => reader.search({ ...input, signal: next.signal, deadlineAt: next.deadlineAt }),
				);
			return result;
		},
		readSource: async (request) => {
			assertMemoryReadActive(context);
			const input = {
				...request,
				signal: context?.signal ?? request.signal,
				deadlineAt: context?.deadlineAt ?? request.deadlineAt,
			};
			const result = await reader.readSource(input);
			assertMemoryReadActive(context);
			if (result.status === "ok")
				observe(result, result.observation, [formatTranscriptSourceHandle(result.span.ref)], true, (next) =>
					reader.readSource({ ...input, signal: next.signal, deadlineAt: next.deadlineAt }),
				);
			return result;
		},
		coverage: () => reader.coverage(),
		observationCurrent: (observation) => reader.observationCurrent(observation),
	};
}
