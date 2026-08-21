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

import { createAssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderResponse } from "@caupulican/pi-ai/types";
import { createEmptyUsage } from "@caupulican/pi-ai/usage";
import type { StreamFn } from "../types.ts";

export type StallPhase = "connect" | "first-progress" | "quiet" | "active";

/** Structured abort reason shared with profilers; the user-facing message remains stable. */
export class StreamStallError extends Error {
	readonly phase: StallPhase;
	readonly elapsedMs: number;

	constructor(phase: StallPhase, elapsedMs: number) {
		super(`stream stalled: no events for ${elapsedMs}ms (${phase} phase)`);
		this.name = "StreamStallError";
		this.phase = phase;
		this.elapsedMs = elapsedMs;
	}
}

export function isStreamStallError(value: unknown): value is StreamStallError {
	return value instanceof StreamStallError;
}

export interface StreamIdleOptions {
	/** Max ms to wait for the FIRST event (connection/first-token allowance). */
	connectMs: number;
	/** Max ms between events while content is flowing — the latest content block is
	 *  text or toolCall. A flowing stream that goes silent this long is presumed dead. */
	activeIdleMs: number;
	/** Max ms after transport confirmation until the first non-empty model delta.
	 *  Headers and structural start frames prove connectivity, not generation progress. */
	firstProgressMs: number;
	/** Max ms between events while the model is quietly working — no content blocks
	 *  after it has emitted non-empty thinking. Deep-thinking models legitimately sit
	 *  here for minutes, so this bound is deliberately generous. */
	quietIdleMs: number;
	/** Fired once when a stall is detected, before the inner request is aborted. */
	onStall?: (info: { phase: StallPhase; elapsedMs: number }) => void;
}

/** Defaults: connect 120s / first progress 120s / active 180s / quiet 600s. The quiet bound must stay
 *  below the HTTP dispatcher idle timeout (see coding-agent http-dispatcher.ts, 660s) or the
 *  HTTP layer would kill quiet-but-healthy streams before this watchdog ever sees the gap. */
export const DEFAULT_STREAM_IDLE: StreamIdleOptions = {
	connectMs: 120_000,
	firstProgressMs: 120_000,
	activeIdleMs: 180_000,
	quietIdleMs: 600_000,
};

/** Re-resolved at the start of every request, so hosts can wire live-tunable settings. */
export type StreamIdleOptionsResolver = (...args: Parameters<StreamFn>) => Partial<StreamIdleOptions>;

/** Extracts the current AssistantMessage snapshot carried by any stream event variant. */
function partialFromEvent(event: AssistantMessageEvent): AssistantMessage {
	if (event.type === "done") return event.message;
	if (event.type === "error") return event.error;
	return event.partial;
}

/**
 * Wrap a StreamFn so a silently dead connection cannot wedge a turn forever.
 *
 * Phase-aware: `connectMs` bounds the wait for transport confirmation,
 * `firstProgressMs` bounds headers and structural frames that contain no model output,
 * `quietIdleMs` covers silence after non-empty thinking, and `activeIdleMs` covers
 * silence after text or tool-call output. This keeps detection fast where silence is
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
 * is chained into the wrapper's own controller. The inner stream's abort result is
 * forwarded untouched when it provides one; if it just ends, the wrapper synthesizes
 * an aborted terminal event so the returned stream always settles.
 */
export function withStreamIdleWatchdog(
	streamFn: StreamFn,
	options?: Partial<StreamIdleOptions> | StreamIdleOptionsResolver,
): StreamFn {
	return (model, context, streamOptions) => {
		const resolved = typeof options === "function" ? options(model, context, streamOptions) : options;
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
		const outer = createAssistantMessageEventStream();
		let readySettled = false;
		let resolveReady: (stream: typeof outer) => void = () => {};
		const ready = new Promise<typeof outer>((resolve) => {
			resolveReady = resolve;
		});
		const settleReady = () => {
			if (readySettled) return;
			readySettled = true;
			resolveReady(outer);
		};

		// Seeded so a connect-phase stall (no event ever arrived) still has a base message
		// to report on; overwritten with the latest real snapshot once events start flowing.
		let latest: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createEmptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let stalled = false;
		let meaningfulProgressSeen = false;
		let transportConfirmed = false;
		let streamSetupSettled = false;
		let terminalPushed = false;
		const pushFailure = (error?: unknown) => {
			if (terminalPushed || stalled) return;
			const stopReason = callerAborted ? "aborted" : "error";
			const detail = error instanceof Error ? `: ${error.message}` : error === undefined ? "" : `: ${String(error)}`;
			terminalPushed = true;
			outer.push({
				type: "error",
				reason: stopReason,
				error: {
					...latest,
					stopReason,
					errorMessage: callerAborted
						? `stream aborted before terminal event${detail}`
						: `stream ended without terminal event${detail}`,
				},
			});
			settleReady();
		};

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
			if (callerAborted || stalled || terminalPushed) return;
			stalled = true;
			opts.onStall?.({ phase, elapsedMs });
			const stallError = new StreamStallError(phase, elapsedMs);
			const description = stallError.message;
			controller.abort(stallError);
			const message: AssistantMessage = {
				...latest,
				stopReason: "error",
				errorMessage: description,
			};
			terminalPushed = true;
			outer.push({ type: "error", reason: "error", error: message });
			settleReady();
			callerSignal?.removeEventListener("abort", onCallerAbort);
		};

		const watchdog = createSilenceWatchdog({
			silenceMs: opts.connectMs,
			onSilence: () => stall(currentPhase, currentBoundMs),
		});
		const markTransportConfirmed = () => {
			if (callerAborted || stalled || meaningfulProgressSeen || transportConfirmed) return;
			transportConfirmed = true;
			currentPhase = "first-progress";
			currentBoundMs = opts.firstProgressMs;
			watchdog.touch(opts.firstProgressMs);
		};
		const originalOnResponse = streamOptions?.onResponse;
		const pushSetupAbort = () => {
			if (streamSetupSettled || terminalPushed || stalled) return;
			terminalPushed = true;
			watchdog.disarm();
			callerSignal?.removeEventListener("abort", onCallerAbort);
			outer.push({
				type: "error",
				reason: "aborted",
				error: {
					...latest,
					stopReason: "aborted",
					errorMessage: "stream aborted before terminal event during stream setup",
				},
			});
			settleReady();
		};
		const onCallerAbort = () => {
			callerAborted = true;
			controller.abort(callerSignal?.reason);
			pushSetupAbort();
		};
		if (callerAborted) {
			onCallerAbort();
			return ready;
		}
		callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

		void (async () => {
			try {
				let inner: Awaited<ReturnType<StreamFn>>;
				try {
					inner = await streamFn(model, context, {
						...streamOptions,
						signal: controller.signal,
						onResponse: async (response: ProviderResponse, responseModel: Model<Api>) => {
							markTransportConfirmed();
							await originalOnResponse?.(response, responseModel);
						},
					});
					streamSetupSettled = true;
					settleReady();
				} catch (error) {
					streamSetupSettled = true;
					if (terminalPushed || stalled) return;
					watchdog.disarm();
					callerSignal?.removeEventListener("abort", onCallerAbort);
					pushFailure(error);
					return;
				}

				// A setup promise may resolve after a connect stall or caller abort. The outer
				// stream is already terminal in that case, so never attach a late event pump.
				if (terminalPushed || stalled || callerAborted) return;
				for await (const event of inner) {
					if (stalled) break;
					latest = partialFromEvent(event);
					const meaningfulProgress = eventHasMeaningfulProgress(event);
					if (meaningfulProgress) meaningfulProgressSeen = true;
					if (!transportConfirmed && !meaningfulProgress) {
						markTransportConfirmed();
					} else if (meaningfulProgressSeen) {
						const bound = idleBoundFor(latest);
						currentPhase = bound.phase;
						currentBoundMs = bound.ms;
						watchdog.touch(bound.ms);
					}
					// A terminal event ends the turn: disarm synchronously, in the same tick as
					// the push below, so no watchdog can fire after the consumer's `result()`
					// promise resolves — a disarm that only happened once the loop later notices
					// `inner` is done would race with that resolution (it runs a tick or more
					// later) and could fire a spurious stall on an already-finished stream.
					const terminal = event.type === "done" || event.type === "error";
					if (terminal) {
						terminalPushed = true;
						watchdog.disarm();
						callerSignal?.removeEventListener("abort", onCallerAbort);
					}
					outer.push(event);
					if (terminal) return;
				}
				if (!terminalPushed && !stalled) {
					const stopReason = callerAborted ? "aborted" : "error";
					const description = callerAborted
						? "stream aborted before terminal event"
						: "stream ended without terminal event";
					terminalPushed = true;
					outer.push({
						type: "error",
						reason: stopReason,
						error: { ...latest, stopReason, errorMessage: description },
					});
				}
			} catch (error) {
				pushFailure(error);
			} finally {
				watchdog.disarm();
				callerSignal?.removeEventListener("abort", onCallerAbort);
			}
		})();

		return ready;
	};
}

function eventHasMeaningfulProgress(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		case "toolcall_end":
			return true;
		default:
			return false;
	}
}
