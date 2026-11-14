/**
 * The change watch over every bot home, so a process that does not host a bot still learns when its conversation, its
 * host's state or its history changed on disk. Every watch is on one directory, never recursive (a recursive watch is not
 * dependable on every platform and runtime): one on the bots directory, which sees homes come and go, and one on each home
 * and on its `sessions/` directory, added when they appear. A directory is watched rather than a file because an atomic
 * replace changes the file's inode, so a watch on one file would lose it. The watches are not persistent, coalesce the
 * changes of a short window into one notice, and end together on the first error (the caller falls back to reading the
 * disk each time). A change names the home directory and the file inside it; the caller maps a home directory to its bot
 * (`botHomeName` is not always the id).
 */

import { type FSWatcher, mkdirSync, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { botsDir } from "../agent-paths.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { TimerPort } from "../util/timer-port.ts";

/** How long changes gather before one notice carries them: a turn being written changes its file many times a second. */
const COALESCE_MS = 100;

/** A file that changed in a bot's home: the home's directory name and the path inside it, `/`-separated. */
export interface BotHomeChange {
	readonly home: string;
	readonly file: string;
}

/** The files of a home whose change another process cares about: the conversation, the host's state and lock, the history. */
function isObservedHomeFile(file: string): boolean {
	return file === "host-state.json" || file === "host.lock" || file === "history.json" || file.startsWith("sessions/");
}

function isDirectory(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * Starts the watch. `onChange` receives each coalesced batch; `onError` is called once if a watch fails, after which no
 * further batch comes. Returns the function that ends it.
 */
export function watchBotHomes(
	agentDir: string,
	timers: TimerPort,
	onChange: (changes: readonly BotHomeChange[]) => void,
	onError: (error: Error) => void,
): () => void {
	const dir = botsDir(agentDir);
	mkdirSync(dir, { recursive: true });
	const homes = new Map<string, { home: FSWatcher; sessions?: FSWatcher }>();
	let pending = new Map<string, BotHomeChange>();
	let flushTimer: unknown;
	let closed = false;
	let root: FSWatcher | undefined;

	const close = () => {
		closed = true;
		if (flushTimer !== undefined) timers.clearTimeout(flushTimer);
		flushTimer = undefined;
		root?.close();
		for (const watchers of homes.values()) {
			watchers.home.close();
			watchers.sessions?.close();
		}
		homes.clear();
	};
	const fail = (error: Error) => {
		if (closed) return;
		close();
		onError(error);
	};
	const flush = () => {
		flushTimer = undefined;
		if (closed) return;
		const batch = [...pending.values()];
		pending = new Map();
		if (batch.length > 0) onChange(batch);
	};
	const note = (home: string, file: string) => {
		if (closed || !isObservedHomeFile(file)) return;
		pending.set(`${home}/${file}`, { home, file });
		flushTimer ??= timers.setTimeout(flush, COALESCE_MS);
	};
	/** A watch on one directory; an error is the whole watch's, unless the directory itself is gone (`gone`). */
	const watchDir = (path: string, onName: (name: string) => void, gone: () => void): FSWatcher => {
		const watcher = watch(path, { persistent: false }, (_event, filename) => {
			if (!closed && filename !== null) onName(filename.toString());
		});
		watcher.on("error", (error) => (isDirectory(path) ? fail(error) : gone()));
		return watcher;
	};
	const dropHome = (home: string) => {
		const watchers = homes.get(home);
		homes.delete(home);
		watchers?.home.close();
		watchers?.sessions?.close();
	};
	/** Watches the home's `sessions/` once it exists; `announce` reports the files it already holds. */
	const watchSessions = (home: string, announce: boolean) => {
		const watchers = homes.get(home);
		const sessions = join(dir, home, "sessions");
		if (!watchers || watchers.sessions || !isDirectory(sessions)) return;
		watchers.sessions = watchDir(
			sessions,
			(name) => note(home, `sessions/${name}`),
			() => {
				watchers.sessions?.close();
				watchers.sessions = undefined;
			},
		);
		if (announce) for (const name of readdirSync(sessions)) note(home, `sessions/${name}`);
	};
	/**
	 * Watches a home that appeared. `announce` reports what it already holds: a home made while the watch runs can be
	 * written before its own watch exists.
	 */
	const addHome = (home: string, announce: boolean) => {
		const path = join(dir, home);
		if (closed || homes.has(home) || !isDirectory(path)) return;
		homes.set(home, {
			home: watchDir(
				path,
				(name) => {
					if (name === "sessions") watchSessions(home, true);
					note(home, name);
				},
				() => dropHome(home),
			),
		});
		if (announce) for (const name of readdirSync(path)) note(home, name);
		watchSessions(home, announce);
	};

	try {
		root = watchDir(
			dir,
			(home) => {
				if (isDirectory(join(dir, home))) addHome(home, true);
				else dropHome(home);
			},
			() => fail(new Error(interfaceText().botTeam.botHomesRemoved(dir))),
		);
		for (const entry of readdirSync(dir, { withFileTypes: true }))
			if (entry.isDirectory()) addHome(entry.name, false);
	} catch (error) {
		close();
		throw error;
	}
	return close;
}
