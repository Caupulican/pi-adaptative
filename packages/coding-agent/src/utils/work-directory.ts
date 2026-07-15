import { randomUUID } from "node:crypto";
import {
	type Dir,
	existsSync,
	lstatSync,
	mkdirSync,
	opendirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export const PI_WORK_ROOT_ENV = "PI_WORK_ROOT";
export const WORK_RUN_MANIFEST_FILE = ".pi-work-run.json";

const LEASES_DIRECTORY = ".leases";
const CLEANUP_MARKER_FILE = ".cleanup.json";
const MAX_METADATA_BYTES = 4 * 1024;
const MAX_LEASE_MARKERS = 256;
const MAX_DIRECTORY_DEPTH = 64;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RUNS = 64;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_SCANNED_ENTRIES = 100_000;
const DEFAULT_MAX_SCANNED_RUNS = 10_000;
const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_NAMES = new Set([
	"aux",
	"clock$",
	"con",
	"nul",
	"prn",
	...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
	...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

interface WorkRunManifest {
	version: 1;
	category: string;
	tenant: string;
	runId: string;
	createdAt: number;
}

interface WorkMarker {
	version: 1;
	hostname: string;
	pid: number;
	createdAt: number;
}

interface InspectedRun {
	path: string;
	mtimeMs: number;
	bytes: number;
}

interface ScanBudget {
	remaining: number;
}

export interface WorkRetentionOptions {
	maxAgeMs?: number;
	maxRuns?: number;
	maxTotalBytes?: number;
	/** Fixed tenant-wide cap for recursive file entries inspected during one prune. */
	maxScannedEntries?: number;
	/** Fixed cap for run directories inspected during one prune. */
	maxScannedRuns?: number;
	now?: number;
}

export interface AcquireWorkRunOptions {
	agentDir: string;
	category: string;
	tenant: string;
	runId?: string;
	retention?: WorkRetentionOptions | false;
	now?: number;
}

export interface WorkRunLease {
	readonly path: string;
	readonly category: string;
	readonly tenant: string;
	readonly runId: string;
	touch(): void;
	release(): void;
}

const processWorkRuns = new Map<string, WorkRunLease>();

function nonNegativeLimit(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function assertPortableSegment(label: string, value: string): void {
	if (!SEGMENT_PATTERN.test(value) || value.endsWith(".")) {
		throw new Error(`${label} must be a lowercase portable path segment (1-64 characters)`);
	}
	const stem = value.split(".", 1)[0];
	if (stem && WINDOWS_RESERVED_NAMES.has(stem)) {
		throw new Error(`${label} uses a Windows-reserved path name: ${value}`);
	}
}

function ensureDirectory(path: string): void {
	try {
		mkdirSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const stats = lstatSync(path);
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new Error(`Work path is not a real directory: ${path}`);
	}
}

function ensureTenantDirectory(agentDir: string, category: string, tenant: string): string {
	mkdirSync(agentDir, { recursive: true });
	const workRoot = getWorkRoot(agentDir);
	ensureDirectory(workRoot);
	const categoryDir = join(workRoot, category);
	ensureDirectory(categoryDir);
	const tenantDir = join(categoryDir, tenant);
	ensureDirectory(tenantDir);
	return tenantDir;
}

function readSmallJson(path: string): unknown {
	const stats = lstatSync(path);
	if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_METADATA_BYTES) {
		throw new Error(`Invalid work metadata file: ${path}`);
	}
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function isManifest(value: unknown, category: string, tenant: string, runId: string): value is WorkRunManifest {
	if (!value || typeof value !== "object") return false;
	const manifest = value as Partial<WorkRunManifest>;
	return (
		manifest.version === 1 &&
		manifest.category === category &&
		manifest.tenant === tenant &&
		manifest.runId === runId &&
		typeof manifest.createdAt === "number" &&
		Number.isFinite(manifest.createdAt)
	);
}

function isMarker(value: unknown): value is WorkMarker {
	if (!value || typeof value !== "object") return false;
	const marker = value as Partial<WorkMarker>;
	return (
		marker.version === 1 &&
		typeof marker.hostname === "string" &&
		typeof marker.pid === "number" &&
		Number.isSafeInteger(marker.pid) &&
		marker.pid > 0 &&
		typeof marker.createdAt === "number" &&
		Number.isFinite(marker.createdAt)
	);
}

function markerState(path: string): "active" | "stale" | "unknown" {
	try {
		const value = readSmallJson(path);
		if (!isMarker(value)) return "unknown";
		if (value.hostname !== hostname()) return "active";
		try {
			process.kill(value.pid, 0);
			return "active";
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM" ? "active" : "stale";
		}
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "stale" : "unknown";
	}
}

function removeFile(path: string): void {
	try {
		unlinkSync(path);
	} catch {}
}

function cleanupMarkerBlocksAcquisition(runDir: string): boolean {
	const markerPath = join(runDir, CLEANUP_MARKER_FILE);
	if (!existsSync(markerPath)) return false;
	const state = markerState(markerPath);
	if (state !== "stale") return true;
	removeFile(markerPath);
	return existsSync(markerPath);
}

function hasActiveLease(runDir: string): boolean {
	const leasesDir = join(runDir, LEASES_DIRECTORY);
	if (!existsSync(leasesDir)) return false;
	let handle: Dir | undefined;
	try {
		handle = opendirSync(leasesDir);
		let scanned = 0;
		while (true) {
			const entry = handle.readSync();
			if (!entry) break;
			scanned++;
			if (scanned > MAX_LEASE_MARKERS) return true;
			if (!entry.isFile()) return true;
			const markerPath = join(leasesDir, entry.name);
			const state = markerState(markerPath);
			if (state === "active" || state === "unknown") return true;
			removeFile(markerPath);
		}
	} catch {
		return true;
	} finally {
		try {
			handle?.closeSync();
		} catch {}
	}
	try {
		rmdirSync(leasesDir);
	} catch {}
	return false;
}

function measureDirectory(path: string, budget: ScanBudget, depth = 0): { bytes: number; complete: boolean } {
	if (depth > MAX_DIRECTORY_DEPTH || budget.remaining <= 0) return { bytes: 0, complete: false };
	let bytes = 0;
	let complete = true;
	let handle: Dir | undefined;
	try {
		handle = opendirSync(path);
		while (true) {
			const entry = handle.readSync();
			if (!entry) break;
			if (budget.remaining <= 0) return { bytes, complete: false };
			budget.remaining--;
			const childPath = join(path, entry.name);
			try {
				const stats = lstatSync(childPath);
				if (stats.isDirectory() && !stats.isSymbolicLink()) {
					const child = measureDirectory(childPath, budget, depth + 1);
					bytes += child.bytes;
					complete = complete && child.complete;
				} else {
					bytes += stats.size;
				}
			} catch {
				complete = false;
			}
		}
	} catch {
		return { bytes, complete: false };
	} finally {
		try {
			handle?.closeSync();
		} catch {}
	}
	return { bytes, complete };
}

function inspectRun(
	runPath: string,
	category: string,
	tenant: string,
	runId: string,
	budget: ScanBudget,
	unknownBytes: number,
): InspectedRun | undefined {
	try {
		const stats = lstatSync(runPath);
		if (!stats.isDirectory() || stats.isSymbolicLink()) return undefined;
		const manifest = readSmallJson(join(runPath, WORK_RUN_MANIFEST_FILE));
		if (!isManifest(manifest, category, tenant, runId)) return undefined;
		const measured = measureDirectory(runPath, budget);
		return {
			path: runPath,
			mtimeMs: stats.mtimeMs,
			bytes: measured.complete ? measured.bytes : unknownBytes,
		};
	} catch {
		return undefined;
	}
}

function createCleanupMarker(runDir: string, now: number): string | undefined {
	const path = join(runDir, CLEANUP_MARKER_FILE);
	const marker: WorkMarker = { version: 1, hostname: hostname(), pid: process.pid, createdAt: now };
	try {
		writeFileSync(path, JSON.stringify(marker), { encoding: "utf8", flag: "wx" });
		return path;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
		if (markerState(path) !== "stale") return undefined;
		removeFile(path);
		try {
			writeFileSync(path, JSON.stringify(marker), { encoding: "utf8", flag: "wx" });
			return path;
		} catch {
			return undefined;
		}
	}
}

function removeRunIfInactive(runPath: string, now: number): boolean {
	const cleanupMarker = createCleanupMarker(runPath, now);
	if (!cleanupMarker) return false;
	if (hasActiveLease(runPath)) {
		removeFile(cleanupMarker);
		return false;
	}
	try {
		rmSync(runPath, { recursive: true, force: true });
		return !existsSync(runPath);
	} catch {
		removeFile(cleanupMarker);
		return false;
	}
}

export function getWorkRoot(agentDir: string): string {
	return join(agentDir, "work");
}

export function getWorkTenantDir(agentDir: string, category: string, tenant: string): string {
	assertPortableSegment("Work category", category);
	assertPortableSegment("Work tenant", tenant);
	return join(getWorkRoot(agentDir), category, tenant);
}

export function getWorkRunDir(agentDir: string, category: string, tenant: string, runId: string): string {
	assertPortableSegment("Work category", category);
	assertPortableSegment("Work tenant", tenant);
	assertPortableSegment("Work run id", runId);
	return join(getWorkRoot(agentDir), category, tenant, runId);
}

export function createWorkRunId(now = Date.now()): string {
	return `run-${now.toString(36)}-${process.pid.toString(36)}-${randomUUID().slice(0, 12)}`;
}

export function pruneWorkTenant(
	agentDir: string,
	category: string,
	tenant: string,
	options: WorkRetentionOptions = {},
): string[] {
	const tenantDir = getWorkTenantDir(agentDir, category, tenant);
	if (!existsSync(tenantDir)) return [];
	try {
		const stats = lstatSync(tenantDir);
		if (!stats.isDirectory() || stats.isSymbolicLink()) return [];
	} catch {
		return [];
	}

	const now = options.now ?? Date.now();
	const maxAgeMs = nonNegativeLimit(options.maxAgeMs, DEFAULT_MAX_AGE_MS);
	const maxRuns = nonNegativeLimit(options.maxRuns, DEFAULT_MAX_RUNS);
	const maxTotalBytes = nonNegativeLimit(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
	const maxScannedRuns = nonNegativeLimit(options.maxScannedRuns, DEFAULT_MAX_SCANNED_RUNS);
	const budget: ScanBudget = {
		remaining: nonNegativeLimit(options.maxScannedEntries, DEFAULT_MAX_SCANNED_ENTRIES),
	};
	const unknownBytes = Math.max(1, maxTotalBytes + 1);
	const runs: InspectedRun[] = [];
	let truncated = false;
	let handle: Dir | undefined;
	try {
		handle = opendirSync(tenantDir);
		while (true) {
			const entry = handle.readSync();
			if (!entry) break;
			if (entry.name.startsWith(".")) continue;
			if (runs.length >= maxScannedRuns) {
				truncated = true;
				break;
			}
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			const inspected = inspectRun(join(tenantDir, entry.name), category, tenant, entry.name, budget, unknownBytes);
			if (inspected) runs.push(inspected);
		}
	} catch {
		return [];
	} finally {
		try {
			handle?.closeSync();
		} catch {}
	}

	const removed: string[] = [];
	let retainedCount = runs.length + (truncated ? maxRuns + 1 : 0);
	let retainedBytes = runs.reduce((sum, run) => sum + run.bytes, 0);
	for (const run of runs.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
		const expired = now - run.mtimeMs > maxAgeMs;
		const overCount = retainedCount > maxRuns;
		const overBytes = retainedBytes > maxTotalBytes;
		if (!expired && !overCount && !overBytes) continue;
		if (!removeRunIfInactive(run.path, now)) continue;
		removed.push(run.path);
		retainedCount--;
		retainedBytes -= run.bytes;
	}
	return removed;
}

export function getProcessWorkRun(agentDir: string, category: string, tenant: string, runId?: string): WorkRunLease {
	const key = `${agentDir}\0${category}\0${tenant}\0${runId ?? ""}`;
	const existing = processWorkRuns.get(key);
	if (existing && existsSync(existing.path)) return existing;
	const acquired = acquireWorkRun({ agentDir, category, tenant, runId });
	processWorkRuns.set(key, acquired);
	return acquired;
}

export function acquireWorkRun(options: AcquireWorkRunOptions): WorkRunLease {
	const now = options.now ?? Date.now();
	const runId = options.runId ?? createWorkRunId(now);
	assertPortableSegment("Work category", options.category);
	assertPortableSegment("Work tenant", options.tenant);
	assertPortableSegment("Work run id", runId);
	const tenantDir = ensureTenantDirectory(options.agentDir, options.category, options.tenant);
	const runDir = join(tenantDir, runId);
	let created = false;
	try {
		mkdirSync(runDir);
		created = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const stats = lstatSync(runDir);
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw new Error(`Work run path is not a real directory: ${runDir}`);
		}
	}

	const manifestPath = join(runDir, WORK_RUN_MANIFEST_FILE);
	if (created) {
		const manifest: WorkRunManifest = {
			version: 1,
			category: options.category,
			tenant: options.tenant,
			runId,
			createdAt: now,
		};
		writeFileSync(manifestPath, JSON.stringify(manifest), { encoding: "utf8", flag: "wx" });
	} else {
		let manifest: unknown;
		try {
			manifest = readSmallJson(manifestPath);
		} catch {
			throw new Error(`Refusing to adopt unowned work directory: ${runDir}`);
		}
		if (!isManifest(manifest, options.category, options.tenant, runId)) {
			throw new Error(`Work directory manifest does not match its path: ${runDir}`);
		}
	}

	if (cleanupMarkerBlocksAcquisition(runDir)) {
		throw new Error(`Work run is being cleaned: ${runDir}`);
	}
	const leasesDir = join(runDir, LEASES_DIRECTORY);
	ensureDirectory(leasesDir);
	const markerPath = join(leasesDir, `active-${process.pid}-${randomUUID()}.json`);
	const marker: WorkMarker = { version: 1, hostname: hostname(), pid: process.pid, createdAt: now };
	writeFileSync(markerPath, JSON.stringify(marker), { encoding: "utf8", flag: "wx" });
	if (cleanupMarkerBlocksAcquisition(runDir)) {
		removeFile(markerPath);
		throw new Error(`Work run entered cleanup while it was being acquired: ${runDir}`);
	}
	try {
		utimesSync(runDir, new Date(now), new Date(now));
	} catch {}

	if (options.retention !== false) {
		try {
			pruneWorkTenant(options.agentDir, options.category, options.tenant, options.retention);
		} catch {}
	}

	let released = false;
	return {
		path: runDir,
		category: options.category,
		tenant: options.tenant,
		runId,
		touch(): void {
			if (released) return;
			const touchedAt = new Date();
			try {
				utimesSync(markerPath, touchedAt, touchedAt);
				utimesSync(runDir, touchedAt, touchedAt);
			} catch {}
		},
		release(): void {
			if (released) return;
			released = true;
			removeFile(markerPath);
			try {
				rmdirSync(leasesDir);
			} catch {}
			const touchedAt = new Date();
			try {
				utimesSync(runDir, touchedAt, touchedAt);
			} catch {}
		},
	};
}
