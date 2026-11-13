/**
 * One change watch over every bot home, so a process that does not host a bot still learns when its conversation, its
 * host's state or its history changed on disk. The watch is on the directory tree (an atomic replace changes the file's
 * inode, so a watch on one file would lose it), not persistent, coalesces a burst into one notice, and ends on its first
 * error (the caller falls back to reading the disk each time). It names the home directory and the file inside it; the
 * caller maps a home directory to its bot (`botHomeName` is not always the id).
 */

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { sep } from "node:path";
import { botsDir } from "../agent-paths.ts";

/** A file that changed in a bot's home: the home's directory name and the path inside it, `/`-separated. */
export interface BotHomeChange {
	readonly home: string;
	readonly file: string;
}

/** The files of a home whose change another process cares about: the conversation, the host's state and lock, the history. */
function isObservedHomeFile(file: string): boolean {
	return file === "host-state.json" || file === "host.lock" || file === "history.json" || file.startsWith("sessions/");
}

/**
 * Starts the watch. `onChange` receives each coalesced batch; `onError` is called once if the watch fails, after which no
 * further batch comes. Returns the function that ends it.
 */
export function watchBotHomes(
	agentDir: string,
	onChange: (changes: readonly BotHomeChange[]) => void,
	onError: (error: Error) => void,
): () => void {
	const dir = botsDir(agentDir);
	mkdirSync(dir, { recursive: true });
	let pending = new Map<string, BotHomeChange>();
	let closed = false;
	const flush = () => {
		if (closed) return;
		const batch = [...pending.values()];
		pending = new Map();
		if (batch.length > 0) onChange(batch);
	};
	const watcher: FSWatcher = watch(dir, { persistent: false, recursive: true }, (_event, filename) => {
		if (closed || filename === null) return;
		const parts = filename.toString().split(sep);
		const home = parts[0];
		const file = parts.slice(1).join("/");
		if (!home || !isObservedHomeFile(file)) return;
		const first = pending.size === 0;
		pending.set(`${home}/${file}`, { home, file });
		if (first) queueMicrotask(flush);
	});
	watcher.on("error", (error) => {
		if (closed) return;
		closed = true;
		watcher.close();
		onError(error);
	});
	return () => {
		closed = true;
		watcher.close();
	};
}
