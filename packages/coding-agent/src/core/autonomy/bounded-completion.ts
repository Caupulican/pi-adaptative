import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";

/**
 * Shared wall-clock/cancellation envelope for one-shot lane completions (research and delegated workers).
 * Composes an optional external abort signal with an internal wall-clock timeout, executes the
 * injected completion, and maps every failure to a stable status/reasonCode pair. Never throws.
 */

export interface BoundedCompletion {
	text: string;
	costUsd: number;
	stopReason: string;
}

export type BoundedCompletionFailureStatus = "canceled" | "timeout" | "failed" | "budget_exhausted";

/**
 * Typed failure crossing the executor boundary. Policy owners use this instead of forcing the
 * completion envelope to infer a bounded denial from human-readable error text.
 */
export class BoundedCompletionFailureError extends Error {
	readonly status: BoundedCompletionFailureStatus;
	readonly reasonCode: string;

	constructor(status: BoundedCompletionFailureStatus, reasonCode: string, message: string) {
		super(message);
		this.name = "BoundedCompletionFailureError";
		this.status = status;
		this.reasonCode = reasonCode;
	}
}

export interface BoundedCompletionOutcome {
	/** Present when the executor settled; may coexist with `failure` when an abort raced the result. */
	completion?: BoundedCompletion;
	failure?: { status: BoundedCompletionFailureStatus; reasonCode: string; detail?: string };
}

/**
 * Preserve the executor's actual error alongside the stable reason code. A bare
 * `completion_error` is undiagnosable from lane records alone (field lesson: workers dying
 * on provider socket drops and budget denials all flattened to the same code).
 */
export function boundedFailureDetail(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	if (!message) return undefined;
	return boundedRedactedDiagnosticText(message);
}

type ExecutorSettlement = { kind: "completion"; completion: BoundedCompletion } | { kind: "error"; error: unknown };

const MAX_HOST_TIMER_DELAY_MS = 2_147_483_647;

function abortFailure(args: {
	externalSignal?: AbortSignal;
	timeoutSignal: AbortSignal;
}): BoundedCompletionOutcome["failure"] {
	if (args.externalSignal?.aborted) return { status: "canceled", reasonCode: "external_abort" };
	if (args.timeoutSignal.aborted) return { status: "timeout", reasonCode: "wall_clock_exceeded" };
	return { status: "failed", reasonCode: "completion_error" };
}

function executorFailure(error: unknown): BoundedCompletionOutcome["failure"] {
	const detail = boundedFailureDetail(error);
	if (error instanceof BoundedCompletionFailureError) {
		return {
			status: error.status,
			reasonCode: error.reasonCode,
			...(detail ? { detail } : {}),
		};
	}
	return { status: "failed", reasonCode: "completion_error", ...(detail ? { detail } : {}) };
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
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let remainingWallClockMs = args.maxWallClockMs;
	const armTimeout = (): void => {
		const delayMs = Math.min(remainingWallClockMs, MAX_HOST_TIMER_DELAY_MS);
		timeoutTimer = setTimeout(() => {
			remainingWallClockMs -= delayMs;
			if (remainingWallClockMs > 0) {
				armTimeout();
				return;
			}
			timeoutController.abort();
			resolveAbort();
		}, delayMs);
		if (typeof timeoutTimer === "object" && "unref" in timeoutTimer) {
			const { unref } = timeoutTimer as { unref?: () => void };
			unref?.call(timeoutTimer);
		}
	};
	if (args.maxWallClockMs > 0) armTimeout();
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
						: executorFailure(winner.error),
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
