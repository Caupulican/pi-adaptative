/**
 * A watch on the channel journal directory. Every journal write replaces `<name>.json` (`ChannelJournal.update`), so one
 * event tells that some session changed a journal: who serves a channel, a draft a host wrote, a notice left for the
 * owner. The watch is open only while its owner wants it, and it never keeps the process alive.
 */

import { type FSWatcher, watch } from "node:fs";

export interface JournalDirWatchDeps {
	/** The directory the journals are in. */
	dir(): string;
	/** A journal of the directory changed. */
	onChange(): void;
	/** The watch could not be opened: told once per reason until it opens. */
	onFailure(reason: string): void;
}

export class JournalDirWatch {
	private readonly deps: JournalDirWatchDeps;
	private watcher: FSWatcher | undefined;
	private failure: string | undefined;

	constructor(deps: JournalDirWatchDeps) {
		this.deps = deps;
	}

	/** Open the watch while `wanted` and close it otherwise. A watch that failed after it opened is opened again here. */
	sync(wanted: boolean): void {
		if (!wanted) {
			this.watcher?.close();
			this.watcher = undefined;
			return;
		}
		if (this.watcher) return;
		try {
			const watcher = watch(this.deps.dir(), { persistent: false }, (_event, filename) => {
				// A journal is replaced by a rename onto `<name>.json`; its lock and temporary files change nothing.
				if (this.watcher !== watcher || (filename !== null && !String(filename).endsWith(".json"))) return;
				this.deps.onChange();
			});
			watcher.on("error", () => {
				if (this.watcher !== watcher) return;
				watcher.close();
				this.watcher = undefined;
			});
			this.watcher = watcher;
			this.failure = undefined;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (this.failure === reason) return;
			this.failure = reason;
			this.deps.onFailure(reason);
		}
	}
}
