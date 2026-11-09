/**
 * A watch over job store directories: one callback per burst of record changes, from any process writing them. A
 * record rewrite lands as several file events (the temporary file, the rename, the lock), so they settle for a moment
 * and are handled once. Event-driven only; a directory that cannot be watched is reported, never polled.
 */

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { harnessLog } from "../../kernel/harness-log.ts";

const SETTLE_MS = 150;

export class DirectoryWatch {
	private readonly dirs: readonly string[];
	private readonly onChange: () => void;
	private watchers: FSWatcher[] = [];
	private settle: ReturnType<typeof setTimeout> | undefined;

	constructor(dirs: readonly string[], onChange: () => void) {
		this.dirs = dirs;
		this.onChange = onChange;
	}

	get active(): boolean {
		return this.watchers.length > 0;
	}

	start(): void {
		if (this.active) return;
		for (const dir of this.dirs) {
			try {
				mkdirSync(dir, { recursive: true });
				const watcher = watch(dir, { persistent: false }, (_event, filename) => {
					const name = filename?.toString();
					if (name === undefined || name.endsWith(".json")) this.changed();
				});
				watcher.on("error", () => watcher.close());
				this.watchers.push(watcher);
			} catch (error) {
				harnessLog.warn("link", "a job store cannot be watched; its waiting work moves at the next connection", {
					reason: error instanceof Error ? error.name : "unknown",
				});
			}
		}
	}

	stop(): void {
		for (const watcher of this.watchers) watcher.close();
		this.watchers = [];
		if (this.settle) clearTimeout(this.settle);
		this.settle = undefined;
	}

	private changed(): void {
		if (this.settle) return;
		this.settle = setTimeout(() => {
			this.settle = undefined;
			this.onChange();
		}, SETTLE_MS);
		this.settle.unref?.();
	}
}
