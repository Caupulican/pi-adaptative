import type { StreamFn } from "../../kernel/index.ts";
import type { TimerPort, TimerSource } from "../util/timer-port.ts";
import { type WaitEndReason, type WaitEndReport, type WakeSource, waitEndReport, waitFor } from "../util/wait.ts";
import { splitProviderAccountKey } from "./account-key.ts";
import { currentProviderLane, type ProviderRequestLane } from "./lane-context.ts";
import { type ProviderAdmissionHold, ProviderAdmissionLedger } from "./ledger.ts";
import {
	observeProviderResult,
	ProviderLimitedError,
	ProviderLimitStore,
	providerLimitFromFailure,
} from "./limit-state.ts";

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

export type ProviderAdmissionWaitReason = "capacity" | "provider_limit" | "emergency_stop" | "model_quota";

/** A model whose quota is exhausted for this host: its recorded reset, or `undefined` when none was recorded. */
export interface ModelExhaustion {
	readonly until: number | undefined;
}

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

/** Live notification that a request is waiting (or stopped waiting) at admission; for the UI, not durable. */
export interface ProviderAdmissionWaitEvent {
	phase: "start" | "end";
	provider: string;
	account?: string;
	lane: ProviderRequestLane;
	reason: ProviderAdmissionWaitReason;
	/** Expected wait when known at start (a recorded limit's reset); the actual wait at end. */
	expectedMs?: number;
	waitedMs?: number;
	limitedUntil?: number;
	/**
	 * `end` only: how the wait ended. `satisfied` names what let the request through (`ledger.slot`, a reset that passed,
	 * `emergency_stop.lifted`); `timed_out` is the lane budget expiring (a capacity wait then goes anyway, an emergency
	 * stop refuses); `aborted` is the request's own signal; `unavailable` is a refusal or failure met while waiting.
	 */
	end?: WaitEndReport;
}

export interface ProviderAdmissionGateDeps {
	/** The machine-wide ledger; its `timers` (the `provider-admission` port) are the clock and alarms of every pause here. */
	ledger: ProviderAdmissionLedger;
	/** Live wait notifications for the operator's activity lane; every `start` is followed by one `end`. */
	onWait?(event: ProviderAdmissionWaitEvent): void;
	getPolicy(): ProviderAdmissionPolicy;
	/** Shared "provider limited until T" state; omitted disables limit checks and result observation. */
	limits?: ProviderLimitStore;
	/** The quota exhaustion holding for a `provider/model` ref, with its reset when one was recorded. */
	modelExhaustion(modelRef: string): ModelExhaustion | undefined;
	/** Machine-wide emergency stop; omitted means never engaged. */
	isEmergencyStopEngaged?(): boolean;
	/** In-process engage/lift notifications of that stop; a lift elsewhere is read by the stop's poll. */
	subscribeEmergencyStop?(onChange: () => void): () => void;
	/** Provider account key for `provider` (see account-key.ts); omitted keys on the bare provider id. */
	getAccountKey?(provider: string, apiKey?: string): string;
	getLane?(): ProviderRequestLane;
	record?(record: ProviderAdmissionWaitRecord): void;
}

/**
 * The cross-process re-read of a capacity wait: a hold released in this process wakes the wait at once (`ledger.release`),
 * one released by another process is read by this poll, its interval doubling from the first to the last.
 */
const FIRST_POLL_MS = 250;
const MAX_POLL_MS = 2_000;
/** The cross-process re-read of an emergency stop: a lift in this process wakes the wait at once. */
const EMERGENCY_STOP_POLL_MS = 2_000;

/**
 * Why an owner steer never ends an admission pause: the pause is the admission of the provider request the run is
 * already sending, so the steer is read at the run's next provider boundary whatever happens here, and ending the pause
 * early only sends the request into the limit, the full in-flight cap, or the emergency stop it waits out (a refusal the
 * provider bills, or a hold the operator set).
 */
const ADMISSION_STEER_EXEMPTION =
	"the pause admits the request already being sent: a steer is read at the next provider boundary, and ending the pause early only sends into the limit it waits out";

/** The session's ledger and limit store on its `provider-admission` port, so a hold's staleness, a limit's expiry and the gate's pauses read one clock. */
export function openProviderAdmission(
	agentDir: string,
	sessionId: string,
	source: TimerSource,
): { ledger: ProviderAdmissionLedger; limits: ProviderLimitStore } {
	const timers = source.port("provider-admission");
	return {
		ledger: new ProviderAdmissionLedger(agentDir, { sessionId, timers }),
		limits: new ProviderLimitStore(agentDir, { sessionId, now: () => timers.now() }),
	};
}

export class EmergencyStopError extends Error {
	constructor(waitedMs: number) {
		super(
			`Paused by the machine-wide emergency stop (ESTOP) for ${Math.ceil(waitedMs / 1000)} seconds; ` +
				"worker and background provider requests are held until it is lifted. Provider retry directive: do not retry.",
		);
		this.name = "EmergencyStopError";
	}
}

/**
 * A model that is out of quota past this request's wait budget, refused before anything is sent. Worded as
 * quota, not rate limit: a rate-limit reading would record an account-wide limit that blocks every other model
 * on the account. The retry delay is spelled as the classifier reads it, so the owner's failover records the
 * model's reset rather than an open-ended exhaustion.
 */
export class ModelQuotaExhaustedError extends Error {
	constructor(modelRef: string, until: number | undefined, nowMs: number) {
		super(
			until === undefined
				? `Model ${modelRef} quota exceeded with no reset recorded; no request was sent.`
				: `Model ${modelRef} quota exceeded until ${new Date(until).toISOString()}: ` +
						`retry after ${Math.max(1, Math.ceil((until - nowMs) / 1000))} seconds; no request was sent.`,
		);
		this.name = "ModelQuotaExhaustedError";
	}
}

/** In-process change notifications of what a pause waits for, named for its `satisfied` end. */
interface AdmissionChange {
	readonly id: string;
	subscribe(onChange: () => void): () => void;
}

/**
 * One admission pause on the gate's port. It ends `satisfied` by `alarm.id` once `alarm.ms` passed (the reset it waits
 * for, or the re-read that sees what another process changed), `satisfied` by `change.id` as soon as this process
 * changes what it waits for, `timed_out` when the lane budget left (`boundMs`) passed, or `aborted` by the request's
 * signal. The caller reads the state again after every end. The alarm holds the process open: a one-shot run is behind
 * the request. The owner steer never ends it (`ADMISSION_STEER_EXEMPTION`).
 */
async function pauseAdmission(
	timers: TimerPort,
	alarm: { readonly id: string; readonly ms: number },
	boundMs: number,
	signal: AbortSignal | undefined,
	change?: AdmissionChange,
): Promise<WaitEndReason> {
	let fired = false;
	let changed = false;
	const wake: WakeSource<true>[] = [
		{
			id: alarm.id,
			subscribe: (onWake) => {
				const handle = timers.setTimeout(
					() => {
						fired = true;
						onWake();
					},
					alarm.ms,
					{ keepAlive: true },
				);
				return () => timers.clearTimeout(handle);
			},
			check: () => (fired ? { kind: "satisfied", value: true } : undefined),
		},
	];
	if (change)
		wake.unshift({
			id: change.id,
			subscribe: (onWake) =>
				change.subscribe(() => {
					changed = true;
					onWake();
				}),
			check: () => (changed ? { kind: "satisfied", value: true } : undefined),
		});
	const outcome = await waitFor({
		id: "provider_admission.pause",
		wake,
		signal,
		steer: { mode: "exempt", reason: ADMISSION_STEER_EXEMPTION },
		bound: { kind: "deadline", ms: boundMs },
		clock: timers,
	});
	return outcome.end;
}

/** How an admission wait that threw ended: the request's own abort, or the refusal or failure it met. */
function thrownWaitEnd(error: unknown, signal: AbortSignal | undefined): WaitEndReason {
	if (signal?.aborted) return { kind: "aborted", reason: signal.reason };
	return { kind: "unavailable", cause: error instanceof Error ? error.message : String(error) };
}

/**
 * Admit one provider request. In order:
 *
 *  0. Model quota (worker and background lanes): a model with a recorded quota reset is waited out within the lane budget
 *     (`maxWaitMs`), and otherwise refused with {@link ModelQuotaExhaustedError}. Runs ahead of the enabled switch.
 *  1. Emergency stop: worker and background lanes wait while it is engaged, then refuse after
 *     `maxWaitMs`; the foreground is never held by it. A lift in this process ends the wait at once,
 *     one elsewhere within the stop's poll.
 *  2. Recorded machine-wide limit: every lane waits for the recorded reset while it fits its
 *     budget (`foregroundLimitWaitMs` for the foreground, `maxWaitMs` otherwise) and otherwise
 *     refuses with {@link ProviderLimitedError}, whose message the reliability classifier reads as
 *     a rate limit with the remaining delay, so the retry ladder sleeps until the reset without
 *     sending a request that would be refused and billed. A limit this process records or clears
 *     meanwhile is read at once.
 *  3. In-flight limit: the foreground is registered and admitted at once; a worker or background
 *     request waits while the provider's machine-wide in-flight count is at its limit, woken by a
 *     release in this process and re-reading with a doubling poll for one elsewhere, and is admitted
 *     regardless once `maxWaitMs` has passed (recorded as `timedOut`) so a wedged sibling can never
 *     starve it.
 *
 * Every pause runs on the ledger's `provider-admission` port. Returns the release to call when the request's stream has
 * settled.
 */
export async function admitProviderRequest(
	provider: string,
	modelRef: string,
	deps: ProviderAdmissionGateDeps,
	signal?: AbortSignal,
): Promise<() => void> {
	signal?.throwIfAborted();
	const policy = deps.getPolicy();
	const lane = (deps.getLane ?? currentProviderLane)();
	const timers = deps.ledger.timers;
	const now = (): number => timers.now();
	const limit = policy.limits[provider] ?? 0;
	const key = deps.getAccountKey?.(provider) ?? provider;
	const account = splitProviderAccountKey(key).account;
	const inflightNow = (): number => deps.ledger.countInflight(key).total;
	const base = { provider, ...(account ? { account } : {}), lane, limit } as const;
	const refuse = (
		reason: "model_quota" | "provider_limit",
		waitedMs: number,
		limitedUntil: number | undefined,
	): void =>
		deps.record?.({
			...base,
			reason,
			inflightAtStart: inflightNow(),
			inflightAtAdmission: inflightNow(),
			waitedMs,
			timedOut: true,
			limitedUntil,
		});
	/** Waits out one recorded reset `remainingMs` away within the `budgetLeftMs` the lane still has, then records it. */
	const waitOutReset = async (
		reason: "model_quota" | "provider_limit",
		remainingMs: number,
		budgetLeftMs: number,
		limitedUntil: number,
		change?: AdmissionChange,
	): Promise<void> => {
		const startedAt = now();
		const inflightAtStart = inflightNow();
		deps.onWait?.({ ...base, phase: "start", reason, expectedMs: remainingMs, limitedUntil });
		const end = await pauseAdmission(
			timers,
			{ id: `${reason}.reset`, ms: remainingMs },
			budgetLeftMs,
			signal,
			change,
		);
		deps.onWait?.({ ...base, phase: "end", reason, waitedMs: now() - startedAt, end: waitEndReport(end) });
		signal?.throwIfAborted();
		deps.record?.({
			...base,
			reason,
			inflightAtStart,
			inflightAtAdmission: inflightNow(),
			waitedMs: now() - startedAt,
			timedOut: false,
			limitedUntil,
		});
	};

	// A model out of quota is not sent to. A worker or background request waits for the model's recorded reset within
	// the lane budget, as it waits out a recorded account limit, and is refused past that budget. This runs ahead of the
	// enabled switch: the quota is a fact about the model, not contention policy. No in-process event announces a quota
	// reset, so the reset's own alarm ends the pause.
	if (lane !== "foreground") {
		const quotaWaitStartedAt = now();
		for (;;) {
			signal?.throwIfAborted();
			const exhaustion = deps.modelExhaustion(modelRef);
			if (!exhaustion) break;
			const startedAt = now();
			const waitedMs = startedAt - quotaWaitStartedAt;
			if (exhaustion.until === undefined || exhaustion.until - startedAt > policy.maxWaitMs - waitedMs) {
				refuse("model_quota", waitedMs, exhaustion.until);
				throw new ModelQuotaExhaustedError(modelRef, exhaustion.until, startedAt);
			}
			const remainingMs = exhaustion.until - startedAt;
			if (remainingMs > 0)
				await waitOutReset("model_quota", remainingMs, policy.maxWaitMs - waitedMs, exhaustion.until);
		}
	}
	if (!policy.enabled) return () => undefined;

	if (lane !== "foreground" && deps.isEmergencyStopEngaged?.()) {
		const startedAt = now();
		const inflightAtStart = inflightNow();
		const lift = deps.subscribeEmergencyStop
			? { id: "emergency_stop.change", subscribe: deps.subscribeEmergencyStop }
			: undefined;
		let end: WaitEndReason = { kind: "satisfied", by: "emergency_stop.lifted" };
		deps.onWait?.({ ...base, phase: "start", reason: "emergency_stop" });
		try {
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
					end = { kind: "timed_out", boundMs: policy.maxWaitMs };
					throw new EmergencyStopError(waitedMs);
				}
				const budgetLeftMs = Math.max(1, policy.maxWaitMs - waitedMs);
				const pollMs = Math.min(EMERGENCY_STOP_POLL_MS, budgetLeftMs);
				await pauseAdmission(timers, { id: "emergency_stop.poll", ms: pollMs }, budgetLeftMs, signal, lift);
				signal?.throwIfAborted();
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
		} catch (error) {
			if (end.kind !== "timed_out") end = thrownWaitEnd(error, signal);
			throw error;
		} finally {
			deps.onWait?.({
				...base,
				phase: "end",
				reason: "emergency_stop",
				waitedMs: now() - startedAt,
				end: waitEndReport(end),
			});
		}
	}

	const limits = deps.limits;
	const limitChange: AdmissionChange | undefined = limits
		? { id: "provider_limit.change", subscribe: (onChange) => limits.subscribe(key, onChange) }
		: undefined;
	const limitWaitStartedAt = now();
	const waitForProviderLimit = async (): Promise<void> => {
		for (;;) {
			signal?.throwIfAborted();
			const recorded = limits?.read(key);
			if (!recorded) return;
			const startedAt = now();
			const remainingMs = recorded.limitedUntil - startedAt;
			const budgetMs = lane === "foreground" ? policy.foregroundLimitWaitMs : policy.maxWaitMs;
			const budgetLeftMs = budgetMs - (startedAt - limitWaitStartedAt);
			if (remainingMs > budgetLeftMs) {
				refuse("provider_limit", startedAt - limitWaitStartedAt, recorded.limitedUntil);
				throw new ProviderLimitedError(recorded, startedAt);
			}
			if (remainingMs > 0)
				await waitOutReset("provider_limit", remainingMs, budgetLeftMs, recorded.limitedUntil, limitChange);
		}
	};
	await waitForProviderLimit();

	if (lane === "foreground" || !(limit > 0)) {
		return deps.ledger.acquire(key, lane).release;
	}
	const startedAt = now();
	const release: AdmissionChange = {
		id: "ledger.release",
		subscribe: (onRelease) => deps.ledger.subscribeRelease(onRelease),
	};
	let inflightAtStart: number | undefined;
	let pollMs = FIRST_POLL_MS;
	let waiting = false;
	const endWait = (end: WaitEndReason): void => {
		if (!waiting) return;
		waiting = false;
		deps.onWait?.({
			...base,
			phase: "end",
			reason: "capacity",
			waitedMs: now() - startedAt,
			end: waitEndReport(end),
		});
	};
	try {
		for (;;) {
			await waitForProviderLimit();
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
				endWait(
					timedOut ? { kind: "timed_out", boundMs: policy.maxWaitMs } : { kind: "satisfied", by: "ledger.slot" },
				);
				return hold.release;
			}
			if (!waiting) {
				waiting = true;
				deps.onWait?.({ ...base, phase: "start", reason: "capacity" });
			}
			const budgetLeftMs = Math.max(1, policy.maxWaitMs - waitedMs);
			await pauseAdmission(
				timers,
				{ id: "ledger.poll", ms: Math.min(pollMs, budgetLeftMs) },
				budgetLeftMs,
				signal,
				release,
			);
			pollMs = Math.min(MAX_POLL_MS, pollMs * 2);
		}
	} catch (error) {
		endWait(thrownWaitEnd(error, signal));
		throw error;
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
		const key =
			options?.providerAccountKey ?? deps.getAccountKey?.(model.provider, options?.apiKey) ?? model.provider;
		const release = await admitProviderRequest(
			model.provider,
			`${model.provider}/${model.id}`,
			{ ...deps, getAccountKey: () => key },
			options?.signal,
		);
		const now = (): number => deps.ledger.timers.now();
		const requestStartedAt = now();
		let released = false;
		const releaseOnce = (): void => {
			if (released) return;
			released = true;
			options?.signal?.removeEventListener("abort", releaseOnce);
			try {
				release();
			} catch {
				// ProviderAdmissionLedger stops the failed hold's heartbeat before unlinking it, so
				// stale-record pruning remains the recovery owner. Cleanup must not replace the provider
				// failure or create an unobserved rejection from a terminal-result callback.
			}
		};
		options?.signal?.addEventListener("abort", releaseOnce, { once: true });
		const recordFailureLimit = (error: unknown): void => {
			if (!deps.limits) return;
			try {
				const limit = providerLimitFromFailure(model.provider, error, now());
				if (limit) deps.limits.record(key, limit);
			} catch {
				// Shared-state bookkeeping must never mask the failure.
			}
		};
		let inner: Awaited<ReturnType<StreamFn>>;
		try {
			options?.signal?.throwIfAborted();
			inner = await streamFn(model, context, options);
			inner.result().then(
				(message) => {
					releaseOnce();
					if (deps.limits) {
						try {
							observeProviderResult(deps.limits, message, now(), key, requestStartedAt);
						} catch {
							// Shared-state bookkeeping must never fail the request it observes.
						}
					}
				},
				(error) => {
					releaseOnce();
					recordFailureLimit(error);
				},
			);
		} catch (error) {
			releaseOnce();
			recordFailureLimit(error);
			throw error;
		}
		return inner;
	};
}
