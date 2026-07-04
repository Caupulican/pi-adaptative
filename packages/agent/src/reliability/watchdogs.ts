/**
 * Silence/idle watchdogs for the reliability kernel.
 *
 * A silence watchdog bounds "running but mute" — it never bounds total runtime,
 * so long tasks that produce output are never killed (autonomy constraint).
 */

export interface SilenceWatchdog {
	/** Report activity (output chunk / stream event); resets the countdown. */
	touch(): void;
	/** Stop permanently (normal completion). Idempotent. */
	disarm(): void;
}

export interface SilenceWatchdogOptions {
	silenceMs: number;
	/** Fired at most once, after silenceMs with no touch(). The watchdog self-disarms. */
	onSilence: () => void;
}

export function createSilenceWatchdog(opts: SilenceWatchdogOptions): SilenceWatchdog {
	let timer: NodeJS.Timeout | undefined;
	let disarmed = false;

	const arm = () => {
		timer = setTimeout(() => {
			disarmed = true;
			timer = undefined;
			opts.onSilence();
		}, opts.silenceMs);
		// Never keep the host process alive just for a watchdog.
		timer.unref?.();
	};

	arm();

	return {
		touch(): void {
			if (disarmed) return;
			if (timer) clearTimeout(timer);
			arm();
		},
		disarm(): void {
			disarmed = true;
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

// --- Stream-idle watchdog (wraps a StreamFn) -------------------------------

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
} from "@caupulican/pi-ai";
import type { StreamFn } from "../types.ts";

export interface StreamIdleOptions {
	/** Max ms between events once streaming has started (user-locked default 30s). */
	idleMs: number;
	/** Max ms to wait for the FIRST event (connection/first-token allowance). */
	connectMs: number;
	/** Fired once when a stall is detected, before the inner request is aborted. */
	onStall?: (info: { phase: "connect" | "stream"; elapsedMs: number }) => void;
}

export const DEFAULT_STREAM_IDLE: StreamIdleOptions = { idleMs: 30_000, connectMs: 120_000 };

/** Extracts the current AssistantMessage snapshot carried by any stream event variant. */
function partialFromEvent(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return event.partial;
}

/**
 * Wrap a StreamFn so a silently dead connection cannot wedge a turn forever.
 *
 * `connectMs` bounds the wait for the first event (connection/first-token allowance);
 * once streaming starts, `idleMs` bounds the gap between subsequent events. On stall,
 * the inner request is aborted and the returned stream resolves immediately with a
 * synthetic `AssistantMessage` (`stopReason: "error"`, `errorMessage: "stream stalled:
 * no events for <n>ms"`) — the exact phrasing `classifyFailure` maps to a retryable
 * `stream_stall`, so the host's retry/failover path takes it from there.
 *
 * A caller-initiated abort (via the options `signal`) is never treated as a stall: it
 * is chained into the wrapper's own controller and the inner stream's own abort result
 * is forwarded untouched.
 */
export function withStreamIdleWatchdog(streamFn: StreamFn, options?: Partial<StreamIdleOptions>): StreamFn {
	const opts = { ...DEFAULT_STREAM_IDLE, ...options };
	return async (model, context, streamOptions) => {
		const controller = new AbortController();
		const callerSignal = streamOptions?.signal;
		let callerAborted = callerSignal?.aborted ?? false;
		const onCallerAbort = () => {
			callerAborted = true;
			controller.abort(callerSignal?.reason);
		};
		if (callerAborted) controller.abort(callerSignal?.reason);
		else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

		const inner = await streamFn(model, context, { ...streamOptions, signal: controller.signal });
		const outer = createAssistantMessageEventStream();

		// Seeded so a connect-phase stall (no event ever arrived) still has a base message
		// to report on; overwritten with the latest real snapshot once events start flowing.
		let latest: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let firstEventSeen = false;
		let stalled = false;

		// Emits the stall result directly (rather than after the inner loop finishes) so a
		// connection that never resolves at all still yields a result promptly — providers
		// are contractually expected to end their stream after abort, but the watchdog does
		// not depend on that to report the stall itself.
		const stall = (phase: "connect" | "stream", elapsedMs: number) => {
			if (callerAborted || stalled) return;
			stalled = true;
			opts.onStall?.({ phase, elapsedMs });
			controller.abort(new Error(`stream stalled: no events for ${elapsedMs}ms`));
			const message: AssistantMessage = {
				...latest,
				stopReason: "error",
				errorMessage: `stream stalled: no events for ${elapsedMs}ms`,
			};
			outer.push({ type: "error", reason: "error", error: message });
		};

		let watchdog = createSilenceWatchdog({
			silenceMs: opts.connectMs,
			onSilence: () => stall("connect", opts.connectMs),
		});

		void (async () => {
			try {
				for await (const event of inner) {
					if (stalled) break;
					if (!firstEventSeen) {
						firstEventSeen = true;
						watchdog.disarm();
						watchdog = createSilenceWatchdog({
							silenceMs: opts.idleMs,
							onSilence: () => stall("stream", opts.idleMs),
						});
					} else {
						watchdog.touch();
					}
					latest = partialFromEvent(event);
					// A terminal event ends the turn: disarm synchronously, in the same tick as
					// the push below, so no watchdog can fire after the consumer's `result()`
					// promise resolves — a disarm that only happened once the loop later notices
					// `inner` is done would race with that resolution (it runs a tick or more
					// later) and could fire a spurious stall on an already-finished stream.
					const terminal = event.type === "done" || event.type === "error";
					if (terminal) {
						watchdog.disarm();
						callerSignal?.removeEventListener("abort", onCallerAbort);
					}
					outer.push(event);
					if (terminal) return;
				}
			} finally {
				watchdog.disarm();
				callerSignal?.removeEventListener("abort", onCallerAbort);
			}
		})();

		return outer;
	};
}
