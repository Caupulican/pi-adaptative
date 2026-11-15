import { createHash } from "node:crypto";
import type { Usage } from "@caupulican/pi-ai";
import type { UsageComponent } from "../kernel/usage-components.ts";

/** How a spawned-usage report is recorded (`SpawnedUsageReport`): its label, source session, report id, model, goal and components. */
export interface SpawnedUsageOptions {
	label?: string;
	sourceSessionId?: string;
	reportId?: string;
	/** Originating worker binding; cumulative usage may also include other models. */
	provider?: string;
	model?: string;
	goalId?: string;
	usageComponents?: readonly UsageComponent[];
	/** The source session's cumulative usage the charged range starts at (`SpawnedUsageReport.from`). */
	from?: Usage;
	/** The source session's cumulative usage the charged range ends at (`SpawnedUsageReport.through`). */
	through?: Usage;
	/** When the report was first recorded (`SpawnedUsageReport.recordedAt`). */
	recordedAt?: string;
}

export interface SpawnedUsageReporter {
	addSpawnedUsage(usage: Usage, options: SpawnedUsageOptions & { reportId: string }): string | undefined;
}

export type SpawnedUsageIdentity = string | readonly string[];

export interface SpawnedUsageIdentityOptions {
	usageComponents?: readonly UsageComponent[];
	kind: string;
	label?: string;
	sessionId: string;
	identity: SpawnedUsageIdentity;
}

/** What every report id of `kind` starts with (`deriveSpawnedUsageReportId`): the namespace of that kind's ids. */
export function spawnedUsageReportIdPrefix(kind: string): string {
	return `${kind}:`;
}

/** Stable retry identity; chunk arrays hash as their space-joined form without materializing that string. */
export function deriveSpawnedUsageReportId(kind: string, sessionId: string, identity: SpawnedUsageIdentity): string {
	const hash = createHash("sha256");
	if (typeof identity === "string") {
		hash.update(identity);
	} else {
		for (let index = 0; index < identity.length; index++) {
			if (index > 0) hash.update(" ");
			hash.update(identity[index]);
		}
	}
	return `${spawnedUsageReportIdPrefix(kind)}${sessionId}:${hash.digest("hex").slice(0, 16)}`;
}

export function hasReportableUsage(usage: Usage): boolean {
	return usage.cost.total > 0 || usage.totalTokens > 0;
}

/** Gate and record one spawned work unit through the session's idempotent usage ledger. */
export function reportSpawnedUsage(
	reporter: SpawnedUsageReporter,
	usage: Usage,
	options: SpawnedUsageIdentityOptions,
): string | undefined {
	if (!hasReportableUsage(usage)) return undefined;
	return reporter.addSpawnedUsage(usage, {
		...(options.usageComponents ? { usageComponents: options.usageComponents } : {}),
		...(options.label !== undefined ? { label: options.label } : {}),
		reportId: deriveSpawnedUsageReportId(options.kind, options.sessionId, options.identity),
	});
}
