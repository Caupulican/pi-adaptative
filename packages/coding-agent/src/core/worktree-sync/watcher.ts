/**
 * Epoch watcher for lane-bound sessions: the prompt-awareness half of "perfect sync". Watches
 * the shared `epoch.json` (fs.watch on its directory -- the file is replaced by rename) and, on
 * an epoch advance by ANOTHER lane, injects one deterministic staleness notice through the host's
 * message seam. Enforcement never rides on this watcher -- the lane gate (G8) and the land CAS
 * (G3) fail closed even if it dies; this only makes lanes learn promptly instead of at their
 * next tool call.
 */

import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { watchWithErrorHandler } from "../../utils/fs-watch.ts";
import type { WorktreeSyncEpoch } from "./codes.ts";

export interface EpochWatcherConfig {
	epochFile: string;
	/** The lane this session is bound to: lands BY this lane never notify it. */
	laneKey: string;
	notify: (text: string) => void;
	/** Debounce for rename/change event bursts. */
	debounceMs?: number;
}

export interface EpochWatcherHandle {
	stop(): void;
}

async function readEpochFile(epochFile: string): Promise<WorktreeSyncEpoch | undefined> {
	try {
		return JSON.parse(await readFile(epochFile, "utf-8")) as WorktreeSyncEpoch;
	} catch {
		return undefined;
	}
}

/** Deterministic notice text -- assembled from epoch facts, never model-generated. */
export function formatEpochNotice(epoch: WorktreeSyncEpoch, laneKey: string): string {
	const changed =
		epoch.changedPaths.length > 0
			? `${epoch.changedPaths.slice(0, 10).join(", ")}${epoch.changedPaths.length > 10 || epoch.changedPathsTruncated ? ", ..." : ""}`
			: "(no files listed)";
	return [
		`worktree-sync: main advanced to epoch ${epoch.epoch}`,
		`${epoch.landedLaneKey ? ` (landed by lane '${epoch.landedLaneKey}')` : ""}.`,
		` Changed: ${changed}.`,
		` Your lane '${laneKey}' must rebase main before further mutations/landing:`,
		` call worktree_sync {"action":"sync"} now, resolve any conflicts locally, then continue working.`,
	].join("");
}

/**
 * Start watching. The initial epoch is read once as the baseline; only ADVANCES past it notify
 * (a fresh session never gets a notice for history). fs.watch is backed by a low-frequency
 * poll re-read on each event burst only -- no timers run while the store is quiet.
 */
export function startEpochWatcher(config: EpochWatcherConfig): EpochWatcherHandle {
	const debounceMs = config.debounceMs ?? 250;
	let lastSeenEpoch: number | undefined;
	let debounceTimer: NodeJS.Timeout | undefined;
	let stopped = false;

	const evaluate = async (): Promise<void> => {
		if (stopped) return;
		const epoch = await readEpochFile(config.epochFile);
		if (!epoch) return;
		if (lastSeenEpoch === undefined) {
			lastSeenEpoch = epoch.epoch;
			return;
		}
		if (epoch.epoch <= lastSeenEpoch) return;
		lastSeenEpoch = epoch.epoch;
		if (epoch.landedLaneKey === config.laneKey) return;
		config.notify(formatEpochNotice(epoch, config.laneKey));
	};

	// Baseline read; any event after this compares against it.
	void evaluate();

	const fileName = basename(config.epochFile);
	// watchWithErrorHandler canonicalizes the watched dir (realpathSync.native) before calling
	// fs.watch -- on Windows, a non-canonical (e.g. 8.3 short-form) path here hard-aborts the
	// process via libuv's fs-event assertion. It also attaches an 'error' listener so an async
	// watcher failure (EMFILE, dir removed, etc.) can never surface as an unhandled exception.
	const watcher = watchWithErrorHandler(
		dirname(config.epochFile),
		(_eventType, changedName) => {
			if (stopped) return;
			if (changedName !== null && changedName !== fileName && changedName !== `${fileName}.tmp`) return;
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				void evaluate();
			}, debounceMs);
			debounceTimer.unref?.();
		},
		() => {
			// The store dir may not exist yet, or the watcher died after creation (EMFILE, dir
			// removed, etc). The lane gate (G8) and land CAS (G3) still fail closed at the next
			// tool call regardless -- this watcher is a promptness optimization only, so on error
			// we simply stop watching rather than retry; correctness never depended on it.
		},
	);

	return {
		stop() {
			stopped = true;
			if (debounceTimer) clearTimeout(debounceTimer);
			watcher?.close();
		},
	};
}
