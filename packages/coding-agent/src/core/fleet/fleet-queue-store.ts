/**
 * The fleet's restart metadata: per queued node its flow, base priority, first enqueue time, last wait reason and reopen
 * time, plus whether the session's fleet was stopped. The orchestration ledger stays the owner of which attempts exist
 * and are queued; this file carries only what the ledger does not (ordering and the stop), so a restart re-enqueues the
 * ledger's queued attempts with their aging intact and keeps a stopped fleet stopped. One file per session under its
 * orchestration home's state directory, `<stateDir>/fleet/queue/<sessionId>.json` (the owner's `<agentDir>/state`), and
 * one for its away controller, `<sessionId>@away.json`; bounded, written atomically and at most once per microtask; an
 * empty, running fleet removes it. Entries no recovered attempt claims are dropped by the first write. An earlier build
 * named the away controller's file `<sessionId>.away.json`, the name a session whose id is `<sessionId>.away` keeps as its
 * own; its content (the stop and the entries) names neither, so whose it may be is told by whether the home holds that
 * session's orchestration state ({@link earlierAwayFleetQueueMetadataFile}), and the away controller adopts it only once
 * its own ledger claims every entry ({@link settleEarlierAwayFleetQueue}).
 */

import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
/** What {@link settleEarlierAwayFleetQueue} adds to the name of an earlier-named file it sets aside, before the time. */
const SET_ASIDE_INFIX = ".unowned-";

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
 * the same home, so a live or retained session of that id always leaves that state there. The away controller settles
 * the file ({@link settleEarlierAwayFleetQueue}: adopted only on its ledger's claim), the retention that removes the
 * session's bundle removes it, and the bot bundle move carries it under its name, each by this rule.
 */
export function earlierAwayFleetQueueMetadataFile(home: OrchestrationHome, sessionId: string): string | undefined {
	const path = earlierAwayFleetQueueMetadataPath(home, sessionId);
	if (!existsSync(path)) return undefined;
	return orchestrationHomeHoldsSession(home, `${sessionId}.away`) ? undefined : path;
}

/**
 * Settles the file an earlier build left for session `sessionId`'s away controller ({@link earlierAwayFleetQueueMetadataFile})
 * before that controller opens its store, under the controller's own file's lock, the rule checked again inside it. With
 * a file of its own, which is the one it loads, the earlier one is removed, logged. Without one, the earlier file is
 * adopted by one rename (retried while Windows holds the file a moment) only when it proves to be the controller's: it
 * parses, holds entries, and the controller's ledger claims every one (`claims`). Its name alone proves nothing: a build
 * up to 0.104.64 never removed a fleet queue file with its session, so the file may be one an earlier session of the same
 * id left, or a session's whose id ends in `.away`. A file that fails is renamed aside to `<name>.unowned-<now>` (kept,
 * never adopted) and that path is returned, for the owner to be told; the rename happens once, so they are told once. A
 * rename that fails is thrown.
 */
export function settleEarlierAwayFleetQueue(
	home: OrchestrationHome,
	sessionId: string,
	claims: (entry: FleetQueueMetadataEntry) => boolean,
	now: number,
): string | undefined {
	if (earlierAwayFleetQueueMetadataFile(home, sessionId) === undefined) return undefined;
	const path = fleetQueueMetadataPath(home, awayFleetQueueKey(sessionId));
	return withFileLockSync(path, () => {
		const earlier = earlierAwayFleetQueueMetadataFile(home, sessionId);
		if (earlier === undefined) return undefined;
		if (existsSync(path)) {
			rmSync(earlier, { force: true });
			harnessLog.info("fleet", "the earlier away fleet queue file was removed: the away controller's own is loaded");
			return undefined;
		}
		const metadata = readFleetQueueMetadata(earlier);
		if (metadata !== undefined && metadata.entries.length > 0 && metadata.entries.every(claims)) {
			retryTransientWin32Sync(() => renameSync(earlier, path));
			return undefined;
		}
		const aside = `${earlier}${SET_ASIDE_INFIX}${now}`;
		retryTransientWin32Sync(() => renameSync(earlier, aside));
		harnessLog.warn(
			"fleet",
			"an earlier away fleet queue file was set aside: the away controller's ledger does not claim it",
			{
				aside,
			},
		);
		return aside;
	});
}

/**
 * The files {@link settleEarlierAwayFleetQueue} set aside for session `sessionId`'s away controller in `home`
 * (`<sessionId>.away.json.unowned-<time>`): kept, never adopted, and removed with the session's bundle by the retention
 * that removes it, as the session's other side files are. No other session's settlement writes that name: another
 * session's set-aside file begins with its own id's earlier name.
 */
export function earlierAwayFleetQueueSetAsideFiles(home: OrchestrationHome, sessionId: string): string[] {
	const earlier = earlierAwayFleetQueueMetadataPath(home, sessionId);
	const dir = dirname(earlier);
	if (!existsSync(dir)) return [];
	const prefix = `${basename(earlier)}${SET_ASIDE_INFIX}`;
	return readdirSync(dir)
		.filter((name) => name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)))
		.map((name) => join(dir, name));
}

/**
 * The store of fleet queue `key` in `home`. An away controller's earlier-named file is settled before its store opens
 * (`away-parent-context.ts`, {@link settleEarlierAwayFleetQueue}).
 */
export function openFleetQueueStore(home: OrchestrationHome, key: string): FleetQueueStore {
	return new FleetQueueStore(fleetQueueMetadataPath(home, key));
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
		return readFleetQueueMetadata(this.path);
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

/** The metadata file `path` holds; undefined when there is none or it does not parse. */
function readFleetQueueMetadata(path: string): FleetQueueMetadata | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return parseFleetQueueMetadata(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		harnessLog.warn("fleet", "a fleet queue metadata file did not parse", { path });
		return undefined;
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
