/**
 * The carry file beside an orchestration projection snapshot: what the snapshot's projection cannot hold, kept verbatim
 * for a build that reads it whole (a plan from a newer build: `plan/plan-carry.ts`). It is
 * `snapshots/<16-digit ordinal>.carried.json`, bound to the snapshot of that ordinal by the snapshot's digest, written
 * before the baseline that publishes that snapshot and removed by the compaction that replaces it. Its name misses the
 * snapshot pattern (`^\d{16}\.json$`) and the accounting sources' (`^\d+\.json$`, `worker-usage-history.ts`), so a
 * build up to 0.104.65 never lists, reads or removes it: that build reads the snapshot alone, and its own compaction
 * leaves the file behind, where no snapshot binds it. It is bounded as a snapshot is
 * (`MAX_ORCHESTRATION_PROJECTION_SNAPSHOT_BYTES`): a carry past that bound fails its compaction as an oversized
 * snapshot does, so nothing in it is dropped.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { JsonObject } from "../autonomy/contracts.ts";
import { readOptionalBoundedTextFileSync } from "../util/bounded-file.ts";
import { MAX_ORCHESTRATION_PROJECTION_SNAPSHOT_BYTES, type OrchestrationEvent, toJsonObject } from "./contracts.ts";
import { OrchestrationEventStoreError } from "./event-store-errors.ts";
import { hasExactFields, serializeCompactBounded } from "./event-store-files.ts";

const CARRIED_FILE_PATTERN = /^\d{16}\.carried\.json$/;
const CARRIED_FIELDS = ["version", "throughOrdinal", "snapshotDigest", "carried", "digest"] as const;
const LABEL = "Orchestration carried snapshot file";

/** What a compaction replaces: the published snapshot with the carry bound to it, and the tail events it folds. */
export interface CompactionBasis {
	readonly prior: { readonly projection: JsonObject; readonly carried: JsonObject | undefined } | undefined;
	readonly tail: readonly OrchestrationEvent[];
}

/** What a compaction publishes: the projection snapshot, and what that projection cannot hold, carried beside it. */
export interface CompactionFold {
	readonly projection: JsonObject;
	readonly carried?: JsonObject;
}

export function carriedFileName(throughOrdinal: number): string {
	return `${String(throughOrdinal).padStart(16, "0")}.carried.json`;
}

export function isCarriedFileName(name: string): boolean {
	return CARRIED_FILE_PATTERN.test(name);
}

function carriedDigest(throughOrdinal: number, snapshotDigest: string, carried: JsonObject): string {
	const content = { version: 1, throughOrdinal, snapshotDigest, carried };
	return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/** The carry file of the snapshot of `throughOrdinal` whose digest is `snapshotDigest`. */
export function serializeCarriedFile(throughOrdinal: number, snapshotDigest: string, carried: JsonObject): string {
	const digest = carriedDigest(throughOrdinal, snapshotDigest, carried);
	return serializeCompactBounded(
		{ version: 1, throughOrdinal, snapshotDigest, carried, digest },
		MAX_ORCHESTRATION_PROJECTION_SNAPSHOT_BYTES,
		LABEL,
	);
}

/**
 * The carry bound to the snapshot of `throughOrdinal` and `snapshotDigest`, undefined when none is: no file of that
 * ordinal, or one written for a snapshot of the same ordinal that never became this one (a compaction that crashed before
 * its baseline, after which an older build compacted at that ordinal). A file that cannot be read or does not match its
 * own digest throws, as a snapshot does.
 */
export function readCarriedFile(
	snapshotsDir: string,
	throughOrdinal: number,
	snapshotDigest: string,
): JsonObject | undefined {
	let parsed: unknown;
	try {
		const text = readOptionalBoundedTextFileSync(
			join(snapshotsDir, carriedFileName(throughOrdinal)),
			MAX_ORCHESTRATION_PROJECTION_SNAPSHOT_BYTES,
			LABEL,
		);
		if (text === undefined) return undefined;
		parsed = JSON.parse(text);
	} catch (error) {
		throw new OrchestrationEventStoreError(
			`Failed to parse orchestration carried snapshot file: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new OrchestrationEventStoreError("Invalid orchestration carried snapshot file.");
	const file = parsed as Record<string, unknown>;
	if (
		!hasExactFields(file, CARRIED_FIELDS) ||
		file.version !== 1 ||
		file.throughOrdinal !== throughOrdinal ||
		typeof file.snapshotDigest !== "string" ||
		typeof file.digest !== "string" ||
		!file.carried ||
		typeof file.carried !== "object" ||
		Array.isArray(file.carried)
	) {
		throw new OrchestrationEventStoreError("Invalid orchestration carried snapshot file.");
	}
	const carried = toJsonObject(file.carried);
	if (carriedDigest(throughOrdinal, file.snapshotDigest, carried) !== file.digest)
		throw new OrchestrationEventStoreError("Orchestration carried snapshot file digest mismatch.");
	return file.snapshotDigest === snapshotDigest ? carried : undefined;
}
