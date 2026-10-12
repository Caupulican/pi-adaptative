import * as undici from "undici";
import { isBunRuntime } from "../config.ts";
import { DEFAULT_STREAM_IDLE, type StreamIdleOptions } from "../kernel/reliability/index.ts";

// The default stays strictly greater than the largest default stall-watchdog quiet bound (the
// local budget's 600s, pi-agent-core DEFAULT_STREAM_IDLE; the cloud budget's is 300s,
// DEFAULT_CLOUD_STREAM_IDLE): 660s = local quiet bound + 60s margin. Shorter explicit values
// remain supported because constrainStreamIdleToHttpTimeout clamps every watchdog phase and its
// adaptive ceiling below the nonzero undici timeout.
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
	// Settings intentionally expose an undefined field for each unset user override. A
	// spread can carry those values over the defaults before this boundary, so restore
	// the kernel defaults here instead of allowing Math.min(undefined, ...) to produce
	// a zero-delay NaN watchdog timer.
	const resolvedOptions: StreamIdleOptions = {
		...options,
		connectMs: options.connectMs ?? DEFAULT_STREAM_IDLE.connectMs,
		firstProgressMs: options.firstProgressMs ?? DEFAULT_STREAM_IDLE.firstProgressMs,
		activeIdleMs: options.activeIdleMs ?? DEFAULT_STREAM_IDLE.activeIdleMs,
		quietIdleMs: options.quietIdleMs ?? DEFAULT_STREAM_IDLE.quietIdleMs,
	};
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(httpIdleTimeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(httpIdleTimeoutMs)}`);
	}
	if (normalizedTimeoutMs === 0) {
		return { options: resolvedOptions };
	}

	const marginMs = Math.min(
		MAX_HTTP_WATCHDOG_MARGIN_MS,
		Math.max(1, Math.floor(normalizedTimeoutMs * HTTP_WATCHDOG_MARGIN_RATIO)),
	);
	const adaptiveCeilingMs = Math.max(0, normalizedTimeoutMs - marginMs);
	return {
		options: {
			...resolvedOptions,
			connectMs: Math.min(resolvedOptions.connectMs, adaptiveCeilingMs),
			firstProgressMs: Math.min(resolvedOptions.firstProgressMs, adaptiveCeilingMs),
			activeIdleMs: Math.min(resolvedOptions.activeIdleMs, adaptiveCeilingMs),
			quietIdleMs: Math.min(resolvedOptions.quietIdleMs, adaptiveCeilingMs),
		},
		adaptiveCeilingMs,
	};
}

export type HttpDispatcherRuntime = "node" | "bun";

interface OwnedHttpDispatcher {
	dispatcher: undici.EnvHttpProxyAgent;
	lifetime: "pooled" | "bun-native";
}

/** The dispatcher this module last installed, with its transport lifetime captured before installation. */
let ownedDispatcher: OwnedHttpDispatcher | undefined;
let previousDispatcher: undici.Dispatcher | undefined;
const retirements = new Set<Promise<void>>();
const retirementFailures: unknown[] = [];
/** Final process/embedding cleanup grace; settings supersession continues to retire gracefully without a deadline. */
export const HTTP_DISPOSAL_GRACE_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Globals replaced by the installed undici implementation (undici/index.js install). */
export const HTTP_INSTALL_GLOBAL_NAMES = [
	"fetch",
	"Headers",
	"Response",
	"Request",
	"FormData",
	"WebSocket",
	"CloseEvent",
	"ErrorEvent",
	"MessageEvent",
	"EventSource",
] as const;

function retireHttpDispatcher(owner: OwnedHttpDispatcher): void {
	// Handle rejection immediately, but retain the original cause for the host's cleanup boundary.
	const retirement = Promise.resolve()
		.then(() => (owner.lifetime === "pooled" ? owner.dispatcher.close() : undefined))
		.then(
			() => {
				retirements.delete(retirement);
			},
			(error: unknown) => {
				retirements.delete(retirement);
				retirementFailures.push(error);
			},
		);
	retirements.add(retirement);
}

/** Join actual graceful-close settlements and report each retained failure once. Does not retire the current pool. */
export async function awaitHttpDispatcherRetirements(): Promise<void> {
	await settleHttpDispatcherRetirements();
	const failures = retirementFailures.splice(0);
	if (failures.length > 0) throw new AggregateError(failures, "HTTP dispatcher retirement failed");
}

/** Waiting and reporting are separate: a timed-out final wait must not consume a later close rejection. */
async function settleHttpDispatcherRetirements(): Promise<void> {
	while (retirements.size > 0) await Promise.all([...retirements]);
}

/** Process/embedding shutdown: callers must first stop every session that shares this process-wide pool. */
export async function disposeHttpDispatcher(timeoutMs: number = HTTP_DISPOSAL_GRACE_MS): Promise<void> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
		throw new RangeError(
			`HTTP disposal timeout must be positive and at most ${MAX_TIMER_DELAY_MS}ms: ${String(timeoutMs)}`,
		);
	}
	const owner = ownedDispatcher;
	const dispatcher = owner?.dispatcher;
	const failures: unknown[] = [];
	if (owner && dispatcher) {
		// A caller-installed replacement owns the global now; never replace or close it.
		if (undici.getGlobalDispatcher() === dispatcher && previousDispatcher) {
			try {
				undici.setGlobalDispatcher(previousDispatcher);
			} catch (error) {
				failures.push(error);
			}
		}
		ownedDispatcher = undefined;
		previousDispatcher = undefined;
		retireHttpDispatcher(owner);
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			settleHttpDispatcherRetirements(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								`HTTP dispatcher disposal timed out after ${timeoutMs}ms; ${retirements.size} graceful close(s) remain pending`,
							),
						),
					timeoutMs,
				);
			}),
		]);
	} catch (error) {
		failures.push(error);
	} finally {
		clearTimeout(timer);
	}
	// Report causes already observed even when another close timed out. The losing settlement wait never drains later causes.
	failures.push(...retirementFailures.splice(0));
	if (failures.length > 0) throw new AggregateError(failures, "HTTP dispatcher disposal failed");
}

export function configureHttpDispatcher(
	timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS,
	runtime: HttpDispatcherRuntime = isBunRuntime ? "bun" : "node",
): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	const dispatcher = new undici.EnvHttpProxyAgent({
		allowH2: false,
		bodyTimeout: normalizedTimeoutMs,
		headersTimeout: normalizedTimeoutMs,
		// Undici 8.7 stopped tunnelling plain-HTTP origins through the proxy's CONNECT; keep
		// every origin on a tunnel as before (hand-ported from upstream 23842b1e6, #8134).
		proxyTunnel: true,
	});
	let lifetime: OwnedHttpDispatcher["lifetime"];
	if (typeof dispatcher.close === "function") {
		lifetime = "pooled";
	} else if (
		runtime === "bun" &&
		dispatcher.close === undefined &&
		dispatcher.dispatch === undefined &&
		dispatcher.destroy === undefined
	) {
		// Bun 1.4.2's built-in undici EnvHttpProxyAgent/DispatcherBase only extend EventEmitter:
		// src/js/thirdparty/undici.js has no pool, request dispatch or resource-close operation.
		// Retiring that native descriptor drops configuration ownership; it does not close Bun.fetch's
		// process transport or establish npm Undici timeout/proxy-option support on that transport.
		lifetime = "bun-native";
	} else {
		throw new Error("HTTP dispatcher has no supported resource lifetime for this runtime");
	}
	const owner: OwnedHttpDispatcher = { dispatcher, lifetime };
	const previousGlobal = undici.getGlobalDispatcher();
	const previousGlobals = HTTP_INSTALL_GLOBAL_NAMES.map((name) => ({
		name,
		descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
	}));
	try {
		undici.setGlobalDispatcher(dispatcher);
		// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
		// bundled fetch can otherwise consume compressed responses through npm undici's
		// dispatcher without decompressing them, causing response.json() failures.
		if (lifetime === "pooled") undici.install?.();
	} catch (error) {
		retireHttpDispatcher(owner);
		const failures: unknown[] = [error];
		if (undici.getGlobalDispatcher() === dispatcher) {
			try {
				undici.setGlobalDispatcher(previousGlobal);
			} catch (rollback) {
				failures.push(rollback);
			}
		}
		for (const { name, descriptor } of previousGlobals) {
			try {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else if (!Reflect.deleteProperty(globalThis, name)) throw new Error(`Cannot restore globalThis.${name}`);
			} catch (rollback) {
				failures.push(rollback);
			}
		}
		if (failures.length > 1) throw new AggregateError(failures, "HTTP dispatcher installation and rollback failed");
		throw error;
	}
	// Retire only this owner's previous binding: pooled transports finish requests and release idle
	// connections, while native descriptors release their configuration ownership without inventing a pool.
	const superseded = ownedDispatcher;
	// A caller takeover starts a new ownership interval, even if our former pool still needs retirement.
	if (previousGlobal !== superseded?.dispatcher) previousDispatcher = previousGlobal;
	ownedDispatcher = owner;
	if (superseded) retireHttpDispatcher(superseded);
}
