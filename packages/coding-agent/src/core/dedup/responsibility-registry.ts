/**
 * Responsibility Registry.
 * Tracks and persists semantic responsibility records across revisions.
 * Implements S1A-201, S1A-207, S1A-223.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ResponsibilityRecord } from "./types.ts";

export class ResponsibilityRegistry {
	private readonly records = new Map<string, ResponsibilityRecord>();
	private currentRevision = "rev_init";
	private readonly persistentPath?: string;

	constructor(persistentPath?: string) {
		this.persistentPath = persistentPath;
		if (this.persistentPath && existsSync(this.persistentPath)) {
			this.loadFromDisk();
		}
	}

	private loadFromDisk(): void {
		if (!this.persistentPath) return;
		try {
			const parsed = JSON.parse(readFileSync(this.persistentPath, "utf8"));
			if (parsed?.records && typeof parsed.records === "object") {
				this.currentRevision = typeof parsed.currentRevision === "string" ? parsed.currentRevision : "rev_init";
				for (const [k, v] of Object.entries(parsed.records as Record<string, ResponsibilityRecord>)) {
					this.records.set(k, v);
				}
			}
		} catch {
			// Fail-safe load
		}
	}

	private saveToDisk(): void {
		if (!this.persistentPath) return;
		try {
			mkdirSync(dirname(this.persistentPath), { recursive: true });
			writeFileSync(
				this.persistentPath,
				JSON.stringify(
					{ currentRevision: this.currentRevision, records: Object.fromEntries(this.records) },
					null,
					2,
				),
				"utf8",
			);
		} catch {
			// Fail-safe persistence
		}
	}

	setRevision(revision: string): void {
		this.currentRevision = revision;
	}

	getRevision(): string {
		return this.currentRevision;
	}

	register(record: ResponsibilityRecord): void {
		this.records.set(record.responsibility_id, record);
		this.saveToDisk();
	}

	get(responsibilityId: string): ResponsibilityRecord | undefined {
		return this.records.get(responsibilityId);
	}

	listActive(): readonly ResponsibilityRecord[] {
		return Array.from(this.records.values()).filter((r) => r.status === "active");
	}

	/**
	 * Finds active records matching query keywords or locations.
	 */
	findCandidates(query: string, targetLocation?: string): readonly ResponsibilityRecord[] {
		const keywords = query
			.toLowerCase()
			.split(/\W+/)
			.filter((w) => w.length > 2);
		const results: ResponsibilityRecord[] = [];

		for (const record of this.listActive()) {
			let matchScore = 0;
			const stmt = record.statement.toLowerCase();
			for (const kw of keywords) {
				if (stmt.includes(kw)) {
					matchScore += 1;
				}
			}

			if (targetLocation && record.owner_locations.includes(targetLocation)) {
				matchScore += 3;
			}

			if (matchScore > 0) {
				results.push(record);
			}
		}

		return results;
	}

	/**
	 * S1A-223: Invalidates responsibility records on relevant mutation.
	 */
	invalidateOnMutation(mutatedFiles: readonly string[], newRevision: string): void {
		this.currentRevision = newRevision;
		const mutatedSet = new Set(mutatedFiles);

		for (const [id, record] of this.records.entries()) {
			if (record.status === "active") {
				const touchesMutated = record.owner_locations.some((loc) => mutatedSet.has(loc));
				if (touchesMutated) {
					this.records.set(id, {
						...record,
						status: "superseded",
					});
				}
			}
		}
		this.saveToDisk();
	}

	clear(): void {
		this.records.clear();
	}
}
