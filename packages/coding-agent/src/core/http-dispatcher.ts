import type { StreamIdleOptions } from "@caupulican/pi-agent-core";
import * as undici from "undici";

// The default stays strictly greater than the stall watchdog's quiet bound (600s — see
// pi-agent-core DEFAULT_STREAM_IDLE): 660s = quiet bound + 60s margin. Shorter explicit
// values remain supported because constrainStreamIdleToHttpTimeout clamps every watchdog
// phase and its adaptive ceiling below the nonzero undici timeout.
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 660_000;

const MAX_HTTP_WATCHDOG_MARGIN_MS = 60_000;
const HTTP_WATCHDOG_MARGIN_RATIO = 0.1;

export interface HttpBoundedStreamIdlePolicy {
	options: StreamIdleOptions;
	/** Undefined when the HTTP idle timeout is disabled and imposes no adaptive ceiling. */
	adaptiveCeilingMs?: number;
}

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "11 min", timeoutMs: 660_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

/**
 * Keep the phase-aware watchdog authoritative over undici's coarser headers/body idle timeout.
 * A nonzero HTTP timeout constrains every watchdog phase and adaptive expansion to a value with
 * a 10% margin (capped at 60s). Disabling the HTTP timeout leaves watchdog policy untouched.
 */
export function constrainStreamIdleToHttpTimeout(
	options: StreamIdleOptions,
	httpIdleTimeoutMs: number,
): HttpBoundedStreamIdlePolicy {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(httpIdleTimeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(httpIdleTimeoutMs)}`);
	}
	if (normalizedTimeoutMs === 0) {
		return { options: { ...options } };
	}

	const marginMs = Math.min(
		MAX_HTTP_WATCHDOG_MARGIN_MS,
		Math.max(1, Math.floor(normalizedTimeoutMs * HTTP_WATCHDOG_MARGIN_RATIO)),
	);
	const adaptiveCeilingMs = Math.max(0, normalizedTimeoutMs - marginMs);
	return {
		options: {
			...options,
			connectMs: Math.min(options.connectMs, adaptiveCeilingMs),
			activeIdleMs: Math.min(options.activeIdleMs, adaptiveCeilingMs),
			quietIdleMs: Math.min(options.quietIdleMs, adaptiveCeilingMs),
		},
		adaptiveCeilingMs,
	};
}

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	undici.setGlobalDispatcher(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			bodyTimeout: normalizedTimeoutMs,
			headersTimeout: normalizedTimeoutMs,
		}),
	);
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	undici.install?.();
}
