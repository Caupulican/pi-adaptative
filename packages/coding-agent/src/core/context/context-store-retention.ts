import {
	acquireWorkRun,
	getWorkRunDir,
	pruneWorkTenant,
	type WorkRetentionOptions,
	type WorkRunLease,
} from "../../utils/work-directory.ts";

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSION_DIRS = 64;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export interface ContextStoreRetentionOptions {
	maxAgeMs?: number;
	maxSessionDirs?: number;
	maxTotalBytes?: number;
	now?: number;
}

export interface ContextStoreRetentionLease {
	readonly gcDir: string;
	readonly artifactsDir: string;
	release(): void;
}

function toWorkRetention(options: ContextStoreRetentionOptions): WorkRetentionOptions {
	return {
		maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
		maxRuns: options.maxSessionDirs ?? DEFAULT_MAX_SESSION_DIRS,
		maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
		now: options.now,
	};
}

export function pruneContextStores(
	agentDir: string,
	tenant: "gc" | "artifacts",
	options: ContextStoreRetentionOptions = {},
): string[] {
	return pruneWorkTenant(agentDir, "context", tenant, toWorkRetention(options));
}

export function getContextStoreDir(agentDir: string, tenant: "gc" | "artifacts", sessionId: string): string {
	return getWorkRunDir(agentDir, "context", tenant, sessionId);
}

export function acquireContextStoreRetention(
	agentDir: string,
	sessionId: string,
	options: ContextStoreRetentionOptions = {},
): ContextStoreRetentionLease {
	const retention = toWorkRetention(options);
	const leases: WorkRunLease[] = [];
	try {
		const gc = acquireWorkRun({ agentDir, category: "context", tenant: "gc", runId: sessionId, retention });
		leases.push(gc);
		const artifacts = acquireWorkRun({
			agentDir,
			category: "context",
			tenant: "artifacts",
			runId: sessionId,
			retention,
		});
		leases.push(artifacts);
		let released = false;
		return {
			gcDir: gc.path,
			artifactsDir: artifacts.path,
			release(): void {
				if (released) return;
				released = true;
				for (const lease of leases) lease.release();
			},
		};
	} catch (error) {
		for (const lease of leases) lease.release();
		throw error;
	}
}
