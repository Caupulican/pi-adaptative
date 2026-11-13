/**
 * Who hosts the link for one agent directory: `remote/host.lock` names the one session that listens as the hub. Other
 * root sessions on the same directory do not bind the port; they read the hosting session's records. A lock is
 * replaced only when its owner is proven gone on this host ({@link judgeOwner} `dead`): a live owner, an owner on
 * another host and an owner that cannot be judged all keep it. Nothing polls: a session that does not host watches the
 * directory and tries again when the lock file goes away. The same mechanism names the one session that runs the jobs
 * peers place here (`remote/jobs/runner.lock`, {@link RUNNER_LOCK}), and the one process that hosts a bot's own session
 * (`bots/<id>/host.lock`, through {@link takeProcessLock}).
 */

import { randomBytes } from "node:crypto";
import { existsSync, type FSWatcher, mkdirSync, readFileSync, rmSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import {
	isProcessOwnerRecord,
	judgeOwner,
	type OwnerStanding,
	ownProcessOwner,
	type ProcessOwner,
} from "../../kernel/reliability/owner-identity.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

const LOCK_FILE = "host.lock";
/** The lock of the session that runs placed jobs, relative to `remote/`. */
export const RUNNER_LOCK = "jobs/runner.lock";

/** The hosting session's process (its `machineId` is the OS machine digest, not the link's install id) and its token. */
interface HostLockRecord extends ProcessOwner {
	readonly token: string;
	readonly acquiredAt: string;
}

/** The session that hosts the link, as another session describes it. */
export interface LinkHostOwner {
	readonly pid: number;
	readonly standing: OwnerStanding;
}

export type HostLockResult =
	| { readonly held: true; readonly lock: HostLock }
	| { readonly held: false; readonly owner: LinkHostOwner };

const lockPath = (agentDir: string, name: string): string => join(agentDir, "remote", name);

function readRecord(path: string): HostLockRecord | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isPlainRecord(value) &&
			isProcessOwnerRecord(value) &&
			typeof value.token === "string" &&
			typeof value.acquiredAt === "string"
			? { ...value, token: value.token, acquiredAt: value.acquiredAt }
			: undefined;
	} catch {
		return undefined;
	}
}

/** This session's hold on the link host; `release` gives it up only while the file still names this hold. */
export class HostLock {
	private readonly path: string;
	private readonly token: string;
	private released = false;

	constructor(path: string, token: string) {
		this.path = path;
		this.token = token;
	}

	/** Whether the file still names this hold (another session may have reclaimed it after this process was judged gone). */
	stillHeld(): boolean {
		return !this.released && readRecord(this.path)?.token === this.token;
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		try {
			withFileLockSync(this.path, () => {
				if (readRecord(this.path)?.token === this.token) rmSync(this.path, { force: true });
			});
		} catch (error) {
			harnessLog.warn("link", "a host lock could not be released", {
				reason: error instanceof Error ? error.name : "unknown",
			});
		}
	}
}

/**
 * Takes the link host for this agent directory, or names the session holding it. The record is published whole (an
 * atomic replace under the file's lock), so a lock file that names no readable owner was never a session's hold and
 * is replaced.
 */
export function takeHostLock(agentDir: string, name = LOCK_FILE): HostLockResult {
	return takeProcessLock(lockPath(agentDir, name));
}

/** The same hold on any lock file: one live process names it, and a record whose process is gone is replaced. */
export function takeProcessLock(path: string): HostLockResult {
	mkdirSync(dirname(path), { recursive: true });
	return withFileLockSync(path, (): HostLockResult => {
		const current = readRecord(path);
		if (current) {
			const standing = judgeOwner(current);
			if (standing !== "dead") return { held: false, owner: { pid: current.pid, standing } };
			harnessLog.info("link", "a host lock whose process is gone was replaced", { pid: current.pid });
		}
		const record: HostLockRecord = {
			...ownProcessOwner(),
			token: randomBytes(16).toString("hex"),
			acquiredAt: new Date().toISOString(),
		};
		writeFileAtomicSync(path, `${JSON.stringify(record, null, 1)}\n`, { mode: 0o600 });
		return { held: true, lock: new HostLock(path, record.token) };
	});
}

/** The process holding a lock file and how it stands, as another process reads it; undefined when no live holder is named. */
export function processLockHolder(
	path: string,
): { readonly owner: ProcessOwner; readonly standing: OwnerStanding } | undefined {
	const record = readRecord(path);
	if (!record) return undefined;
	const standing = judgeOwner(record);
	return standing === "dead" ? undefined : { owner: record, standing };
}

/** The session hosting the link here, when one other than this process holds the lock. */
export function linkHostOwner(agentDir: string, name = LOCK_FILE): LinkHostOwner | undefined {
	const record = readRecord(lockPath(agentDir, name));
	if (!record || record.pid === process.pid) return undefined;
	const standing = judgeOwner(record);
	return standing === "dead" ? undefined : { pid: record.pid, standing };
}

/**
 * Calls `onReleased` each time the lock file disappears (the hosting session stopped or closed), until the returned
 * function is called. A host that ends without removing its lock fires nothing; the next session to start judges it.
 */
export function watchHostLockRelease(agentDir: string, onReleased: () => void, name = LOCK_FILE): () => void {
	const path = lockPath(agentDir, name);
	const dir = dirname(path);
	const file = basename(path);
	mkdirSync(dir, { recursive: true });
	let watcher: FSWatcher | undefined;
	try {
		watcher = watch(dir, { persistent: false }, (_event, filename) => {
			if ((filename === null || filename.toString() === file) && !existsSync(path)) onReleased();
		});
		watcher.on("error", () => {
			watcher?.close();
			watcher = undefined;
		});
	} catch (error) {
		harnessLog.warn("link", "the link host lock cannot be watched; this session takes the hub at its next start", {
			reason: error instanceof Error ? error.name : "unknown",
		});
	}
	return () => {
		watcher?.close();
		watcher = undefined;
	};
}
