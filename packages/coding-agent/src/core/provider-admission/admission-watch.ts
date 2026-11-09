/**
 * The cross-process half of the provider admission signals. The ledger's holds, the recorded limits and the emergency
 * stop are files every pi process on one agent directory shares; their `KeyedSignal`s carry only this process's own
 * changes. A directory watch, held while anyone in this process listens, turns another process's change into the same
 * in-process notification, so a waiter never re-reads on a timer to discover it.
 *
 * Each watch is one per directory per process, reference-counted by its listeners and closed with the last of them. An
 * event is coalesced to one read per microtask and compared with the last digest of every relevant entry: a heartbeat
 * rewrite that changes nothing a reader cares about, or an event for an unrelated name, wakes no one (digest
 * suppression). A restart of the watch bumps its generation, so a late event from a closed watcher is ignored. A watch
 * that cannot start or fails leaves its readers on their own bounded rechecks; it never fails the subscription.
 *
 * These are rechecks of shared resource facts (a slot, a limit, a stop), not completion detection.
 */

import { type FSWatcher, mkdirSync, watch } from "node:fs";
import { harnessLog } from "../../kernel/harness-log.ts";
import { canonicalizeWatchDir } from "../../utils/fs-watch.ts";

/** What one watched directory reads and reports. */
export interface DirectoryWatchSpec {
	/** The directory watched (not recursively); created when missing. */
	readonly dir: string;
	/** Whether an event naming `name` can change what `read` returns; an event with no name always reads. */
	relevant(name: string): boolean;
	/** The digest of every relevant entry now: entry name to a string that changes when its meaning changes. */
	read(): ReadonlyMap<string, string>;
	/** Entries whose digest changed, appeared or disappeared since the last read. */
	changed(names: readonly string[], removed: readonly string[]): void;
}

interface ActiveWatch {
	readonly spec: DirectoryWatchSpec;
	references: number;
	generation: number;
	watcher: FSWatcher | undefined;
	digest: ReadonlyMap<string, string>;
	queued: boolean;
}

const watches = new Map<string, ActiveWatch>();

/**
 * Holds the watch named `key` (one per watched resource kind and directory) until the returned release; the first holder
 * builds the spec and starts the watch.
 */
export function retainDirectoryWatch(key: string, spec: () => DirectoryWatchSpec): () => void {
	let active = watches.get(key);
	if (!active) {
		const built = spec();
		active = { spec: built, references: 0, generation: 0, watcher: undefined, digest: new Map(), queued: false };
		watches.set(key, active);
		start(key, active);
	}
	active.references += 1;
	const held = active;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		held.references -= 1;
		if (held.references > 0 || watches.get(key) !== held) return;
		watches.delete(key);
		held.generation += 1;
		held.watcher?.close();
		held.watcher = undefined;
	};
}

function start(key: string, active: ActiveWatch): void {
	const generation = ++active.generation;
	try {
		mkdirSync(active.spec.dir, { recursive: true });
		active.digest = active.spec.read();
		active.watcher = watch(canonicalizeWatchDir(active.spec.dir), { persistent: false }, (_event, filename) => {
			if (generation !== active.generation) return;
			const name = filename === null ? undefined : filename.toString();
			if (name === undefined || active.spec.relevant(name)) schedule(active, generation);
		});
		active.watcher.on("error", (error) => {
			if (generation !== active.generation) return;
			active.generation += 1;
			active.watcher?.close();
			active.watcher = undefined;
			harnessLog.warn("provider", "a provider admission watch stopped; its readers keep their rechecks", () => ({
				key,
				error: error.name,
			}));
		});
	} catch (error) {
		active.watcher = undefined;
		harnessLog.warn(
			"provider",
			"a provider admission watch could not start; its readers keep their rechecks",
			() => ({
				key,
				error: error instanceof Error ? error.name : typeof error,
			}),
		);
	}
}

function schedule(active: ActiveWatch, generation: number): void {
	if (active.queued) return;
	active.queued = true;
	queueMicrotask(() => {
		active.queued = false;
		if (generation !== active.generation) return;
		let next: ReadonlyMap<string, string>;
		try {
			next = active.spec.read();
		} catch {
			return;
		}
		const changed: string[] = [];
		const removed: string[] = [];
		for (const [name, digest] of next) if (active.digest.get(name) !== digest) changed.push(name);
		for (const name of active.digest.keys()) if (!next.has(name)) removed.push(name);
		active.digest = next;
		if (changed.length > 0 || removed.length > 0) active.spec.changed(changed, removed);
	});
}
