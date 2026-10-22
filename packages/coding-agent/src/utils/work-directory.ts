import { randomUUID } from "node:crypto";
import {
	closeSync,
	type Dir,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	opendirSync,
	openSync,
	readSync,
	rmdirSync,
	rmSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { writeFileAtomicSync } from "../core/util/atomic-file.ts";
import { probeProcessLiveness } from "../kernel/reliability/process-tree.ts";

export const PI_WORK_ROOT_ENV = "PI_WORK_ROOT";
export const WORK_RUN_MANIFEST_FILE = ".pi-work-run.json";

const LEASES_DIRECTORY = ".leases";
const HOLDS_DIRECTORY = ".holds";
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
	/**
	 * The bytes the scan counted. A complete scan makes this the run's size; an incomplete one (unreadable, or the shared scan budget ran
	 * out) makes it a lower bound, so a run is never charged for bytes that were not seen: an unmeasured remainder is not evidence of
	 * exceeding the byte limit, while the bytes that were counted are.
	 */
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
	/** Fixed cap for tenant entries visited, including hidden, malformed, and unowned entries. */
	maxScannedRuns?: number;
	now?: number;
}

/**
 * Clamp caller-selected retention to the harness ceiling. Consumers may retain less, but cannot turn
 * a managed work tenant into an unbounded artifact store by raising or disabling these limits.
 */
export function boundedWorkRetention(options: WorkRetentionOptions = {}): WorkRetentionOptions {
	return {
		maxAgeMs: Math.min(nonNegativeLimit(options.maxAgeMs, DEFAULT_MAX_AGE_MS), DEFAULT_MAX_AGE_MS),
		maxRuns: Math.min(nonNegativeLimit(options.maxRuns, DEFAULT_MAX_RUNS), DEFAULT_MAX_RUNS),
		maxTotalBytes: Math.min(
			nonNegativeLimit(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES),
			DEFAULT_MAX_TOTAL_BYTES,
		),
		// The scan limits only bound the work of a prune: at zero a prune would scan nothing and the documented cleanup would never run,
		// so a caller can lower them to one but not switch the cleanup off.
		maxScannedEntries: Math.min(
			Math.max(1, nonNegativeLimit(options.maxScannedEntries, DEFAULT_MAX_SCANNED_ENTRIES)),
			DEFAULT_MAX_SCANNED_ENTRIES,
		),
		maxScannedRuns: Math.min(
			Math.max(1, nonNegativeLimit(options.maxScannedRuns, DEFAULT_MAX_SCANNED_RUNS)),
			DEFAULT_MAX_SCANNED_RUNS,
		),
		now: options.now,
	};
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

export interface WorkRunHold {
	id: string;
	token: string;
}

/** A durable obligation keeps its work evidence beyond the creating process's lifetime. */
export function holdWorkRun(lease: WorkRunLease, hold: WorkRunHold): void {
	const file = workHoldFile(lease, hold);
	if (cleanupMarkerBlocksAcquisition(lease.path)) throw new Error("Work run is being cleaned");
	if (!isManifest(readSmallJson(join(lease.path, WORK_RUN_MANIFEST_FILE)), lease.category, lease.tenant, lease.runId))
		throw new Error("Work hold requires its exact run manifest");
	const directory = join(lease.path, HOLDS_DIRECTORY);
	ensureDirectory(directory);
	const text = JSON.stringify({ version: 1, ...hold });
	if (existsSync(file)) {
		if (readSmallMetadata(file) !== text) throw new Error("Work hold identity changed");
	} else {
		if (readHoldCount(directory) >= MAX_LEASE_MARKERS) throw new Error("Work hold capacity reached");
		writeFileAtomicSync(file, text, { mode: 0o600 });
	}
	if (
		cleanupMarkerBlocksAcquisition(lease.path) ||
		!isManifest(readSmallJson(join(lease.path, WORK_RUN_MANIFEST_FILE)), lease.category, lease.tenant, lease.runId) ||
		readSmallMetadata(file) !== text
	)
		throw new Error("Work hold changed during admission");
}

export function releaseWorkRunHold(lease: WorkRunLease, hold: WorkRunHold): void {
	const directory = join(lease.path, HOLDS_DIRECTORY);
	const file = workHoldFile(lease, hold);
	let value: unknown;
	try {
		value = readSmallJson(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (
		!value ||
		typeof value !== "object" ||
		(value as { version?: unknown }).version !== 1 ||
		(value as { id?: unknown }).id !== hold.id ||
		(value as { token?: unknown }).token !== hold.token
	)
		throw new Error("Work hold identity changed");
	unlinkSync(file);
	try {
		rmdirSync(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (error as NodeJS.ErrnoException).code !== "EEXIST")
			throw error;
	}
}

function workHoldFile(lease: WorkRunLease, hold: WorkRunHold): string {
	assertPortablePathSegment("Work hold id", hold.id);
	if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(hold.token))
		throw new Error("Invalid work hold token");
	return join(lease.path, HOLDS_DIRECTORY, `${hold.id}.${hold.token}.json`);
}

function readHoldCount(directory: string): number {
	const handle = opendirSync(directory);
	let count = 0;
	try {
		while (handle.readSync()) {
			count++;
			if (count >= MAX_LEASE_MARKERS) break;
		}
	} finally {
		handle.closeSync();
	}
	return count;
}

function hasDurableHold(runDir: string): boolean {
	try {
		return readHoldCount(join(runDir, HOLDS_DIRECTORY)) > 0;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

const processWorkRuns = new Map<string, WorkRunLease>();

function nonNegativeLimit(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

export function assertPortablePathSegment(label: string, value: string): void {
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

function readSmallMetadata(path: string): string {
	const stats = lstatSync(path);
	if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_METADATA_BYTES) {
		throw new Error(`Invalid work metadata file: ${path}`);
	}
	const descriptor = openSync(path, "r");
	try {
		const opened = fstatSync(descriptor);
		if (
			!opened.isFile() ||
			opened.size > MAX_METADATA_BYTES ||
			opened.dev !== stats.dev ||
			opened.ino !== stats.ino
		) {
			throw new Error(`Invalid work metadata file: ${path}`);
		}
		const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = readSync(descriptor, buffer, length, buffer.length - length, length);
			if (read === 0) break;
			length += read;
		}
		if (length > MAX_METADATA_BYTES) throw new Error(`Invalid work metadata file: ${path}`);
		return buffer.subarray(0, length).toString("utf8");
	} finally {
		closeSync(descriptor);
	}
}

function readSmallJson(path: string): unknown {
	return JSON.parse(readSmallMetadata(path)) as unknown;
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
		// The canonical liveness owner: only a proven absence (ESRCH) is stale; a probe that could not tell stays unknown and fail-closed.
		const liveness = probeProcessLiveness(value.pid);
		return liveness === "alive" ? "active" : liveness === "dead" ? "stale" : "unknown";
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

/**
 * Report whether a managed run is leased or being cleaned. Stale local markers are removed as part
 * of the check; malformed or foreign-host markers remain fail-closed and count as active.
 */
export function hasActiveWorkRunLease(runDir: string): boolean {
	return cleanupMarkerBlocksAcquisition(runDir) || hasDurableHold(runDir) || hasActiveLease(runDir);
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
			bytes: measured.bytes,
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

/** Names removed per pass of a run's content: bounds what one pass holds, whatever a run has grown to. */
const REMOVAL_BATCH = 256;
/** Passes over a run's content before the removal reaches its fixed work limit. */
const MAX_REMOVAL_PASSES = 1_024;

/**
 * Removes everything in a run except its manifest and the cleanup marker (the fence), in bounded batches read through the directory
 * handle; the handle is closed before any removal.
 */
function removeRunContent(runPath: string): void {
	for (let pass = 0; pass <= MAX_REMOVAL_PASSES; pass++) {
		const names: string[] = [];
		const handle = opendirSync(runPath);
		try {
			while (names.length < REMOVAL_BATCH) {
				const entry = handle.readSync();
				if (!entry) break;
				if (entry.name === WORK_RUN_MANIFEST_FILE || entry.name === CLEANUP_MARKER_FILE) continue;
				names.push(entry.name);
			}
		} finally {
			handle.closeSync();
		}
		if (names.length === 0) return;
		if (pass === MAX_REMOVAL_PASSES) break;
		for (const name of names) rmSync(join(runPath, name), { recursive: true, force: true });
	}
	throw new Error(`Work run content removal exceeded its bounded entry limit: ${runPath}`);
}

function removeRunIfInactive(runPath: string, now: number): boolean {
	const cleanupMarker = createCleanupMarker(runPath, now);
	if (!cleanupMarker) return false;
	if (hasDurableHold(runPath) || hasActiveLease(runPath)) {
		removeFile(cleanupMarker);
		return false;
	}
	const manifestPath = join(runPath, WORK_RUN_MANIFEST_FILE);
	let manifestText: string;
	try {
		manifestText = readSmallMetadata(manifestPath);
		if (
			!isManifest(
				JSON.parse(manifestText),
				basename(dirname(dirname(runPath))),
				basename(dirname(runPath)),
				basename(runPath),
			)
		) {
			throw new Error(`Work directory manifest does not match its path: ${runPath}`);
		}
	} catch (error) {
		let cause = error;
		try {
			unlinkSync(cleanupMarker);
		} catch (fenceError) {
			if ((fenceError as NodeJS.ErrnoException).code !== "ENOENT") {
				cause = new AggregateError(
					[error, fenceError],
					"Work run snapshot failed and its cleanup fence could not be released",
				);
			}
		}
		throw new Error(`Work run ownership could not be snapshotted before removal: ${runPath}`, { cause });
	}
	try {
		// Withdraw ownership before the fence: an acquirer that reaches this gap cannot validate its lease. The non-recursive
		// root removal refuses newly arrived entries instead of deleting a lease or content admitted concurrently.
		removeRunContent(runPath);
		unlinkSync(manifestPath);
		unlinkSync(cleanupMarker);
		rmdirSync(runPath);
		return !existsSync(runPath);
	} catch (removalError) {
		// The final removal can unlink the manifest before it fails on the directory itself: the run is put back under its owner.
		const errors: unknown[] = [removalError];
		if (!existsSync(runPath)) return true;
		try {
			if (!existsSync(manifestPath)) {
				writeFileSync(manifestPath, manifestText, { encoding: "utf8", flag: "wx" });
			}
			if (readSmallMetadata(manifestPath) !== manifestText) {
				throw new Error(`Work run ownership changed during removal recovery: ${runPath}`);
			}
		} catch (restorationError) {
			errors.push(restorationError);
			const recoveryFenceText = JSON.stringify({
				version: 1,
				recoveryIncomplete: true,
				errors: errors.map((error) => (error instanceof Error ? error.message : String(error)).slice(0, 256)),
			});
			try {
				// Invalid marker metadata remains fail-closed even after this process exits. Never release an incomplete recovery's fence.
				writeFileAtomicSync(cleanupMarker, recoveryFenceText);
			} catch (fenceError) {
				errors.push(fenceError);
			}
			throw new AggregateError(errors, `Work run removal recovery is incomplete: ${runPath}`);
		}
		try {
			unlinkSync(cleanupMarker);
		} catch (fenceError) {
			if ((fenceError as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new AggregateError(
					[...errors, fenceError],
					`Work run cleanup fence could not be released: ${runPath}`,
				);
			}
		}
		return false;
	}
}

export function getWorkRoot(agentDir: string): string {
	return join(agentDir, "work");
}

export function getWorkTenantDir(agentDir: string, category: string, tenant: string): string {
	assertPortablePathSegment("Work category", category);
	assertPortablePathSegment("Work tenant", tenant);
	return join(getWorkRoot(agentDir), category, tenant);
}

export function getWorkRunDir(agentDir: string, category: string, tenant: string, runId: string): string {
	assertPortablePathSegment("Work category", category);
	assertPortablePathSegment("Work tenant", tenant);
	assertPortablePathSegment("Work run id", runId);
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
	const runs: InspectedRun[] = [];
	let truncated = false;
	let handle: Dir | undefined;
	try {
		handle = opendirSync(tenantDir);
		let scanned = 0;
		while (true) {
			if (scanned >= maxScannedRuns) {
				truncated = true;
				break;
			}
			const entry = handle.readSync();
			if (!entry) break;
			scanned++;
			if (entry.name.startsWith(".")) continue;
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			const inspected = inspectRun(join(tenantDir, entry.name), category, tenant, entry.name, budget);
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
	// The byte total is what the scans actually counted (lower bounds for incomplete scans): evicting for bytes needs counted excess, so an
	// unmeasured remainder neither pushes the total over the budget nor marks healthy neighbours as over it.
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

/**
 * Release a run's lease and delete its directory. Nothing is removed while another live process
 * still leases the run. Returns whether the directory is gone.
 */
export function removeWorkRun(lease: WorkRunLease): boolean {
	lease.release();
	return removeRunIfInactive(lease.path, Date.now());
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
	const lease = leaseWorkRun(options, false);
	if (!lease) throw new Error("Work run acquisition returned no lease.");
	return lease;
}

/**
 * Lease a run that already exists without creating it, so a reader that depends on another owner's run
 * (a forked session reading its ancestors' stores) keeps it from retention while it is active.
 * Undefined when the run does not exist or is already being removed: nothing is left to keep.
 */
export function acquireExistingWorkRun(options: AcquireWorkRunOptions & { runId: string }): WorkRunLease | undefined {
	return leaseWorkRun(options, true);
}

function leaseWorkRun(options: AcquireWorkRunOptions, existingOnly: boolean): WorkRunLease | undefined {
	const now = options.now ?? Date.now();
	const runId = options.runId ?? createWorkRunId(now);
	assertPortablePathSegment("Work category", options.category);
	assertPortablePathSegment("Work tenant", options.tenant);
	assertPortablePathSegment("Work run id", runId);
	const tenantDir = existingOnly
		? getWorkTenantDir(options.agentDir, options.category, options.tenant)
		: ensureTenantDirectory(options.agentDir, options.category, options.tenant);
	const runDir = join(tenantDir, runId);
	let created = false;
	if (existingOnly) {
		const stats = lstatSync(runDir, { throwIfNoEntry: false });
		if (!stats) return undefined;
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw new Error(`Work run path is not a real directory: ${runDir}`);
		}
		// A run under cleanup may already have lost its manifest; it is going away, not unowned.
		if (cleanupMarkerBlocksAcquisition(runDir)) return undefined;
	} else {
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
		} catch (error) {
			// A missing or malformed manifest means an unowned directory; a read that failed for another reason (EIO, EACCES) says nothing
			// about ownership and keeps its cause.
			const code = (error as NodeJS.ErrnoException).code;
			if (typeof code === "string" && code !== "ENOENT") {
				throw new Error(`Work directory manifest could not be read: ${runDir}`, { cause: error });
			}
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
	const markerText = JSON.stringify(marker);
	writeFileSync(markerPath, markerText, { encoding: "utf8", flag: "wx" });
	try {
		if (cleanupMarkerBlocksAcquisition(runDir)) {
			throw new Error(`Work run entered cleanup while it was being acquired: ${runDir}`);
		}
		// The initial manifest read can precede cleanup. Ownership must still match after the lease is on disk, including the
		// interval after cleanup removed its manifest and fence but before the root directory was removed.
		if (!isManifest(readSmallJson(manifestPath), options.category, options.tenant, runId)) {
			throw new Error(`Work run ownership changed while it was being acquired: ${runDir}`);
		}
		// A cleaner that inspected leases before this marker arrived can remove it, then restore the matching manifest after
		// a refused root removal. Matching ownership alone therefore cannot prove this particular lease survived cleanup.
		if (readSmallMetadata(markerPath) !== markerText) {
			throw new Error(`Work run lease changed while it was being acquired: ${runDir}`);
		}
		try {
			utimesSync(runDir, new Date(now), new Date(now));
		} catch {}
		if (options.retention !== false) {
			pruneWorkTenant(options.agentDir, options.category, options.tenant, options.retention);
		}
	} catch (error) {
		try {
			unlinkSync(markerPath);
		} catch (rollbackError) {
			if ((rollbackError as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new AggregateError(
					[error, rollbackError],
					"Work run acquisition failed and its lease rollback failed",
				);
			}
		}
		throw error;
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
