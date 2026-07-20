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
 * long-form name and libuv's internal prefix comparison then mismatches. `realpathSync.native`
 * fails closed to the original path (directory not created yet, permissions, etc.) rather than
 * throwing, since a best-effort watch on the given path is strictly better than none.
 */
export function canonicalizeWatchDir(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

export function watchWithErrorHandler(
	path: string,
	listener: WatchListener<string>,
	onError: () => void,
): FSWatcher | null {
	try {
		const watcher = watch(canonicalizeWatchDir(path), listener);
		watcher.on("error", onError);
		return watcher;
	} catch {
		onError();
		return null;
	}
}
