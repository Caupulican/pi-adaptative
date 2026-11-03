/**
 * The detached bot daemon: queues due persistent routines across TUI restarts.
 *
 * A session claims the daemon lease with a fresh token, then launches `pi --bot-daemon <agentDir> <token>` through
 * the stable self-launch target. The daemon renews that lease while it is still its own and stops as soon as it is
 * not: released by `/bot daemon stop`, or claimed by a later start after this daemon's lease went stale. Ownership
 * changes are observed through a watch on the lease directory, and the renewal tick rechecks them.
 *
 * A lock held by another process through every bounded retry (`ELOCKED`) skips one tick: renewal recurs well inside
 * the lease's stale window and due routines stay due. Any other failure ends the process, and its unrenewed lease
 * goes stale, so status never reports a daemon that cannot work.
 */
import { type FSWatcher, watch } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { daemonLeasePath, isDaemonLeaseToken } from "./bot-team-routine-helpers.ts";
import { PersistentBotTeamStore } from "./persistent-bot-team-store.ts";

const DAEMON_TICK_MS = 10_000;

function isLockContention(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ELOCKED";
}

/** Runs the daemon for `pi --bot-daemon <agentDir> <token>`; resolves with the process exit code once it stops. */
export function runBotDaemonCommand(args: readonly string[]): Promise<number> {
	const [agentDir, token] = args;
	if (args.length !== 2 || !agentDir || !isAbsolute(agentDir) || !token || !isDaemonLeaseToken(token))
		return Promise.resolve(2);
	const store = new PersistentBotTeamStore(agentDir);
	const leaseFile = daemonLeasePath(store.getStoreFilePath());
	return new Promise((resolve) => {
		let stopped = false;
		let timer: ReturnType<typeof setInterval> | undefined;
		let watcher: FSWatcher | undefined;
		const stop = (): void => {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
			watcher?.close();
			try {
				store.releaseDaemonLease(token);
			} catch (error) {
				// A contended lease lock: the unrenewed lease goes stale on its own.
				if (!isLockContention(error)) throw error;
			}
			resolve(0);
		};
		const tick = (): void => {
			if (stopped) return;
			const now = Date.now();
			try {
				if (!store.renewDaemonLease(token, process.pid, now)) {
					stop();
					return;
				}
				store.queueDueRoutinesForDaemon(now);
			} catch (error) {
				if (!isLockContention(error)) throw error;
			}
		};
		timer = setInterval(tick, DAEMON_TICK_MS);
		watcher = watch(dirname(leaseFile), { persistent: false }, (_event, filename) => {
			if (filename !== null && filename.toString() !== basename(leaseFile)) return;
			if (!store.daemonLeaseBelongsTo(token)) stop();
		});
		// A watch that fails later leaves the renewal tick, which observes a release within one interval.
		watcher.on("error", () => {
			watcher?.close();
			watcher = undefined;
		});
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		tick();
	});
}
