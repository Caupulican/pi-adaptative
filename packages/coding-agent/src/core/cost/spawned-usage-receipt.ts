import { isDeepStrictEqual } from "node:util";
import type { Usage } from "@caupulican/pi-ai";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { UsageComponent } from "../../kernel/usage-components.ts";
import { classifyCustomEntryPersisted } from "../session-entry-persistence.ts";
import type { SpawnedUsageReporter } from "../spawned-usage.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { SPAWNED_USAGE_CUSTOM_TYPE } from "./usage-records.ts";

export { classifyCustomEntryPersisted } from "../session-entry-persistence.ts";

export interface SpawnedUsageReceiptOptions {
	usageComponents?: readonly UsageComponent[];
	parentSessionId: string;
	reportId: string;
	label?: string;
	sourceSessionId?: string;
	/** Originating worker binding; cumulative usage may also include other models. */
	provider?: string;
	model?: string;
	goalId?: string;
}

export type SpawnedUsageReceiptDisposition = "persisted" | "pending" | "foreign_session";

function matchesSpawnedUsageReceipt(data: unknown, usage: Usage, options: SpawnedUsageReceiptOptions): boolean {
	return (
		isPlainRecord(data) &&
		data.reportId === options.reportId &&
		data.sourceSessionId === options.sourceSessionId &&
		(data.provider === undefined || data.provider === options.provider) &&
		(data.model === undefined || data.model === options.model) &&
		(data.goalId === undefined || data.goalId === options.goalId) &&
		isDeepStrictEqual(data.usageComponents, options.usageComponents) &&
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
	const physical = classifyCustomEntryPersisted(session, entry.id, SPAWNED_USAGE_CUSTOM_TYPE, (data) =>
		matchesSpawnedUsageReceipt(data, usage, options),
	);
	if (physical === "conflict") throw new Error("Spawned usage persisted receipt conflicts with the parent ledger.");
	return physical;
}
