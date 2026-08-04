import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	acquireWorkRun,
	getWorkRunDir,
	getWorkTenantDir,
	hasActiveWorkRunLease,
	pruneWorkTenant,
	type WorkRetentionOptions,
} from "../../utils/work-directory.ts";

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSION_DIRS = 64;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_LEGACY_SESSION_DIRS = 10_000;
const MAX_LEGACY_FILES_PER_SESSION = 100_000;
const CONTEXT_WORK_TENANT = "sessions";
const WORK_RUN_MANIFEST_FILE = ".pi-work-run.json";

export type ContextStoreKind = "gc" | "artifacts";

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

interface LegacyContextStore {
	root: string;
	kind: ContextStoreKind;
	managedRun: boolean;
}

function toWorkRetention(options: ContextStoreRetentionOptions): WorkRetentionOptions {
	return {
		maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
		maxRuns: options.maxSessionDirs ?? DEFAULT_MAX_SESSION_DIRS,
		maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
		now: options.now,
	};
}

function legacyContextStores(agentDir: string): LegacyContextStore[] {
	return [
		{ root: join(agentDir, "context-gc"), kind: "gc", managedRun: false },
		{ root: join(agentDir, "context-artifacts"), kind: "artifacts", managedRun: false },
		{ root: getWorkTenantDir(agentDir, "context", "gc"), kind: "gc", managedRun: true },
		{ root: getWorkTenantDir(agentDir, "context", "artifacts"), kind: "artifacts", managedRun: true },
	];
}

function isRecognizedPayload(kind: ContextStoreKind, name: string): boolean {
	if (kind === "gc") return /^[0-9a-f]{1,64}\.txt$/.test(name);
	return /^[0-9a-f]{1,64}(?:\.payload|\.meta\.json|\.refs)$/.test(name);
}

function isRealDirectory(path: string): boolean {
	try {
		const stats = lstatSync(path);
		return stats.isDirectory() && !stats.isSymbolicLink();
	} catch {
		return false;
	}
}

function recognizedPayloads(sourceDir: string, kind: ContextStoreKind): string[] | undefined {
	try {
		const entries = readdirSync(sourceDir, { withFileTypes: true });
		if (entries.length > MAX_LEGACY_FILES_PER_SESSION) return undefined;
		return entries
			.filter(
				(entry) =>
					(entry.isFile() ||
						(kind === "artifacts" && entry.isDirectory() && /^[0-9a-f]{1,64}\.refs$/.test(entry.name))) &&
					!entry.isSymbolicLink() &&
					isRecognizedPayload(kind, entry.name),
			)
			.map((entry) => entry.name);
	} catch {
		return undefined;
	}
}

function removeLegacyRunIfEmpty(sourceDir: string, managedRun: boolean): void {
	try {
		rmdirSync(join(sourceDir, ".leases"));
	} catch {}
	if (managedRun) {
		try {
			const entries = readdirSync(sourceDir);
			if (entries.length === 1 && entries[0] === WORK_RUN_MANIFEST_FILE) {
				unlinkSync(join(sourceDir, WORK_RUN_MANIFEST_FILE));
			}
		} catch {}
	}
	try {
		rmdirSync(sourceDir);
	} catch {}
}

function migrateLegacySessionStore(agentDir: string, sessionId: string, store: LegacyContextStore): void {
	const sourceDir = join(store.root, sessionId);
	if (!isRealDirectory(sourceDir)) return;
	if (store.managedRun && hasActiveWorkRunLease(sourceDir)) return;
	const payloads = recognizedPayloads(sourceDir, store.kind);
	if (!payloads) return;

	if (payloads.length > 0) {
		let lease: ReturnType<typeof acquireWorkRun> | undefined;
		try {
			lease = acquireWorkRun({
				agentDir,
				category: "context",
				tenant: CONTEXT_WORK_TENANT,
				runId: sessionId,
				retention: false,
			});
			const targetDir = join(lease.path, store.kind);
			mkdirSync(targetDir, { recursive: true });
			for (const name of payloads) {
				const sourcePath = join(sourceDir, name);
				const targetPath = join(targetDir, name);
				if (existsSync(targetPath)) continue;
				try {
					renameSync(sourcePath, targetPath);
				} catch {}
			}
		} catch {
			return;
		} finally {
			lease?.release();
		}
	}

	removeLegacyRunIfEmpty(sourceDir, store.managedRun);
}

/**
 * Move recognized context payloads from both historical layouts into the single leased session
 * namespace. Unknown files, symlinks, active runs, and conflicting destinations are left untouched.
 */
export function migrateLegacyContextStores(agentDir: string, onlySessionId?: string): void {
	for (const store of legacyContextStores(agentDir)) {
		let sessionIds: string[];
		if (onlySessionId) {
			sessionIds = [onlySessionId];
		} else {
			try {
				sessionIds = readdirSync(store.root, { withFileTypes: true })
					.slice(0, MAX_LEGACY_SESSION_DIRS)
					.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
					.map((entry) => entry.name);
			} catch {
				continue;
			}
		}
		for (const sessionId of sessionIds) {
			migrateLegacySessionStore(agentDir, sessionId, store);
		}
		try {
			rmdirSync(store.root);
		} catch {}
	}
	try {
		rmdirSync(join(agentDir, "work", "context"));
	} catch {}
}

export function pruneContextStores(agentDir: string, options: ContextStoreRetentionOptions = {}): string[] {
	return pruneWorkTenant(agentDir, "context", CONTEXT_WORK_TENANT, toWorkRetention(options));
}

export function getContextStoreDir(agentDir: string, kind: ContextStoreKind, sessionId: string): string {
	return join(getWorkRunDir(agentDir, "context", CONTEXT_WORK_TENANT, sessionId), kind);
}

export function acquireContextStoreRetention(
	agentDir: string,
	sessionId: string,
	options: ContextStoreRetentionOptions = {},
): ContextStoreRetentionLease {
	migrateLegacyContextStores(agentDir, sessionId);
	const lease = acquireWorkRun({
		agentDir,
		category: "context",
		tenant: CONTEXT_WORK_TENANT,
		runId: sessionId,
		retention: toWorkRetention(options),
	});
	let released = false;
	return {
		gcDir: join(lease.path, "gc"),
		artifactsDir: join(lease.path, "artifacts"),
		release(): void {
			if (released) return;
			released = true;
			lease.release();
		},
	};
}
