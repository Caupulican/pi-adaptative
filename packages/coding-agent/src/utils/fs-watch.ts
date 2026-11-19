import { type FSWatcher, realpathSync, type WatchListener, watch } from "node:fs";

export const FS_WATCH_RETRY_DELAY_MS = 5000;

export function closeWatcher(watcher: FSWatcher | null | undefined): void {
	if (!watcher) {
		return;
	}

	try {
		watcher.close();
	} catch {
		// Ignore watcher close errors
	}
}

/**
 * Resolve a watch target to its canonical (long-form, symlink-free) path before handing it to
 * fs.watch. On Windows, libuv's fs-event backend hard-aborts the process
 * (`Assertion failed: !_wcsnicmp(filename, dir, dirlen), file src\win\fs-event.c, line 72`) when
 * the watched directory is referenced via a non-canonical alias -- most commonly an 8.3 short
 * path (e.g. `C:\Users\RUNNER~1\...`) -- because ReadDirectoryChangesW resolves events against the
 * long-form name and libuv's internal prefix comparison then mismatches. Windows callers handle
 * a failed resolution through their normal watcher-start failure path.
 */
export function canonicalizeWatchDir(path: string): string {
	try {
		return realpathSync.native(path);
	} catch (error) {
		if (process.platform === "win32") throw error;
		return path;
	}
}

/** Open a native watcher with a canonical target while leaving its lifetime to the caller. */
export function watchPath(
	path: string,
	options: { persistent?: boolean; recursive?: boolean },
	listener: WatchListener<string>,
): FSWatcher {
	return watch(canonicalizeWatchDir(path), options, listener);
}

export function watchWithErrorHandler(
	path: string,
	listener: WatchListener<string>,
	onError: () => void,
): FSWatcher | null {
	try {
		const watcher = watchPath(path, {}, listener);
		watcher.on("error", onError);
		return watcher;
	} catch {
		onError();
		return null;
	}
}
