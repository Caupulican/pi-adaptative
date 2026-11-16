/**
 * Delivers a spawned worker's usage receipt to its parent session and classifies it as persisted, pending or belonging to a foreign session.
 */
import { isDeepStrictEqual } from "node:util";
import type { Usage } from "@caupulican/pi-ai";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { classifyCustomEntryPersisted } from "../session-entry-persistence.ts";
import type { SpawnedUsageOptions, SpawnedUsageReporter } from "../spawned-usage.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { SPAWNED_USAGE_CUSTOM_TYPE } from "./usage-records.ts";

export { classifyCustomEntryPersisted } from "../session-entry-persistence.ts";

export interface SpawnedUsageReceiptOptions extends SpawnedUsageOptions {
	parentSessionId: string;
	reportId: string;
}

export type SpawnedUsageReceiptDisposition = "persisted" | "pending" | "foreign_session";

/**
 * Whether the recorded report `data` is this receipt. A receipt that charges a range (`from` and `through`) is the same
 * charge as a report of the same source (its session and file instance), range and usage, whatever model or date it was recorded with: a range fixed again
 * after the source's model changed is still the one charge. Any other matches on every field it records but the model it
 * names: a receipt delivered again after its source moved model (a worker's failover), or one an earlier build recorded
 * under the model its worker was assigned, is still the one charge, and the record keeps the model it named first. The
 * metered part a report fixed (`meteredUsd`) is not its identity either.
 */
function matchesSpawnedUsageReceipt(data: unknown, usage: Usage, options: SpawnedUsageReceiptOptions): boolean {
	if (
		!isPlainRecord(data) ||
		data.reportId !== options.reportId ||
		data.sourceSessionId !== options.sourceSessionId ||
		data.sourceInstance !== options.sourceInstance
	)
		return false;
	if (
		!isDeepStrictEqual(data.from, options.from) ||
		!isDeepStrictEqual(data.through, options.through) ||
		!isDeepStrictEqual(data.usage, usage)
	)
		return false;
	if (options.from !== undefined && options.through !== undefined) return true;
	return (
		(data.goalId === undefined || data.goalId === options.goalId) &&
		isDeepStrictEqual(data.usageComponents, options.usageComponents)
	);
}

/** Confirm physical parent persistence through its existing idempotent ingestion owner. */
export function deliverSpawnedUsageReceipt(
	session: Pick<SessionManager, "getSessionId" | "getEntry" | "readEntryJsonPrefix">,
	reporter: SpawnedUsageReporter,
	usage: Usage,
	options: SpawnedUsageReceiptOptions,
): SpawnedUsageReceiptDisposition {
	if (session.getSessionId() !== options.parentSessionId) return "foreign_session";
	if (!options.reportId.trim()) throw new Error("Spawned usage receipt requires an identity.");
	// The entry holding the report: the one appended, or on a replay the one that recorded its id (the report-id index).
	const entryId = reporter.addSpawnedUsage(structuredClone(usage), options);
	const entry = entryId === undefined ? undefined : session.getEntry(entryId);
	if (
		entry?.type !== "custom" ||
		entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE ||
		!matchesSpawnedUsageReceipt(entry.data, usage, options)
	) {
		throw new Error("Spawned usage receipt identity conflicts with the parent ledger.");
	}
	const physical = classifyCustomEntryPersisted(session, entry.id, SPAWNED_USAGE_CUSTOM_TYPE, (data) =>
		matchesSpawnedUsageReceipt(data, usage, options),
	);
	if (physical === "conflict") throw new Error("Spawned usage persisted receipt conflicts with the parent ledger.");
	return physical;
}
