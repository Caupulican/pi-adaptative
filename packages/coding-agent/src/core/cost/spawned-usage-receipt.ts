import { isDeepStrictEqual } from "node:util";
import type { SessionManager } from "@caupulican/pi-agent-core/session";
import type { Usage } from "@caupulican/pi-ai";
import { SPAWNED_USAGE_CUSTOM_TYPE } from "../agent-session-contracts.ts";
import type { SpawnedUsageReporter } from "../spawned-usage.ts";
import { isPlainRecord } from "../util/value-guards.ts";

export interface SpawnedUsageReceiptOptions {
	parentSessionId: string;
	reportId: string;
	label?: string;
	sourceSessionId?: string;
}

export type SpawnedUsageReceiptDisposition = "persisted" | "pending" | "foreign_session";

function matchesSpawnedUsageReceipt(data: unknown, usage: Usage, options: SpawnedUsageReceiptOptions): boolean {
	return (
		isPlainRecord(data) &&
		data.reportId === options.reportId &&
		data.sourceSessionId === options.sourceSessionId &&
		isDeepStrictEqual(data.usage, usage)
	);
}

/** Confirm physical parent persistence through its existing idempotent ingestion owner. */
export function deliverSpawnedUsageReceipt(
	session: Pick<SessionManager, "getSessionId" | "getEntry" | "getEntries" | "readEntryJsonPrefix">,
	reporter: SpawnedUsageReporter,
	usage: Usage,
	options: SpawnedUsageReceiptOptions,
): SpawnedUsageReceiptDisposition {
	if (session.getSessionId() !== options.parentSessionId) return "foreign_session";
	if (!options.reportId.trim()) throw new Error("Spawned usage receipt requires an identity.");
	const entryId = reporter.addSpawnedUsage(structuredClone(usage), options);
	// Normal delivery is an indexed lookup. Only replay locates the original ledger entry.
	const entry = entryId
		? session.getEntry(entryId)
		: session
				.getEntries()
				.find(
					(candidate) =>
						candidate.type === "custom" &&
						candidate.customType === SPAWNED_USAGE_CUSTOM_TYPE &&
						isPlainRecord(candidate.data) &&
						candidate.data.reportId === options.reportId,
				);
	if (
		entry?.type !== "custom" ||
		entry.customType !== SPAWNED_USAGE_CUSTOM_TYPE ||
		!matchesSpawnedUsageReceipt(entry.data, usage, options)
	) {
		throw new Error("Spawned usage receipt identity conflicts with the parent ledger.");
	}
	const json = session.readEntryJsonPrefix(entry.id, 64 * 1024);
	if (json === undefined) return "pending";
	let persisted: unknown;
	try {
		persisted = JSON.parse(json);
	} catch (error) {
		if (error instanceof SyntaxError) return "pending";
		throw error;
	}
	if (
		!isPlainRecord(persisted) ||
		persisted.id !== entry.id ||
		persisted.type !== "custom" ||
		persisted.customType !== SPAWNED_USAGE_CUSTOM_TYPE ||
		!matchesSpawnedUsageReceipt(persisted.data, usage, options)
	) {
		throw new Error("Spawned usage persisted receipt conflicts with the parent ledger.");
	}
	return "persisted";
}
