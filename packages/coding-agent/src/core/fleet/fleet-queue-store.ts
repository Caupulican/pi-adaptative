/**
 * The fleet's restart metadata: per queued node its flow, base priority, first enqueue time, last wait reason and reopen
 * time, plus whether the session's fleet was stopped. The orchestration ledger stays the owner of which attempts exist
 * and are queued; this file carries only what the ledger does not (ordering and the stop), so a restart re-enqueues the
 * ledger's queued attempts with their aging intact and keeps a stopped fleet stopped. One file per session under its
 * orchestration home's state directory, `<stateDir>/fleet/queue/<sessionId>.json` (the owner's `<agentDir>/state`), and
 * one for its away controller, `<sessionId>@away.json`; bounded, written atomically and at most once per microtask; an
 * empty, running fleet removes it. Entries no recovered attempt claims are dropped by the first write. An earlier build
 * named the away controller's file `<sessionId>.away.json`, the name a session whose id is `<sessionId>.away` keeps as its
 * own; its content (the stop and the entries) names neither, so whose it is is told by whether the home holds that
 * session's orchestration state ({@link earlierAwayFleetQueueMetadataFile}), and the away controller adopts it
 * ({@link openFleetQueueStore}) when it is the controller's.
 */

import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { orchestrationHomeHoldsSession } from "../../kernel/session/session-bundle-lifecycle.ts";
import type { OrchestrationHome } from "../../kernel/session/session-bundle-paths.ts";
import { isValidSessionId } from "../../kernel/session/session-identity.ts";
import { retryTransientWin32Sync } from "../../kernel/storage/win32-transient-fs.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import type { FleetPriority } from "./fleet-types.ts";

/** Far above any ready window the ceilings allow; a file past it is truncated to the oldest entries. */
export const MAX_PERSISTED_FLEET_QUEUE_ENTRIES = 4096;

export interface FleetQueueMetadataEntry {
	readonly id: string;
	readonly objectiveId: string;
	readonly subtreeId: string;
	readonly priority: FleetPriority;
	readonly enqueuedAt: number;
	readonly lastReason?: string;
	readonly retryAt?: number;
}

export interface FleetQueueMetadata {
	readonly v: 1;
	readonly stopped: boolean;
	readonly entries: readonly FleetQueueMetadataEntry[];
}

const AWAY_SUFFIX = "@away";

/**
 * The metadata file of the fleet queue `key` in `home`, named by the key itself: a session id (`isValidSessionId`), or
 * its away controller's key ({@link awayFleetQueueKey}), which no session id can be, so no two keys share a file. Any
 * other key throws.
 */
export function fleetQueueMetadataPath(home: OrchestrationHome, key: string): string {
	const sessionId = key.endsWith(AWAY_SUFFIX) ? key.slice(0, -AWAY_SUFFIX.length) : key;
	if (!isValidSessionId(sessionId)) throw new Error(`Fleet queue key ${JSON.stringify(key)} names no session.`);
	return join(home.stateDir, "fleet", "queue", `${key}.json`);
}

/** The fleet queue key of the worker controller a session's parent runs away (`away-parent-context.ts`), beside its own. */
export function awayFleetQueueKey(sessionId: string): string {
	return `${sessionId}${AWAY_SUFFIX}`;
}

/** Every fleet queue metadata file of session `sessionId` in `home`: its own and its away controller's. */
export function sessionFleetQueueMetadataPaths(home: OrchestrationHome, sessionId: string): readonly string[] {
	return [fleetQueueMetadataPath(home, sessionId), fleetQueueMetadataPath(home, awayFleetQueueKey(sessionId))];
}

/** The name an earlier build gave session `sessionId`'s away controller's metadata in `home`, whoever's it is. */
export function earlierAwayFleetQueueMetadataPath(home: OrchestrationHome, sessionId: string): string {
	return join(home.stateDir, "fleet", "queue", `${sessionId}.away.json`);
}

/**
 * The file an earlier build kept session `sessionId`'s away controller's metadata in
 * ({@link earlierAwayFleetQueueMetadataPath}) when it is that controller's: it exists and `home` holds no orchestration
 * state of the session whose id is `<sessionId>.away`, whose own file the same name is (its bundle directory, tombstone
 * or lease registry: `orchestrationHomeHoldsSession`); undefined otherwise. A fleet queue file of key
 * `<sessionId>.away` is written only by that session's fleet scheduler, which runs inside its orchestration bundle in
 * the same home, so a live or retained session of that id always leaves that state there. The away controller adopts
 * the file, the retention that removes the session's bundle removes it, and the bot bundle move carries it, each by this
 * rule.
 */
export function earlierAwayFleetQueueMetadataFile(home: OrchestrationHome, sessionId: string): string | undefined {
	const path = earlierAwayFleetQueueMetadataPath(home, sessionId);
	if (!existsSync(path)) return undefined;
	return orchestrationHomeHoldsSession(home, `${sessionId}.away`) ? undefined : path;
}

/**
 * The store of fleet queue `key` in `home`. An away controller's store first settles the file an earlier build left
 * ({@link earlierAwayFleetQueueMetadataFile}) under its own file's lock, the rule checked again inside it: with no file
 * of its own it adopts that one by one rename (retried while Windows holds the file a moment), so a fleet stopped before
 * the upgrade stays stopped; with one, which is the file it loads, it removes the earlier one, logged. A rename that
 * fails is thrown: the stop it carries is not dropped.
 */
export function openFleetQueueStore(home: OrchestrationHome, key: string): FleetQueueStore {
	const path = fleetQueueMetadataPath(home, key);
	const sessionId = key.endsWith(AWAY_SUFFIX) ? key.slice(0, -AWAY_SUFFIX.length) : undefined;
	if (sessionId !== undefined && earlierAwayFleetQueueMetadataFile(home, sessionId) !== undefined)
		withFileLockSync(path, () => {
			const earlier = earlierAwayFleetQueueMetadataFile(home, sessionId);
			if (earlier === undefined) return;
			if (!existsSync(path)) {
				retryTransientWin32Sync(() => renameSync(earlier, path));
				return;
			}
			rmSync(earlier, { force: true });
			harnessLog.info("fleet", "the earlier away fleet queue file was removed: the away controller's own is loaded");
		});
	return new FleetQueueStore(path);
}

export class FleetQueueStore {
	private readonly path: string;
	private pending: (() => FleetQueueMetadata) | undefined;
	private closed = false;

	constructor(path: string) {
		this.path = path;
	}

	/** The metadata a previous process of this session left; undefined when there is none or it does not parse. */
	load(): FleetQueueMetadata | undefined {
		if (!existsSync(this.path)) return undefined;
		try {
			return parseFleetQueueMetadata(JSON.parse(readFileSync(this.path, "utf8")));
		} catch {
			harnessLog.warn("fleet", "the fleet queue metadata did not parse; it is dropped");
			return undefined;
		}
	}

	/** Writes the latest metadata once the current synchronous work ends; repeated calls in one microtask write once. */
	schedule(read: () => FleetQueueMetadata): void {
		if (this.closed) return;
		const first = this.pending === undefined;
		this.pending = read;
		if (first) queueMicrotask(() => this.flush());
	}

	/** Writes any scheduled metadata now and stops further writes. */
	close(): void {
		this.flush();
		this.closed = true;
	}

	private flush(): void {
		const read = this.pending;
		this.pending = undefined;
		if (!read || this.closed) return;
		try {
			const metadata = read();
			if (!metadata.stopped && metadata.entries.length === 0) {
				rmSync(this.path, { force: true });
				return;
			}
			const bounded =
				metadata.entries.length > MAX_PERSISTED_FLEET_QUEUE_ENTRIES
					? { ...metadata, entries: metadata.entries.slice(0, MAX_PERSISTED_FLEET_QUEUE_ENTRIES) }
					: metadata;
			writeFileAtomicSync(this.path, `${JSON.stringify(bounded)}\n`, { mode: 0o600 });
		} catch (error) {
			harnessLog.warn("fleet", "the fleet queue metadata write failed", () => ({
				error: error instanceof Error ? error.name : "unknown",
			}));
		}
	}
}

function parseFleetQueueMetadata(value: unknown): FleetQueueMetadata | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (record.v !== 1 || !Array.isArray(record.entries)) return undefined;
	const entries: FleetQueueMetadataEntry[] = [];
	for (const raw of record.entries.slice(0, MAX_PERSISTED_FLEET_QUEUE_ENTRIES)) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw as Record<string, unknown>;
		if (
			typeof entry.id !== "string" ||
			typeof entry.objectiveId !== "string" ||
			typeof entry.subtreeId !== "string" ||
			(entry.priority !== 0 && entry.priority !== 1 && entry.priority !== 2 && entry.priority !== 3) ||
			typeof entry.enqueuedAt !== "number" ||
			!Number.isFinite(entry.enqueuedAt)
		)
			continue;
		entries.push({
			id: entry.id,
			objectiveId: entry.objectiveId,
			subtreeId: entry.subtreeId,
			priority: entry.priority,
			enqueuedAt: entry.enqueuedAt,
			...(typeof entry.lastReason === "string" ? { lastReason: entry.lastReason } : {}),
			...(typeof entry.retryAt === "number" && Number.isFinite(entry.retryAt) ? { retryAt: entry.retryAt } : {}),
		});
	}
	return { v: 1, stopped: record.stopped === true, entries };
}
