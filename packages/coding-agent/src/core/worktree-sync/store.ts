/**
 * Worktree-sync on-disk store: coordination state shared by EVERY process working on one repo.
 *
 * Lives under `<git-common-dir>/pi-worktree-sync/` -- all worktrees of a repository share the git
 * common dir, so the store is repo-scoped and cross-process by construction, survives `/reload`
 * and crashes, is invisible to `git status`, and needs no gitignore entry.
 *
 * The store is an INDEX, not the truth: freshness/dirtiness/progress are always re-derived from
 * git by the engine (`git-engine.ts`). A deleted or corrupt store is rebuildable via reconcile --
 * every reader here treats missing/corrupt files as "absent", never as an error.
 *
 * Writes are tmp+rename atomic (`util/atomic-file.ts`); the audit log is append-only single-line
 * JSON (O_APPEND, one line per event -- atomic enough for the small records involved). The
 * integration lock is a mkdir-atomic directory with an owner manifest: mkdir either succeeds
 * (lock acquired) or fails EEXIST (held), with takeover ONLY for a provably-dead same-host owner.
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fsPromises, realpathSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { withFileLock, writeFileAtomic } from "../util/atomic-file.ts";
import type {
	IntegrationLockAcquisition,
	IntegrationLockOwner,
	LandingTransaction,
	LaneRegistration,
	WorktreeSyncEpoch,
} from "./codes.ts";

export interface SyncStorePaths {
	root: string;
	epochFile: string;
	landingTransactionFile: string;
	lanesDir: string;
	lockDir: string;
	lockOwnerFile: string;
	lockGuardFile: string;
	lifecycleLockFile: string;
	eventsFile: string;
}

/** Grace window after which an ownerless lock dir (crash between mkdir and owner write) counts as
 * dead and may be taken over. Fresh ownerless dirs are conservatively treated as held. */
export const OWNERLESS_LOCK_STALE_MS = 30_000;

const STORE_DIR_NAME = "pi-worktree-sync";

export function syncStorePaths(gitCommonDir: string): SyncStorePaths {
	const root = join(gitCommonDir, STORE_DIR_NAME);
	return {
		root,
		epochFile: join(root, "epoch.json"),
		landingTransactionFile: join(root, "landing-transaction.json"),
		lanesDir: join(root, "lanes"),
		lockDir: join(root, "locks", "integration"),
		lockOwnerFile: join(root, "locks", "integration", "owner.json"),
		lockGuardFile: join(root, "locks", "integration-metadata"),
		lifecycleLockFile: join(root, "locks", "lifecycle"),
		eventsFile: join(root, "events.jsonl"),
	};
}

/**
 * Stable per-repo slug for the lane-worktree checkout root: sanitized repo basename plus 8 hex of
 * sha256 over the REALPATH of the git common dir -- same-named repos in different places cannot
 * collide, and every worktree of one repo resolves the same slug.
 */
export function repoSlug(repoTopLevel: string, gitCommonDir: string): string {
	let canonical = gitCommonDir;
	try {
		canonical = realpathSync(gitCommonDir);
	} catch {
		// Unresolvable (already-deleted repo during teardown): hash the raw path deterministically.
	}
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 8);
	const base = basename(repoTopLevel)
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return `${base || "repo"}-${hash}`;
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
	let raw: string;
	try {
		raw = await fsPromises.readFile(filePath, "utf-8");
	} catch {
		return undefined;
	}
	try {
		return JSON.parse(raw) as T;
	} catch {
		// Corrupt store files are treated as absent -- git remains the truth and reconcile rebuilds.
		return undefined;
	}
}

export async function readEpoch(paths: SyncStorePaths): Promise<WorktreeSyncEpoch | undefined> {
	return readJsonFile<WorktreeSyncEpoch>(paths.epochFile);
}

export async function writeEpoch(paths: SyncStorePaths, epoch: WorktreeSyncEpoch): Promise<void> {
	await writeFileAtomic(paths.epochFile, `${JSON.stringify(epoch, null, "\t")}\n`);
}

export async function readLandingTransaction(paths: SyncStorePaths): Promise<LandingTransaction | undefined> {
	const value = await readJsonFile<unknown>(paths.landingTransactionFile);
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.laneKey !== "string" ||
		typeof record.priorMainSha !== "string" ||
		typeof record.testedTipSha !== "string" ||
		!Array.isArray(record.changedPaths) ||
		!record.changedPaths.every((path) => typeof path === "string") ||
		typeof record.changedPathsTruncated !== "boolean" ||
		typeof record.lockToken !== "string" ||
		(record.gate !== "passed" && record.gate !== "off") ||
		(record.stage !== "ready_to_merge" &&
			record.stage !== "main_moved" &&
			record.stage !== "epoch_written" &&
			record.stage !== "audit_logged")
	) {
		return undefined;
	}
	return record as unknown as LandingTransaction;
}

export async function writeLandingTransaction(paths: SyncStorePaths, transaction: LandingTransaction): Promise<void> {
	await writeFileAtomic(paths.landingTransactionFile, `${JSON.stringify(transaction, null, "\t")}\n`);
}

export async function clearLandingTransaction(paths: SyncStorePaths): Promise<void> {
	try {
		await fsPromises.unlink(paths.landingTransactionFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function laneFile(paths: SyncStorePaths, laneKey: string): string {
	return join(paths.lanesDir, `${laneKey}.json`);
}

export async function readLane(paths: SyncStorePaths, laneKey: string): Promise<LaneRegistration | undefined> {
	return readJsonFile<LaneRegistration>(laneFile(paths, laneKey));
}

export async function writeLane(paths: SyncStorePaths, lane: LaneRegistration): Promise<void> {
	await writeFileAtomic(laneFile(paths, lane.laneKey), `${JSON.stringify(lane, null, "\t")}\n`);
}

export async function listLanes(paths: SyncStorePaths): Promise<LaneRegistration[]> {
	let entries: string[];
	try {
		entries = await fsPromises.readdir(paths.lanesDir);
	} catch {
		return [];
	}
	const lanes: LaneRegistration[] = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".json")) continue;
		const lane = await readJsonFile<LaneRegistration>(join(paths.lanesDir, entry));
		if (lane?.laneKey) lanes.push(lane);
	}
	return lanes;
}

/** Append one audit event as a single JSON line. `at` is stamped here so every event carries it. */
export async function appendAuditEvent(
	paths: SyncStorePaths,
	event: { event: string } & Record<string, unknown>,
	at: string,
): Promise<void> {
	await fsPromises.mkdir(dirname(paths.eventsFile), { recursive: true });
	await fsPromises.appendFile(paths.eventsFile, `${JSON.stringify({ at, ...event })}\n`, "utf-8");
}

export interface IntegrationLockDeps {
	/** Injectable liveness probe (deterministic tests). Default: same-host `process.kill(pid, 0)`. */
	isPidAlive?: (owner: IntegrationLockOwner) => boolean;
	now?: () => string;
	nowMs?: () => number;
}

/** Same-host pid liveness. A foreign-host owner is ALWAYS treated as alive -- never taken over. */
export function defaultIsPidAlive(owner: IntegrationLockOwner): boolean {
	if (owner.hostname !== osHostname()) return true;
	try {
		process.kill(owner.pid, 0);
		return true;
	} catch (err) {
		// EPERM means the pid exists but belongs to another user -- alive. Only ESRCH is dead.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readLockOwner(paths: SyncStorePaths): Promise<IntegrationLockOwner | undefined> {
	return readJsonFile<IntegrationLockOwner>(paths.lockOwnerFile);
}

async function tryMkdirLock(paths: SyncStorePaths): Promise<boolean> {
	try {
		await fsPromises.mkdir(paths.lockDir, { recursive: false });
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			// Parent `locks/` missing on first use: create it, then retry the ATOMIC non-recursive mkdir.
			await fsPromises.mkdir(dirname(paths.lockDir), { recursive: true });
			try {
				await fsPromises.mkdir(paths.lockDir, { recursive: false });
				return true;
			} catch {
				return false;
			}
		}
		return false;
	}
}

/**
 * Acquire the single integration lock (G1: landing is serialized). Non-blocking: a held lock
 * returns `{acquired:false, holder, holderAlive}` immediately -- callers surface `lock_busy` and
 * retry on their own cadence rather than spinning here. Takeover happens ONLY when the recorded
 * owner is provably dead on this host (or the lock dir is ownerless and older than
 * {@link OWNERLESS_LOCK_STALE_MS}); every takeover is audited.
 */
export async function acquireIntegrationLock(
	paths: SyncStorePaths,
	owner: Omit<IntegrationLockOwner, "acquiredAt" | "token">,
	deps: IntegrationLockDeps = {},
): Promise<IntegrationLockAcquisition> {
	return withFileLock(paths.lockGuardFile, async () => {
		const now = deps.now ?? (() => new Date().toISOString());
		const nowMs = deps.nowMs ?? (() => Date.now());
		const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
		for (let attempt = 0; attempt < 2; attempt++) {
			if (await tryMkdirLock(paths)) {
				const token = randomUUID();
				const manifest: IntegrationLockOwner = { ...owner, token, acquiredAt: now() };
				await fsPromises.writeFile(paths.lockOwnerFile, `${JSON.stringify(manifest)}\n`, "utf-8");
				await appendAuditEvent(
					paths,
					{ event: "lock_acquired", ...(attempt > 0 ? { takeover: true } : {}) },
					now(),
				);
				return { acquired: true, takeover: attempt > 0, token };
			}

			const holder = await readLockOwner(paths);
			if (holder) {
				if (isPidAlive(holder)) return { acquired: false, holder, holderAlive: true };
			} else {
				// Ownerless dir: a crash between mkdir and the owner write. Only stale ones are dead.
				let dirMtimeMs: number | undefined;
				try {
					dirMtimeMs = (await fsPromises.stat(paths.lockDir)).mtimeMs;
				} catch {
					continue;
				}
				if (nowMs() - dirMtimeMs < OWNERLESS_LOCK_STALE_MS) return { acquired: false, holderAlive: true };
			}

			// Metadata serialization makes the stale observation and directory removal one guarded
			// operation; a successor cannot be removed by a stale observer.
			await fsPromises.rm(paths.lockDir, { recursive: true, force: true });
			await appendAuditEvent(
				paths,
				{
					event: "lock_takeover",
					...(holder ? { deadOwnerPid: holder.pid, deadOwnerLaneKey: holder.laneKey } : {}),
				},
				now(),
			);
		}
		const holder = await readLockOwner(paths);
		return { acquired: false, holder, holderAlive: holder ? isPidAlive(holder) : true };
	});
}

export async function releaseIntegrationLock(
	paths: SyncStorePaths,
	token: string,
	deps: IntegrationLockDeps = {},
): Promise<boolean> {
	return withFileLock(paths.lockGuardFile, async () => {
		const now = deps.now ?? (() => new Date().toISOString());
		const holder = await readLockOwner(paths);
		if (!holder || holder.token !== token) return false;
		await fsPromises.rm(paths.lockDir, { recursive: true, force: true });
		await appendAuditEvent(paths, { event: "lock_released" }, now());
		return true;
	});
}

export async function readLockHolder(paths: SyncStorePaths): Promise<IntegrationLockOwner | undefined> {
	return readLockOwner(paths);
}
