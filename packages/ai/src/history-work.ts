/** Per-observation history work and accepted prefix evidence shared by the harness and provider adapters. */
import type { Message } from "./types.ts";

export interface HistoryWork {
	oldRowsRead: number;
	coldPayloadLoads: number;
	oldBytesRecompressed: number;
	projectedRows: number;
	copiedRows: number;
	/** Conversation and planner rows converted into provider-neutral messages. */
	providerRowsConverted: number;
	/** Provider-neutral messages encoded into native Responses input. */
	wireRowsConverted: number;
	emittedRows: number;
	fallbacks: Map<string, number>;
}

export type HistoryWorkCounter = Exclude<keyof HistoryWork, "fallbacks">;
const observations = new WeakMap<object, HistoryWork>();

/** Attach a fresh observation to a request-owned object. Derived objects inherit it explicitly. */
export function observeHistoryWork(owner: object): HistoryWork {
	const work: HistoryWork = {
		oldRowsRead: 0,
		coldPayloadLoads: 0,
		oldBytesRecompressed: 0,
		projectedRows: 0,
		copiedRows: 0,
		providerRowsConverted: 0,
		wireRowsConverted: 0,
		emittedRows: 0,
		fallbacks: new Map(),
	};
	observations.set(owner, work);
	return work;
}

export function inheritHistoryWork(parent: object, child: object): void {
	const work = observations.get(parent);
	if (work) observations.set(child, work);
}

export function countHistoryWork(
	owner: object,
	counter: HistoryWorkCounter,
	amount: number | (() => number) = 1,
): void {
	const work = observations.get(owner);
	if (work) work[counter] += typeof amount === "number" ? amount : amount();
}

export function historyWorkFallback(owner: object, reason: string): void {
	const work = observations.get(owner);
	if (work) work.fallbacks.set(reason, (work.fallbacks.get(reason) ?? 0) + 1);
}

// Proofs name a specific immutable accepted array, never a matching length or a matching first row.
// Weak predecessors let an old accepted frame and its transport state be collected together.
const providerPrefixes = new WeakMap<readonly Message[], { previous?: WeakRef<readonly Message[]>; count: number }>();

export function registerProviderMessagePrefix(
	next: readonly Message[],
	previous: readonly Message[] | undefined,
	count: number,
): void {
	if (!Number.isSafeInteger(count) || count < 0 || count > Math.min(next.length, previous?.length ?? 0))
		throw new RangeError("Invalid accepted provider prefix extent");
	providerPrefixes.set(next, { previous: previous && new WeakRef(previous), count });
}

export function providerMessagePrefix(
	next: readonly Message[],
): { previous?: readonly Message[]; count: number } | undefined {
	const proof = providerPrefixes.get(next);
	if (!proof) return undefined;
	const previous = proof.previous?.deref();
	return { previous, count: previous ? proof.count : 0 };
}

// Only the harness's read-only credential projection may receive shared wire items.
// Extension payload hooks continue to receive a mutable private request.
const readOnlyHooks = new WeakSet<object>();
export function readOnlyProviderPayloadHook<T extends object>(hook: T): T {
	readOnlyHooks.add(hook);
	return hook;
}
export function acceptsReadOnlyProviderInput(hook: object | undefined): boolean {
	return !hook || readOnlyHooks.has(hook);
}

export { responsesInputPrefix } from "./providers/openai-responses-history.ts";

/** Freeze a privately owned JSON projection. Frozen children supplied by the caller are already immutable. */
export function freezeOwnedJson(value: unknown): void {
	if (!value || typeof value !== "object") return;
	const pending = [value];
	while (pending.length) {
		const item = pending.pop()!;
		if (Object.isFrozen(item)) continue;
		Object.freeze(item);
		for (const child of Object.values(item)) if (child !== null && typeof child === "object") pending.push(child);
	}
}
