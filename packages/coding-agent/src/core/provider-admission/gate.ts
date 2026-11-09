import { harnessLog } from "../../kernel/harness-log.ts";
import type { StreamFn } from "../../kernel/index.ts";
import type { TimerPort, TimerSource } from "../util/timer-port.ts";
import { type WaitEndReason, type WaitEndReport, type WakeSource, waitEndReport, waitFor } from "../util/wait.ts";
import { describeProviderAccountKey, splitProviderAccountKey } from "./account-key.ts";
import { currentProviderLane, noteProviderRefusal, type ProviderRequestLane } from "./lane-context.ts";
import { PROVIDER_ADMISSION_STALE_MS, type ProviderAdmissionHold, ProviderAdmissionLedger } from "./ledger.ts";
import {
	observeProviderResult,
	ProviderLimitedError,
	ProviderLimitStore,
	providerLimitFromFailure,
} from "./limit-state.ts";
import {
	type ProviderAdmissionRefusal,
	ProviderAdmissionRefusedError,
	type ProviderRefusalReason,
	ProviderRefusalWindows,
} from "./refusal.ts";
import { messageOutcome, type ProviderRequestOutcome, thrownOutcome } from "./request-outcome.ts";

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
	/** Engage/lift notifications of that stop, this process's and (through its directory watch) every other's. */
	subscribeEmergencyStop?(onChange: () => void): () => void;
	/** Provider account key for `provider` (see account-key.ts); omitted keys on the bare provider id. */
	getAccountKey?(provider: string, apiKey?: string): string;
	getLane?(): ProviderRequestLane;
	record?(record: ProviderAdmissionWaitRecord): void;
	/**
	 * The open refusal windows of this gate. A non-foreground refusal is logged and recorded once per window, however many
	 * attempts it refuses; omitted, every refusal is recorded. {@link withProviderAdmission} supplies one.
	 */
	refusals?: ProviderRefusalWindows;
	/**
	 * Observes one dispatched request on `accountKey` until it settles (the fleet's adaptive account windows learn from
	 * it): called when the request is dispatched, the returned settle is called once with how it ended. A throwing
	 * observer never affects the request.
	 */
	observeRequest?(accountKey: string): ((outcome: ProviderRequestOutcome) => void) | undefined;
}

function observeRequestSafely(
	deps: ProviderAdmissionGateDeps,
	accountKey: string,
): (outcome: () => ProviderRequestOutcome) => void {
	let settle: ((outcome: ProviderRequestOutcome) => void) | undefined;
	try {
		settle = deps.observeRequest?.(accountKey);
	} catch {
		settle = undefined;
	}
	return (outcome) => {
		const observed = settle;
		settle = undefined;
		if (!observed) return;
		try {
			observed(outcome());
		} catch {
			harnessLog.warn("provider", "a provider request outcome could not be observed", () => ({
				account: describeProviderAccountKey(accountKey),
			}));
		}
	};
}

/**
 * The one safety recheck of an emergency-stop wait. A lift anywhere on the machine wakes the wait at once (in this process
 * through the stop's signal, in another through its directory watch); this alarm only bounds a lift a failed watch missed.
 */
const EMERGENCY_STOP_SAFETY_RECHECK_MS = 60_000;
/**
 * A capacity wait is woken at once by a hold released anywhere on the machine (`ledger.release`, which carries other
 * processes' releases through the ledger directory's watch). A holder that died without releasing produces no event:
 * its entry is pruned once its pid is gone or its heartbeat passed the staleness bound, so the wait's one recheck is
 * armed at that bound.
 */
const CAPACITY_SAFETY_RECHECK_MS = PROVIDER_ADMISSION_STALE_MS;
/** The least a refusal with no stated reset asks its caller to wait, so a lane with a zero wait budget never retries in a spin. */
const OPEN_REFUSAL_MIN_RETRY_MS = 2_000;

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

export class EmergencyStopError extends ProviderAdmissionRefusedError {
	constructor(waitedMs: number, refusal: ProviderAdmissionRefusal) {
		super(
			`Paused by the machine-wide emergency stop (ESTOP) for ${Math.ceil(waitedMs / 1000)} seconds; ` +
				"worker and background provider requests are held until it is lifted. Provider retry directive: do not retry.",
			refusal,
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
export class ModelQuotaExhaustedError extends ProviderAdmissionRefusedError {
	constructor(modelRef: string, until: number | undefined, nowMs: number, refusal: ProviderAdmissionRefusal) {
		super(
			until === undefined
				? `Model ${modelRef} quota exceeded with no reset recorded; no request was sent.`
				: `Model ${modelRef} quota exceeded until ${new Date(until).toISOString()}: ` +
						`retry after ${Math.max(1, Math.ceil((until - nowMs) / 1000))} seconds; no request was sent.`,
			refusal,
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
 * for, or its one safety recheck), `satisfied` by `change.id` as soon as any process on the machine changes what it
 * waits for, `timed_out` when the lane budget left (`boundMs`) passed, or `aborted` by the request's
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
 *     `maxWaitMs`; the foreground is never held by it. A lift anywhere ends the wait at once (this
 *     process's signal, or another's through the stop's directory watch).
 *  2. Recorded machine-wide limit: every lane waits for the recorded reset while it fits its
 *     budget (`foregroundLimitWaitMs` for the foreground, `maxWaitMs` otherwise) and otherwise
 *     refuses with {@link ProviderLimitedError}, whose message the reliability classifier reads as
 *     a rate limit with the remaining delay, so the retry ladder sleeps until the reset without
 *     sending a request that would be refused and billed. A limit this process records or clears
 *     meanwhile, here or in another process (the limits directory's watch), is read at once.
 *  3. In-flight limit: the foreground is registered and admitted at once; a worker or background
 *     request waits while the provider's machine-wide in-flight count is at its limit, woken by a
 *     release anywhere on the machine and rechecked once at the staleness bound of a dead holder, and is admitted
 *     regardless once `maxWaitMs` has passed (recorded as `timedOut`) so a wedged sibling can never
 *     starve it.
 *
 * A refusal carries `retryAt` ({@link ProviderAdmissionRefusal}): the recorded reset, or with none the lane's wait budget
 * from now. A non-foreground refusal is logged and recorded once per open refusal window (`deps.refusals`), however many
 * attempts it refuses.
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
	/**
	 * Opens the refusal for `reason`: its `retryAt` is the recorded reset, or, with none stated, the lane's wait budget from
	 * now. A non-foreground refusal inside an open window gets that window's own `retryAt` and is not `first`; only a
	 * `first` refusal is written (log and durable record). The refusal is noted on the current lane scope, where the owner
	 * of the work reads it after a completion loop has turned the thrown error into a message.
	 */
	const openRefusal = (
		reason: ProviderRefusalReason,
		limitedUntil: number | undefined,
	): { refusal: ProviderAdmissionRefusal; first: boolean; at: number } => {
		const at = now();
		const proposed: ProviderAdmissionRefusal = {
			provider,
			lane,
			reason,
			retryAt: limitedUntil ?? at + Math.max(policy.maxWaitMs, OPEN_REFUSAL_MIN_RETRY_MS),
			retryAtBasis: limitedUntil === undefined ? "wait_budget" : "recorded_reset",
		};
		const window = lane === "foreground" ? undefined : deps.refusals?.enter(key, proposed, limitedUntil, at);
		const refusal = window ? { ...proposed, retryAt: window.retryAt } : proposed;
		noteProviderRefusal(refusal);
		return { refusal, first: window?.first !== false, at };
	};
	const refuse = (
		reason: "model_quota" | "provider_limit",
		waitedMs: number,
		limitedUntil: number | undefined,
	): ProviderAdmissionRefusal => {
		const { refusal, first, at } = openRefusal(reason, limitedUntil);
		if (first) {
			harnessLog.warn("provider", "a provider request was refused at admission", () => ({
				provider,
				account: describeProviderAccountKey(key),
				lane,
				reason,
				waitedMs,
				retryAfterMs: Math.max(0, refusal.retryAt - at),
			}));
			deps.record?.({
				...base,
				reason,
				inflightAtStart: inflightNow(),
				inflightAtAdmission: inflightNow(),
				waitedMs,
				timedOut: true,
				limitedUntil,
			});
		}
		return refusal;
	};
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
		harnessLog.debug("provider", "a request waits for a recorded reset", () => ({
			provider,
			account: describeProviderAccountKey(key),
			lane,
			reason,
			remainingMs,
			budgetLeftMs,
		}));
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
				throw new ModelQuotaExhaustedError(
					modelRef,
					exhaustion.until,
					startedAt,
					refuse("model_quota", waitedMs, exhaustion.until),
				);
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
					const { refusal, first } = openRefusal("emergency_stop", undefined);
					if (first) {
						harnessLog.warn("provider", "a request was refused: the emergency stop outlasted its wait", () => ({
							provider,
							account: describeProviderAccountKey(key),
							lane,
							waitedMs,
							maxWaitMs: policy.maxWaitMs,
						}));
						deps.record?.({
							...base,
							reason: "emergency_stop",
							inflightAtStart,
							inflightAtAdmission: inflightNow(),
							waitedMs,
							timedOut: true,
						});
					}
					end = { kind: "timed_out", boundMs: policy.maxWaitMs };
					throw new EmergencyStopError(waitedMs, refusal);
				}
				const budgetLeftMs = Math.max(1, policy.maxWaitMs - waitedMs);
				const recheckMs = Math.min(EMERGENCY_STOP_SAFETY_RECHECK_MS, budgetLeftMs);
				await pauseAdmission(timers, { id: "emergency_stop.recheck", ms: recheckMs }, budgetLeftMs, signal, lift);
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
				throw new ProviderLimitedError(
					recorded,
					startedAt,
					refuse("provider_limit", startedAt - limitWaitStartedAt, recorded.limitedUntil),
				);
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
				if (timedOut) {
					harnessLog.warn("provider", "a request went past the in-flight limit after waiting", () => ({
						provider,
						account: describeProviderAccountKey(key),
						lane,
						limit,
						inflight: attempt.inflight,
						waitedMs,
					}));
				}
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
				harnessLog.debug("provider", "a request waits for an in-flight slot", () => ({
					provider,
					account: describeProviderAccountKey(key),
					lane,
					limit,
					inflight: attempt.inflight,
				}));
			}
			const budgetLeftMs = Math.max(1, policy.maxWaitMs - waitedMs);
			await pauseAdmission(
				timers,
				{ id: "ledger.recheck", ms: Math.min(CAPACITY_SAFETY_RECHECK_MS, budgetLeftMs) },
				budgetLeftMs,
				signal,
				release,
			);
		}
	} catch (error) {
		endWait(thrownWaitEnd(error, signal));
		throw error;
	}
}

/**
 * Wrap a stream function so every request it starts is admitted through the machine-wide ledger
 * and released when the physical provider request settles (or preparation ends without dispatch), and so
 * every settled result feeds the shared limit state (a 429 or overload records the reset, a
 * success clears it, Codex window snapshots are persisted). Installed outside the idle watchdog
 * and the perf profiler, so time spent waiting is neither a connect stall nor part of the model's
 * measured time to first token.
 */
export function withProviderAdmission(streamFn: StreamFn, gateDeps: ProviderAdmissionGateDeps): StreamFn {
	const deps: ProviderAdmissionGateDeps = { ...gateDeps, refusals: gateDeps.refusals ?? new ProviderRefusalWindows() };
	return async (model, context, options) => {
		const key =
			options?.providerAccountKey ?? deps.getAccountKey?.(model.provider, options?.apiKey) ?? model.provider;
		const admitStartedAt = deps.ledger.timers.now();
		const release = await admitProviderRequest(
			model.provider,
			`${model.provider}/${model.id}`,
			{ ...deps, getAccountKey: () => key },
			options?.signal,
		);
		harnessLog.trace("provider", "a provider request was admitted", () => ({
			provider: model.provider,
			model: model.id,
			account: describeProviderAccountKey(key),
			lane: (deps.getLane ?? currentProviderLane)(),
			waitedMs: deps.ledger.timers.now() - admitStartedAt,
		}));
		const now = (): number => deps.ledger.timers.now();
		const requestStartedAt = now();
		let released = false;
		let dispatched = false;
		const releaseOnce = (): void => {
			if (released) return;
			released = true;
			options?.signal?.removeEventListener("abort", releaseBeforeDispatch);
			try {
				release();
			} catch {
				// ProviderAdmissionLedger stops the failed hold's heartbeat before unlinking it, so
				// stale-record pruning remains the recovery owner. Cleanup must not replace the provider
				// failure or create an unobserved rejection from a terminal-result callback.
				harnessLog.warn(
					"provider",
					"a provider slot could not be released; stale-record pruning will reclaim it",
					() => ({
						provider: model.provider,
					}),
				);
			}
		};
		const releaseBeforeDispatch = (): void => {
			if (!dispatched) releaseOnce();
		};
		options?.signal?.addEventListener("abort", releaseBeforeDispatch, { once: true });
		const recordFailureLimit = (error: unknown): void => {
			if (!deps.limits) return;
			try {
				const limit = providerLimitFromFailure(model.provider, error, now());
				if (limit) deps.limits.record(key, limit);
			} catch {
				// Shared-state bookkeeping must never mask the failure.
				harnessLog.warn("provider", "a provider failure could not be recorded as a limit", () => ({
					provider: model.provider,
				}));
			}
		};
		let inner: Awaited<ReturnType<StreamFn>>;
		try {
			options?.signal?.throwIfAborted();
			inner = await streamFn(model, context, {
				...options,
				providerResponseObserver: {
					begin: (requestModel, signal) => {
						if (released) throw new Error("Provider admission ended before dispatch.");
						const parent = options?.providerResponseObserver?.begin(requestModel, signal);
						dispatched = true;
						const settleObserved = observeRequestSafely(deps, key);
						return {
							complete: (message) => {
								settleObserved(() => messageOutcome(message, now()));
								try {
									parent?.complete(message);
								} catch (error) {
									parent?.failed(error);
								} finally {
									releaseOnce();
								}
								if (deps.limits) {
									try {
										observeProviderResult(deps.limits, message, now(), key, requestStartedAt);
									} catch {
										/* Limit telemetry must not fail terminal accounting. */
										harnessLog.warn(
											"provider",
											"a response could not be folded into the shared limit state",
											() => ({
												provider: model.provider,
											}),
										);
									}
								}
							},
							failed: (error) => {
								settleObserved(() => thrownOutcome(model.provider, error, now(), signal));
								try {
									parent?.failed(error);
								} finally {
									releaseOnce();
									recordFailureLimit(error);
								}
							},
						};
					},
				},
			});
			inner.result().then(releaseBeforeDispatch, releaseBeforeDispatch);
		} catch (error) {
			releaseBeforeDispatch();
			throw error;
		}
		return inner;
	};
}
