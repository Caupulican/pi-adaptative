import { createHash, randomUUID } from "node:crypto";
import { assertMemoryReadActive, type MemoryReadContext, type MemoryReadEvidence } from "./memory-read-context.ts";
import type { MemoryReadFlights } from "./memory-read-flight.ts";
import { TRANSCRIPT_FOREGROUND_READ_MS } from "./transcript-memory-contracts.ts";
import type { MemoryReadReceipt, WorkerMemoryReadOptions } from "./worker-memory-tools.ts";

/** Compose source observations once. Receiving-lane state is checked by the broker before issuing this receipt. */
export function createMemoryReadReceipt(input: {
	kind: MemoryReadReceipt["kind"];
	text: string;
	evidence: readonly MemoryReadEvidence[];
	disposition: MemoryReadReceipt["disposition"];
	isCurrent(): boolean;
	flights: MemoryReadFlights;
}): MemoryReadReceipt {
	const evidence = Object.freeze([...input.evidence]);
	const sources = Object.freeze(
		evidence.flatMap((part) => part.sources).map((source) => Object.freeze({ ...source })),
	);
	const textDigest = createHash("sha256").update(input.text).digest("hex");
	const id = createHash("sha256")
		.update(JSON.stringify([input.kind, sources, textDigest, input.disposition]))
		.digest("hex");
	const validationKey = `revalidate:${randomUUID()}`;
	const isCurrent = (): boolean => {
		try {
			return input.isCurrent() && evidence.every((part) => part.isCurrent());
		} catch {
			return false;
		}
	};
	return Object.freeze({
		id,
		kind: input.kind,
		sources,
		textDigest,
		complete: evidence.length > 0 && evidence.every((part) => part.complete),
		disposition: input.disposition,
		isCurrent,
		revalidate: (options: WorkerMemoryReadOptions) =>
			input.flights
				.read(
					validationKey,
					async (signal, deadlineAt, onPhysicalRead) => {
						const context: MemoryReadContext = { signal, deadlineAt, onPhysicalRead };
						if (input.disposition !== "read" || evidence.length === 0 || !isCurrent()) return false;
						for (const part of evidence) {
							assertMemoryReadActive(context);
							if (!(await part.revalidate(context))) return false;
						}
						assertMemoryReadActive(context);
						return isCurrent();
					},
					options.signal,
					options.deadlineAt ?? Date.now() + TRANSCRIPT_FOREGROUND_READ_MS,
				)
				.then((valid) => {
					assertMemoryReadActive({ signal: options.signal, deadlineAt: options.deadlineAt });
					return valid && isCurrent();
				}),
	});
}
