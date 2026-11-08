import { harnessLog } from "../../kernel/harness-log.ts";
import type { ProviderRequestLane } from "./lane-context.ts";

export type ProviderRefusalReason = "model_quota" | "provider_limit" | "emergency_stop";

/**
 * Why a request was refused at admission and when admission can next succeed, readable without parsing the message.
 *
 * `retryAt` is epoch milliseconds, the domain provider reset times are stated in, so a caller compares it with the `now()`
 * of whatever timer port it already waits on. It is the recorded reset (`recorded_reset`) when the refusal rests on one;
 * a refusal that rests on no stated reset (a model out of quota with none recorded, the emergency stop) is re-evaluated
 * after the lane's wait budget (`wait_budget`), the interval the gate itself would have waited. A request sent before
 * `retryAt` is refused again, so a caller that retries earlier only repeats the refusal.
 */
export interface ProviderAdmissionRefusal {
	readonly provider: string;
	readonly lane: ProviderRequestLane;
	readonly reason: ProviderRefusalReason;
	readonly retryAt: number;
	readonly retryAtBasis: "recorded_reset" | "wait_budget";
}

/**
 * A request refused at admission before anything was sent. Every refusal the gate throws is one of these (or a subclass),
 * so a lane that waits for admission to reopen reads `retryAt` instead of the message.
 */
export class ProviderAdmissionRefusedError extends Error {
	readonly refusal: ProviderAdmissionRefusal;
	readonly retryAt: number;

	constructor(message: string, refusal: ProviderAdmissionRefusal) {
		super(message);
		this.name = "ProviderAdmissionRefusedError";
		this.refusal = refusal;
		this.retryAt = refusal.retryAt;
	}
}

const MAX_CAUSE_DEPTH = 4;

/**
 * The admission refusal behind `source`: a refused error (or one it is the cause of), or an isolated completion result
 * that ended in a refusal. Undefined for every other failure.
 */
export function providerAdmissionRefusalOf(source: unknown): ProviderAdmissionRefusal | undefined {
	let current: unknown = source;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== null && typeof current === "object"; depth++) {
		if (current instanceof ProviderAdmissionRefusedError) return current.refusal;
		const carried = (current as { providerRefusal?: ProviderAdmissionRefusal }).providerRefusal;
		if (carried) return carried;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

/**
 * The error a caller raises for an isolated completion that ended in an error stop. It keeps the admission refusal the
 * completion carried, so the caller's own failure handling can still read `retryAt`.
 */
export function isolatedCompletionError(
	result: { errorMessage?: string; providerRefusal?: ProviderAdmissionRefusal },
	fallback: string,
): Error {
	const message = result.errorMessage ?? fallback;
	return result.providerRefusal
		? new ProviderAdmissionRefusedError(message, result.providerRefusal)
		: new Error(message);
}

const MAX_TRACKED_WINDOWS = 64;
const MAX_TRACKED_PARKS = 64;

interface RefusalWindow {
	readonly provider: string;
	readonly lane: ProviderRequestLane;
	readonly reason: ProviderRefusalReason;
	readonly retryAt: number;
	suppressed: number;
}

/**
 * The refusal windows of one gate: a window is one (provider account, lane, reason, recorded reset) that is refused, open
 * until `retryAt`. Every refusal inside an open window shares that window's `retryAt`, and only the first one is written
 * durably; the rest are counted and the count is logged once when the window closes. Bounded: at most
 * {@link MAX_TRACKED_WINDOWS} windows are held, the oldest evicted first (its count logged then).
 */
export class ProviderRefusalWindows {
	private readonly windows = new Map<string, RefusalWindow>();

	/**
	 * Enter a refusal. `retryAt` is what a new window would last until; a refusal inside an open window gets that window's
	 * own `retryAt` and is counted as a repeat.
	 */
	enter(
		accountKey: string,
		refusal: ProviderAdmissionRefusal,
		resetAt: number | undefined,
		nowMs: number,
	): { retryAt: number; first: boolean } {
		for (const [key, window] of this.windows) {
			if (window.retryAt <= nowMs) this.close(key, window);
		}
		const key = `${accountKey}|${refusal.lane}|${refusal.reason}|${resetAt ?? "open"}`;
		const open = this.windows.get(key);
		if (open) {
			open.suppressed++;
			return { retryAt: open.retryAt, first: false };
		}
		this.windows.set(key, {
			provider: refusal.provider,
			lane: refusal.lane,
			reason: refusal.reason,
			retryAt: refusal.retryAt,
			suppressed: 0,
		});
		if (this.windows.size > MAX_TRACKED_WINDOWS) {
			const oldest = this.windows.entries().next().value;
			if (oldest) this.close(oldest[0], oldest[1]);
		}
		return { retryAt: refusal.retryAt, first: true };
	}

	private close(key: string, window: RefusalWindow): void {
		this.windows.delete(key);
		if (window.suppressed === 0) return;
		harnessLog.info("provider", "repeated admission refusals of one window were not recorded again", () => ({
			provider: window.provider,
			lane: window.lane,
			reason: window.reason,
			suppressed: window.suppressed,
		}));
	}
}

/** Parks already logged, by window; bounded, oldest forgotten first. */
const loggedParks = new Set<string>();

/**
 * Log, once per window, that `owner` parked its work until the refusal's `retryAt`. Call it where a lane stops retrying
 * on refusal and waits for `retryAt` on its own timer. Carries no message text.
 */
export function logProviderLanePark(owner: string, refusal: ProviderAdmissionRefusal): void {
	const key = `${owner}|${refusal.provider}|${refusal.lane}|${refusal.reason}|${refusal.retryAt}`;
	if (loggedParks.has(key)) return;
	loggedParks.add(key);
	if (loggedParks.size > MAX_TRACKED_PARKS) {
		const oldest = loggedParks.values().next().value;
		if (oldest !== undefined) loggedParks.delete(oldest);
	}
	harnessLog.warn("provider", "a lane is parked until its provider admits requests again", () => ({
		provider: refusal.provider,
		lane: refusal.lane,
		owner,
		retryAt: refusal.retryAt,
	}));
}
