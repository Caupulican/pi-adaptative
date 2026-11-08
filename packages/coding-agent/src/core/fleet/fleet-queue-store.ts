/**
 * The fleet's restart metadata: per queued node its flow, base priority, first enqueue time, last wait reason and reopen
 * time, plus whether the session's fleet was stopped. The orchestration ledger stays the owner of which attempts exist
 * and are queued; this file carries only what the ledger does not (ordering and the stop), so a restart re-enqueues the
 * ledger's queued attempts with their aging intact and keeps a stopped fleet stopped. One file per session at
 * `<agentDir>/state/fleet/queue/<sessionId>.json`, bounded, written atomically and at most once per microtask; an
 * empty, running fleet removes it. Entries no recovered attempt claims are dropped by the first write.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
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

export function fleetQueueMetadataPath(agentDir: string, sessionId: string): string {
	return join(agentDir, "state", "fleet", "queue", `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
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
