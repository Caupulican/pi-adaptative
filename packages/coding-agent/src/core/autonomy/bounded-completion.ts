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

type ExecutorSettlement = { kind: "completion"; completion: BoundedCompletion } | { kind: "error"; error: unknown };

function abortFailure(args: {
	externalSignal?: AbortSignal;
	timeoutSignal: AbortSignal;
}): BoundedCompletionOutcome["failure"] {
	if (args.externalSignal?.aborted) return { status: "canceled", reasonCode: "external_abort" };
	if (args.timeoutSignal.aborted) return { status: "timeout", reasonCode: "wall_clock_exceeded" };
	return { status: "failed", reasonCode: "completion_error" };
}

export async function runBoundedCompletion(args: {
	/** Wall-clock budget in milliseconds; 0 disables. */
	maxWallClockMs: number;
	/** External cancellation (e.g. session disposal). */
	signal?: AbortSignal;
	execute: (signal: AbortSignal) => Promise<BoundedCompletion>;
}): Promise<BoundedCompletionOutcome> {
	const timeoutController = new AbortController();
	let resolveAbort!: () => void;
	const abortPromise = new Promise<{ kind: "abort" }>((resolve) => {
		resolveAbort = () => resolve({ kind: "abort" });
	});
	const onExternalAbort = (): void => resolveAbort();
	args.signal?.addEventListener("abort", onExternalAbort, { once: true });
	const timeoutTimer =
		args.maxWallClockMs > 0
			? setTimeout(() => {
					timeoutController.abort();
					resolveAbort();
				}, args.maxWallClockMs)
			: undefined;
	if (timeoutTimer && typeof timeoutTimer === "object" && "unref" in timeoutTimer) {
		const { unref } = timeoutTimer as { unref?: () => void };
		unref?.call(timeoutTimer);
	}
	const signals: AbortSignal[] = [timeoutController.signal];
	if (args.signal) signals.push(args.signal);
	const signal = AbortSignal.any(signals);

	let settled: ExecutorSettlement | undefined;
	const execution = Promise.resolve()
		.then(() => args.execute(signal))
		.then<ExecutorSettlement, ExecutorSettlement>(
			(completion) => {
				settled = { kind: "completion", completion };
				return settled;
			},
			(error: unknown) => {
				settled = { kind: "error", error };
				return settled;
			},
		);
	if (args.signal?.aborted) resolveAbort();

	try {
		const winner = await Promise.race([execution, abortPromise]);
		if (winner.kind === "abort") {
			// An abort and a completion can settle in the same microtask turn. Give the already-queued
			// executor handlers one chance to retain that completion (and its visible spend) without
			// ever waiting for a non-cooperative executor. Later settlement remains observed by
			// `execution`'s rejection handler, preventing an unhandled rejection after this returns.
			for (let flush = 0; flush < 4 && settled === undefined; flush++) {
				await Promise.resolve();
			}
			return {
				...(settled?.kind === "completion" ? { completion: settled.completion } : {}),
				failure: abortFailure({ externalSignal: args.signal, timeoutSignal: timeoutController.signal }),
			};
		}

		if (winner.kind === "error") {
			return {
				failure:
					args.signal?.aborted || timeoutController.signal.aborted
						? abortFailure({ externalSignal: args.signal, timeoutSignal: timeoutController.signal })
						: { status: "failed", reasonCode: "completion_error" },
			};
		}

		const completion = winner.completion;
		if (args.signal?.aborted || timeoutController.signal.aborted) {
			return {
				completion,
				failure: abortFailure({ externalSignal: args.signal, timeoutSignal: timeoutController.signal }),
			};
		}
		return { completion };
	} finally {
		if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
		args.signal?.removeEventListener("abort", onExternalAbort);
	}
}
