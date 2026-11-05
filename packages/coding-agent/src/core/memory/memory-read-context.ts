import { assertBoundedReadActive } from "../util/bounded-file.ts";
import type { MemoryReadSourceReference } from "./worker-memory-tools.ts";

/** Source evidence belongs to one read, independently of the receiving lane's context allowance. */
export interface MemoryReadEvidence {
	readonly sources: readonly MemoryReadSourceReference[];
	readonly complete: boolean;
	isCurrent(): boolean;
	revalidate(context: MemoryReadContext): Promise<boolean>;
}

/** Host-owned lifetime for native source I/O; never forwarded to an opaque extension provider. */
export interface MemoryReadContext {
	readonly signal?: AbortSignal;
	readonly deadlineAt?: number;
	readonly observe?: (evidence: MemoryReadEvidence) => void;
}

/** A source refusal can be delivered diagnostically, but cannot certify complete evidence. */
export const INCOMPLETE_MEMORY_READ: MemoryReadEvidence = Object.freeze({
	sources: Object.freeze([]),
	complete: false,
	isCurrent: () => true,
	revalidate: async () => false,
});

export function assertMemoryReadActive(context: MemoryReadContext | undefined): void {
	assertBoundedReadActive(context);
}

/** Detach a reader from an independently owned write/lifecycle tail without cancelling that owner. */
export function waitForMemoryRead<T>(pending: Promise<T>, context: MemoryReadContext): Promise<T> {
	assertMemoryReadActive(context);
	const signal = context.signal;
	if (signal === undefined) return pending;
	return new Promise<T>((resolve, reject) => {
		const cancel = (): void => {
			signal.removeEventListener("abort", cancel);
			reject(signal.reason);
		};
		signal.addEventListener("abort", cancel, { once: true });
		void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
		if (signal.aborted) cancel();
	});
}
