import type { StreamFn } from "@caupulican/pi-agent-core";
import { currentProviderLane, type ProviderRequestLane } from "./lane-context.ts";
import type { ProviderAdmissionHold, ProviderAdmissionLedger } from "./ledger.ts";

/**
 * Durable record of one admission wait: a worker or background request that found the provider's
 * machine-wide in-flight limit reached and either waited for a slot or timed out and went anyway.
 * Written to the owner session so a census can see where shared-account contention landed.
 */
export const PROVIDER_ADMISSION_CUSTOM_TYPE = "provider_admission";

export interface ProviderAdmissionPolicy {
	enabled: boolean;
	/** Per provider: how many requests may be in flight machine-wide before non-foreground lanes wait; 0 or absent is unbounded. */
	limits: Readonly<Record<string, number>>;
	/** Longest a non-foreground request waits for a slot before it is admitted regardless. */
	maxWaitMs: number;
}

export interface ProviderAdmissionWaitRecord {
	provider: string;
	lane: ProviderRequestLane;
	limit: number;
	inflightAtStart: number;
	inflightAtAdmission: number;
	waitedMs: number;
	timedOut: boolean;
}

export interface ProviderAdmissionGateDeps {
	ledger: ProviderAdmissionLedger;
	getPolicy(): ProviderAdmissionPolicy;
	getLane?(): ProviderRequestLane;
	record?(record: ProviderAdmissionWaitRecord): void;
	now?(): number;
	sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

const FIRST_POLL_MS = 250;
const MAX_POLL_MS = 2_000;

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Admit one provider request. The foreground lane is registered and admitted at once: the owner's
 * own turn never waits for a shared account. A worker or background request waits while the
 * provider's machine-wide in-flight count is at its limit, polling with a doubling interval, and
 * is admitted regardless once `maxWaitMs` has passed (recorded as `timedOut`) so a wedged sibling
 * can never starve it. Returns the release to call when the request's stream has settled.
 */
export async function admitProviderRequest(
	provider: string,
	deps: ProviderAdmissionGateDeps,
	signal?: AbortSignal,
): Promise<() => void> {
	signal?.throwIfAborted();
	const policy = deps.getPolicy();
	if (!policy.enabled) return () => undefined;
	const lane = (deps.getLane ?? currentProviderLane)();
	const limit = policy.limits[provider] ?? 0;
	if (lane === "foreground" || !(limit > 0)) {
		return deps.ledger.acquire(provider, lane).release;
	}
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? sleepAbortable;
	const startedAt = now();
	let inflightAtStart: number | undefined;
	let pollMs = FIRST_POLL_MS;
	for (;;) {
		signal?.throwIfAborted();
		const attempt = deps.ledger.tryAcquire(provider, lane, limit);
		inflightAtStart ??= attempt.inflight;
		const waitedMs = now() - startedAt;
		let hold: ProviderAdmissionHold | undefined = attempt.hold;
		let timedOut = false;
		if (!hold && waitedMs >= policy.maxWaitMs) {
			hold = deps.ledger.acquire(provider, lane);
			timedOut = true;
		}
		if (hold) {
			if (waitedMs > 0 || timedOut) {
				deps.record?.({
					provider,
					lane,
					limit,
					inflightAtStart,
					inflightAtAdmission: attempt.inflight,
					waitedMs,
					timedOut,
				});
			}
			return hold.release;
		}
		await sleep(Math.min(pollMs, Math.max(1, policy.maxWaitMs - waitedMs)), signal);
		pollMs = Math.min(MAX_POLL_MS, pollMs * 2);
	}
}

/**
 * Wrap a stream function so every request it starts is admitted through the machine-wide ledger
 * and released when its stream settles (terminal result, stream error, or caller abort). Installed
 * outside the idle watchdog and the perf profiler, so time spent waiting for a slot is neither a
 * connect stall nor part of the model's measured time to first token.
 */
export function withProviderAdmission(streamFn: StreamFn, deps: ProviderAdmissionGateDeps): StreamFn {
	return async (model, context, options) => {
		const release = await admitProviderRequest(model.provider, deps, options?.signal);
		let released = false;
		const releaseOnce = (): void => {
			if (released) return;
			released = true;
			release();
		};
		let inner: Awaited<ReturnType<StreamFn>>;
		try {
			inner = await streamFn(model, context, options);
		} catch (error) {
			releaseOnce();
			throw error;
		}
		inner.result().then(releaseOnce, releaseOnce);
		options?.signal?.addEventListener("abort", releaseOnce, { once: true });
		return inner;
	};
}
