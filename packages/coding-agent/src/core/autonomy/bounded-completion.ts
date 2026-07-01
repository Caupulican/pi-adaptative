/**
 * Shared wall-clock/cancellation envelope for one-shot lane completions (research, scout workers).
 * Composes an optional external abort signal with an internal wall-clock timeout, executes the
 * injected completion, and maps every failure to a stable status/reasonCode pair. Never throws.
 */

export interface BoundedCompletion {
	text: string;
	costUsd: number;
	stopReason: string;
}

export type BoundedCompletionFailureStatus = "canceled" | "timeout" | "failed";

export interface BoundedCompletionOutcome {
	/** Present when the executor settled; may coexist with `failure` when an abort raced the result. */
	completion?: BoundedCompletion;
	failure?: { status: BoundedCompletionFailureStatus; reasonCode: string };
}

export async function runBoundedCompletion(args: {
	/** Wall-clock budget in milliseconds; 0 disables. */
	maxWallClockMs: number;
	/** External cancellation (e.g. session disposal). */
	signal?: AbortSignal;
	execute: (signal: AbortSignal) => Promise<BoundedCompletion>;
}): Promise<BoundedCompletionOutcome> {
	const timeoutController = new AbortController();
	const timeoutTimer =
		args.maxWallClockMs > 0 ? setTimeout(() => timeoutController.abort(), args.maxWallClockMs) : undefined;
	if (timeoutTimer && typeof timeoutTimer === "object" && "unref" in timeoutTimer) {
		const { unref } = timeoutTimer as { unref?: () => void };
		unref?.call(timeoutTimer);
	}
	const signals: AbortSignal[] = [timeoutController.signal];
	if (args.signal) signals.push(args.signal);
	const signal = AbortSignal.any(signals);

	let completion: BoundedCompletion;
	try {
		completion = await args.execute(signal);
	} catch {
		if (args.signal?.aborted) {
			return { failure: { status: "canceled", reasonCode: "external_abort" } };
		}
		if (timeoutController.signal.aborted) {
			return { failure: { status: "timeout", reasonCode: "wall_clock_exceeded" } };
		}
		return { failure: { status: "failed", reasonCode: "completion_error" } };
	} finally {
		if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
	}

	// An abort can race a completion that settled without throwing; the abort still wins, but the
	// settled completion is passed through so callers can account its spend.
	if (args.signal?.aborted) {
		return { completion, failure: { status: "canceled", reasonCode: "external_abort" } };
	}
	if (timeoutController.signal.aborted) {
		return { completion, failure: { status: "timeout", reasonCode: "wall_clock_exceeded" } };
	}
	return { completion };
}
