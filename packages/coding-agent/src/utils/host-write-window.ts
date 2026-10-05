/**
 * Windows in which the harness itself writes under a directory it owns (managed tool provisioning into the
 * agent `bin`). The protected-path watch fingerprints that directory around a worker's commands; a change
 * made by the host during the same interval is not evidence about the worker, so the watch asks here before it
 * attributes one. Only the interval and the root are recorded: a change by anything else outside the window,
 * or outside the root, is still seen.
 */

import path from "node:path";

interface HostWriteWindow {
	readonly root: string;
	readonly startedAt: number;
	endedAt: number | undefined;
}

/** Ended windows kept for comparison with a run's baseline; the oldest ended one is dropped past the bound. */
const MAX_ENDED_WINDOWS = 64;
const windows: HostWriteWindow[] = [];

function begin(root: string): HostWriteWindow {
	const window: HostWriteWindow = { root: path.resolve(root), startedAt: Date.now(), endedAt: undefined };
	windows.push(window);
	return window;
}

function end(window: HostWriteWindow): void {
	window.endedAt = Date.now();
	const ended = windows.filter((entry) => entry.endedAt !== undefined);
	if (ended.length > MAX_ENDED_WINDOWS) windows.splice(windows.indexOf(ended[0]), 1);
}

/** Run a synchronous host write under `root`, recording the interval. */
export function withHostWrite<T>(root: string, write: () => T): T {
	const window = begin(root);
	try {
		return write();
	} finally {
		end(window);
	}
}

/** Run an asynchronous host write under `root`, recording the interval. */
export async function withHostWriteAsync<T>(root: string, write: () => Promise<T>): Promise<T> {
	const window = begin(root);
	try {
		return await write();
	} finally {
		end(window);
	}
}

/** Whether the host wrote under a root containing `target` at any moment of `[fromMs, toMs]`. */
export function hostWroteDuring(target: string, fromMs: number, toMs: number): boolean {
	const resolved = path.resolve(target);
	return windows.some(
		(window) =>
			(resolved === window.root || resolved.startsWith(window.root + path.sep)) &&
			window.startedAt <= toMs &&
			(window.endedAt === undefined || window.endedAt >= fromMs),
	);
}
