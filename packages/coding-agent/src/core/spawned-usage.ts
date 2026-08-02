import { createHash } from "node:crypto";
import type { Usage } from "@caupulican/pi-ai";

export interface SpawnedUsageReporter {
	addSpawnedUsage(
		usage: Usage,
		options: { label?: string; sourceSessionId?: string; reportId: string },
	): string | undefined;
}

export type SpawnedUsageIdentity = string | readonly string[];

export interface SpawnedUsageIdentityOptions {
	kind: string;
	label?: string;
	sessionId: string;
	identity: SpawnedUsageIdentity;
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
	return `${kind}:${sessionId}:${hash.digest("hex").slice(0, 16)}`;
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
		...(options.label !== undefined ? { label: options.label } : {}),
		reportId: deriveSpawnedUsageReportId(options.kind, options.sessionId, options.identity),
	});
}
