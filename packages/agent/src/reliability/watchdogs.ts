/**
 * Silence/idle watchdogs for the reliability kernel.
 *
 * A silence watchdog bounds "running but mute" — it never bounds total runtime,
 * so long tasks that produce output are never killed (autonomy constraint).
 */

export interface SilenceWatchdog {
	/** Report activity (output chunk / stream event); resets the countdown.
	 *  Pass silenceMs to also change the bound for this and subsequent countdowns. */
	touch(silenceMs?: number): void;
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
	let currentSilenceMs = opts.silenceMs;

	const arm = () => {
		timer = setTimeout(() => {
			disarmed = true;
			timer = undefined;
			opts.onSilence();
		}, currentSilenceMs);
		// Never keep the host process alive just for a watchdog.
		timer.unref?.();
	};

	arm();

	return {
		touch(silenceMs?: number): void {
			if (disarmed) return;
			if (silenceMs !== undefined) currentSilenceMs = silenceMs;
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

export type StallPhase = "connect" | "quiet" | "active";

export interface StreamIdleOptions {
	/** Max ms to wait for the FIRST event (connection/first-token allowance). */
	connectMs: number;
	/** Max ms between events while content is flowing — the latest content block is
	 *  text or toolCall. A flowing stream that goes silent this long is presumed dead. */
	activeIdleMs: number;
	/** Max ms between events while the model is quietly working — no content blocks
	 *  yet (provider queue / prompt prefill / unstreamed reasoning) or the latest block
	 *  is thinking. Deep-thinking models and huge compaction prompts legitimately sit
	 *  here for minutes, so this bound is deliberately generous. */
	quietIdleMs: number;
	/** Fired once when a stall is detected, before the inner request is aborted. */
	onStall?: (info: { phase: StallPhase; elapsedMs: number }) => void;
}

/** User-locked defaults: connect 120s / active 180s / quiet 600s. The quiet bound must stay
 *  below the HTTP dispatcher idle timeout (see coding-agent http-dispatcher.ts, 660s) or the
 *  HTTP layer would kill quiet-but-healthy streams before this watchdog ever sees the gap. */
export const DEFAULT_STREAM_IDLE: StreamIdleOptions = {
	connectMs: 120_000,
	activeIdleMs: 180_000,
	quietIdleMs: 600_000,
};

/** Re-resolved at the start of every request, so hosts can wire live-tunable settings. */
export type StreamIdleOptionsResolver = () => Partial<StreamIdleOptions>;

/** Extracts the current AssistantMessage snapshot carried by any stream event variant. */
function partialFromEvent(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return event.partial;
}

/**
 * Wrap a StreamFn so a silently dead connection cannot wedge a turn forever.
 *
 * Phase-aware: `connectMs` bounds the wait for the first event; after that the
 * inter-event bound adapts to what the stream is doing — `quietIdleMs` while the
 * model is quietly working (no content blocks yet, or the latest block is thinking:
 * prefill, provider queues, unstreamed reasoning) and `activeIdleMs` once content is
 * flowing (latest block is text/toolCall). This keeps detection fast where silence is
 * anomalous without killing healthy deep-thinking or compaction-sized requests.
 * No bound ever limits total runtime (autonomy constraint).
 *
 * On stall, the inner request is aborted and the returned stream resolves immediately
 * with a synthetic `AssistantMessage` (`stopReason: "error"`, `errorMessage: "stream
 * stalled: no events for <n>ms (<phase> phase)"`) — the `stream stalled` phrasing is
 * what `classifyFailure` maps to a retryable `stream_stall`, so the host's
 * retry/failover path takes it from there.
 *
 * Options may be a resolver function; it is re-invoked at the start of every request,
 * so settings changes apply without rewrapping.
 *
 * A caller-initiated abort (via the options `signal`) is never treated as a stall: it
 * is chained into the wrapper's own controller and the inner stream's own abort result
 * is forwarded untouched.
 */
export function withStreamIdleWatchdog(
	streamFn: StreamFn,
	options?: Partial<StreamIdleOptions> | StreamIdleOptionsResolver,
): StreamFn {
	return async (model, context, streamOptions) => {
		const resolved = typeof options === "function" ? options() : options;
		const cleaned: Partial<StreamIdleOptions> = {};
		if (resolved) {
			for (const [key, val] of Object.entries(resolved)) {
				if (val !== undefined) {
					(cleaned as any)[key] = val;
				}
			}
		}
		const opts = { ...DEFAULT_STREAM_IDLE, ...cleaned };

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
		let stalled = false;
		let firstEventSeen = false;

		// The idle bound adapts per event: quiet while nothing/thinking, active while
		// text/toolCall content is flowing. Mutable so the onSilence closure always
		// reports the phase/bound that actually elapsed.
		let currentPhase: StallPhase = "connect";
		let currentBoundMs = opts.connectMs;
		const idleBoundFor = (message: AssistantMessage): { phase: StallPhase; ms: number } => {
			const lastBlock = message.content[message.content.length - 1];
			return !lastBlock || lastBlock.type === "thinking"
				? { phase: "quiet", ms: opts.quietIdleMs }
				: { phase: "active", ms: opts.activeIdleMs };
		};

		// Emits the stall result directly (rather than after the inner loop finishes) so a
		// connection that never resolves at all still yields a result promptly — providers
		// are contractually expected to end their stream after abort, but the watchdog does
		// not depend on that to report the stall itself.
		const stall = (phase: StallPhase, elapsedMs: number) => {
			if (callerAborted || stalled) return;
			stalled = true;
			opts.onStall?.({ phase, elapsedMs });
			const description = `stream stalled: no events for ${elapsedMs}ms (${phase} phase)`;
			controller.abort(new Error(description));
			const message: AssistantMessage = {
				...latest,
				stopReason: "error",
				errorMessage: description,
			};
			outer.push({ type: "error", reason: "error", error: message });
		};

		let watchdog = createSilenceWatchdog({
			silenceMs: opts.connectMs,
			onSilence: () => stall(currentPhase, currentBoundMs),
		});

		void (async () => {
			try {
				for await (const event of inner) {
					if (stalled) break;
					latest = partialFromEvent(event);
					const bound = idleBoundFor(latest);
					currentPhase = bound.phase;
					currentBoundMs = bound.ms;
					if (!firstEventSeen) {
						firstEventSeen = true;
						watchdog.disarm();
						watchdog = createSilenceWatchdog({
							silenceMs: bound.ms,
							onSilence: () => stall(currentPhase, currentBoundMs),
						});
					} else {
						watchdog.touch(bound.ms);
					}
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
