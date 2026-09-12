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
