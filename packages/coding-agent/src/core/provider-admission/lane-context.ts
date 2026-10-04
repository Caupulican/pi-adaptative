import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Which kind of work a provider request serves. The owner's own turn is `foreground`; a delegated
 * worker's requests (its provider turns and its compactions) are `worker`; every other isolated
 * completion (reflection, research, curation, judges) is `background`. Admission treats the lanes
 * differently: the foreground is never made to wait for a shared account, the other two yield.
 */
export type ProviderRequestLane = "foreground" | "worker" | "background";

const laneStorage = new AsyncLocalStorage<ProviderRequestLane>();

/** Run `fn` with every provider request it (transitively) starts attributed to `lane`. */
export function runInProviderLane<T>(lane: ProviderRequestLane, fn: () => T): T {
	return laneStorage.run(lane, fn);
}

/** The lane of the current async context; a request started outside any lane is the foreground. */
export function currentProviderLane(): ProviderRequestLane {
	return laneStorage.getStore() ?? "foreground";
}

/** Map an isolated completion's `laneKind` namespace onto an admission lane. */
export function providerLaneForIsolatedLaneKind(laneKind: string | undefined): ProviderRequestLane {
	return laneKind?.startsWith("worker") ? "worker" : "background";
}

/** Suffix that marks an adaptation-store key as the worker lane's measurements of a model. */
const WORKER_LANE_KEY_SUFFIX = "#lane:worker";

/**
 * The adaptation-store key a request's perf samples are recorded under. A delegated worker's
 * requests run through the owner session's chain but are a different workload (parallel,
 * contended, differently sized prompts), so they are attributed to their own `#lane:worker` key
 * instead of skewing the model profile the owner's own stall budgets read. Still recorded, never
 * dropped: the host-measured telemetry stays available per lane.
 */
export function perfAttributionKey(modelKey: string, lane: ProviderRequestLane): string {
	return lane === "worker" ? `${modelKey}${WORKER_LANE_KEY_SUFFIX}` : modelKey;
}

/** The model and lane an adaptation-store key stands for; the inverse of {@link perfAttributionKey}. */
export function splitPerfAttributionKey(key: string): { model: string; lane: "worker" | undefined } {
	return key.endsWith(WORKER_LANE_KEY_SUFFIX)
		? { model: key.slice(0, -WORKER_LANE_KEY_SUFFIX.length), lane: "worker" }
		: { model: key, lane: undefined };
}
