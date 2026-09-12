import type { StreamFn } from "@caupulican/pi-agent-core";
import { splitProviderAccountKey } from "./account-key.ts";
import { currentProviderLane, type ProviderRequestLane } from "./lane-context.ts";
import type { ProviderAdmissionHold, ProviderAdmissionLedger } from "./ledger.ts";
import { observeProviderResult, ProviderLimitedError, type ProviderLimitStore } from "./limit-state.ts";

/**
 * Durable record of one admission wait: a request that found the provider limited machine-wide,
 * found the provider's in-flight limit reached, or found the emergency stop engaged, and either
 * waited or timed out and went anyway. Written to the owner session so a census can see where
 * shared-account contention landed.
 */
export const PROVIDER_ADMISSION_CUSTOM_TYPE = "provider_admission";

export interface ProviderAdmissionPolicy {
	enabled: boolean;
	/** Per provider: how many requests may be in flight machine-wide before non-foreground lanes wait; 0 or absent is unbounded. */
	limits: Readonly<Record<string, number>>;
	/** Longest a non-foreground request waits (for a slot, a recorded limit, or the emergency stop) before it proceeds or refuses. */
	maxWaitMs: number;
	/** Longest the foreground waits for a recorded provider limit before the request is refused with the reset time. */
	foregroundLimitWaitMs: number;
}

export type ProviderAdmissionWaitReason = "capacity" | "provider_limit" | "emergency_stop";

export interface ProviderAdmissionWaitRecord {
	provider: string;
	/** Credential identity the request runs under, when the deps key by account. */
	account?: string;
	lane: ProviderRequestLane;
	reason: ProviderAdmissionWaitReason;
	limit: number;
	inflightAtStart: number;
	inflightAtAdmission: number;
	waitedMs: number;
	timedOut: boolean;
	/** The recorded machine-wide limit the request waited on, when the reason is `provider_limit`. */
	limitedUntil?: number;
}

export interface ProviderAdmissionGateDeps {
	ledger: ProviderAdmissionLedger;
	getPolicy(): ProviderAdmissionPolicy;
	/** Shared "provider limited until T" state; omitted disables limit checks and result observation. */
	limits?: ProviderLimitStore;
	/** Machine-wide emergency stop; omitted means never engaged. */
	isEmergencyStopEngaged?(): boolean;
	/** Provider account key for `provider` (see account-key.ts); omitted keys on the bare provider id. */
	getAccountKey?(provider: string): string;
	getLane?(): ProviderRequestLane;
	record?(record: ProviderAdmissionWaitRecord): void;
	now?(): number;
	sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

const FIRST_POLL_MS = 250;
const MAX_POLL_MS = 2_000;
const EMERGENCY_STOP_POLL_MS = 2_000;

export class EmergencyStopError extends Error {
	constructor(waitedMs: number) {
		super(
			`Paused by the machine-wide emergency stop (ESTOP) for ${Math.ceil(waitedMs / 1000)} seconds; ` +
				"worker and background provider requests are held until it is lifted. Provider retry directive: do not retry.",
		);
		this.name = "EmergencyStopError";
	}
}

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
 * Admit one provider request. In order:
 *
 *  1. Emergency stop: worker and background lanes wait while it is engaged, then refuse after
 *     `maxWaitMs`; the foreground is never held by it.
 *  2. Recorded machine-wide limit: every lane waits for the recorded reset while it fits its
 *     budget (`foregroundLimitWaitMs` for the foreground, `maxWaitMs` otherwise) and otherwise
 *     refuses with {@link ProviderLimitedError}, whose message the reliability classifier reads as
 *     a rate limit with the remaining delay, so the retry ladder sleeps until the reset without
 *     sending a request that would be refused and billed.
 *  3. In-flight limit: the foreground is registered and admitted at once; a worker or background
 *     request waits while the provider's machine-wide in-flight count is at its limit, polling with
 *     a doubling interval, and is admitted regardless once `maxWaitMs` has passed (recorded as
 *     `timedOut`) so a wedged sibling can never starve it.
 *
 * Returns the release to call when the request's stream has settled.
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
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? sleepAbortable;
	const limit = policy.limits[provider] ?? 0;
	const key = deps.getAccountKey?.(provider) ?? provider;
	const account = splitProviderAccountKey(key).account;
	const inflightNow = (): number => deps.ledger.countInflight(key).total;
	const base = { provider, ...(account ? { account } : {}), lane, limit } as const;

	if (lane !== "foreground" && deps.isEmergencyStopEngaged?.()) {
		const startedAt = now();
		const inflightAtStart = inflightNow();
		while (deps.isEmergencyStopEngaged?.()) {
			const waitedMs = now() - startedAt;
			if (waitedMs >= policy.maxWaitMs) {
				deps.record?.({
					...base,
					reason: "emergency_stop",
					inflightAtStart,
					inflightAtAdmission: inflightNow(),
					waitedMs,
					timedOut: true,
				});
				throw new EmergencyStopError(waitedMs);
			}
			await sleep(Math.min(EMERGENCY_STOP_POLL_MS, Math.max(1, policy.maxWaitMs - waitedMs)), signal);
		}
		deps.record?.({
			...base,
			reason: "emergency_stop",
			inflightAtStart,
			inflightAtAdmission: inflightNow(),
			waitedMs: now() - startedAt,
			timedOut: false,
		});
		signal?.throwIfAborted();
	}

	const recorded = deps.limits?.read(key);
	if (recorded) {
		const startedAt = now();
		const remainingMs = recorded.limitedUntil - startedAt;
		const budgetMs = lane === "foreground" ? policy.foregroundLimitWaitMs : policy.maxWaitMs;
		if (remainingMs > budgetMs) {
			deps.record?.({
				...base,
				reason: "provider_limit",
				inflightAtStart: inflightNow(),
				inflightAtAdmission: inflightNow(),
				waitedMs: 0,
				timedOut: true,
				limitedUntil: recorded.limitedUntil,
			});
			throw new ProviderLimitedError(recorded, startedAt);
		}
		if (remainingMs > 0) {
			const inflightAtStart = inflightNow();
			await sleep(remainingMs, signal);
			deps.record?.({
				...base,
				reason: "provider_limit",
				inflightAtStart,
				inflightAtAdmission: inflightNow(),
				waitedMs: now() - startedAt,
				timedOut: false,
				limitedUntil: recorded.limitedUntil,
			});
			signal?.throwIfAborted();
		}
	}

	if (lane === "foreground" || !(limit > 0)) {
		return deps.ledger.acquire(key, lane).release;
	}
	const startedAt = now();
	let inflightAtStart: number | undefined;
	let pollMs = FIRST_POLL_MS;
	for (;;) {
		signal?.throwIfAborted();
		const attempt = deps.ledger.tryAcquire(key, lane, limit);
		inflightAtStart ??= attempt.inflight;
		const waitedMs = now() - startedAt;
		let hold: ProviderAdmissionHold | undefined = attempt.hold;
		let timedOut = false;
		if (!hold && waitedMs >= policy.maxWaitMs) {
			hold = deps.ledger.acquire(key, lane);
			timedOut = true;
		}
		if (hold) {
			if (waitedMs > 0 || timedOut) {
				deps.record?.({
					...base,
					reason: "capacity",
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
 * and released when its stream settles (terminal result, stream error, or caller abort), and so
 * every settled result feeds the shared limit state (a 429 or overload records the reset, a
 * success clears it, Codex window snapshots are persisted). Installed outside the idle watchdog
 * and the perf profiler, so time spent waiting is neither a connect stall nor part of the model's
 * measured time to first token.
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
		inner.result().then(
			(message) => {
				releaseOnce();
				if (deps.limits) {
					try {
						observeProviderResult(
							deps.limits,
							message,
							(deps.now ?? Date.now)(),
							deps.getAccountKey?.(model.provider) ?? model.provider,
						);
					} catch {
						// Shared-state bookkeeping must never fail the request it observes.
					}
				}
			},
			() => releaseOnce(),
		);
		options?.signal?.addEventListener("abort", releaseOnce, { once: true });
		return inner;
	};
}
