import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const LEASES_DIRECTORY = ".leases";
const ACTIVE_MARKER_PREFIX = "active-";
const ACTIVE_MARKER_SUFFIX = ".json";
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
	release(): void;
}

interface SessionDirectory {
	path: string;
	mtimeMs: number;
	bytes: number;
	active: boolean;
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function directoryBytes(path: string): number {
	let total = 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		try {
			if (entry.isDirectory()) total += directoryBytes(child);
			else total += lstatSync(child).size;
		} catch {
			// Concurrent cleanup or an unreadable entry is ignored by best-effort retention.
		}
	}
	return total;
}

function markerProcessIsAlive(path: string): boolean {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as { pid?: unknown };
		if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) return false;
		try {
			process.kill(parsed.pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	} catch {
		return false;
	}
}

function cleanupStaleLeases(rootDir: string): void {
	const leasesRoot = join(rootDir, LEASES_DIRECTORY);
	if (!existsSync(leasesRoot)) return;
	for (const entry of readdirSync(leasesRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const leaseDir = join(leasesRoot, entry.name);
		try {
			for (const marker of readdirSync(leaseDir)) {
				const markerPath = join(leaseDir, marker);
				if (!markerProcessIsAlive(markerPath)) unlinkSync(markerPath);
			}
			rmdirSync(leaseDir);
		} catch {
			// A live marker or concurrent lease keeps the directory in place.
		}
	}
}

function inspectSessionDirectories(rootDir: string): SessionDirectory[] {
	if (!existsSync(rootDir)) return [];
	cleanupStaleLeases(rootDir);
	const directories: SessionDirectory[] = [];
	for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === LEASES_DIRECTORY) continue;
		const path = join(rootDir, entry.name);
		try {
			const leaseDir = join(rootDir, LEASES_DIRECTORY, entry.name);
			const markerPaths = existsSync(leaseDir)
				? readdirSync(leaseDir)
						.filter((name) => name.startsWith(ACTIVE_MARKER_PREFIX) && name.endsWith(ACTIVE_MARKER_SUFFIX))
						.map((name) => join(leaseDir, name))
				: [];
			directories.push({
				path,
				mtimeMs: Math.max(statSync(path).mtimeMs, ...markerPaths.map((markerPath) => statSync(markerPath).mtimeMs)),
				bytes: directoryBytes(path),
				active: markerPaths.some(markerProcessIsAlive),
			});
		} catch {
			// Ignore a directory that disappeared or became unreadable during the scan.
		}
	}
	return directories;
}

export function pruneContextStoreRoot(rootDir: string, options: ContextStoreRetentionOptions = {}): string[] {
	const now = options.now ?? Date.now();
	const maxAgeMs = positiveLimit(options.maxAgeMs, DEFAULT_MAX_AGE_MS);
	const maxSessionDirs = positiveLimit(options.maxSessionDirs, DEFAULT_MAX_SESSION_DIRS);
	const maxTotalBytes = positiveLimit(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
	const directories = inspectSessionDirectories(rootDir);
	const removed: string[] = [];
	let retainedCount = directories.length;
	let retainedBytes = directories.reduce((sum, directory) => sum + directory.bytes, 0);
	for (const directory of directories.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
		if (directory.active) continue;
		const expired = now - directory.mtimeMs > maxAgeMs;
		const overCount = retainedCount > maxSessionDirs;
		const overBytes = retainedBytes > maxTotalBytes;
		if (!expired && !overCount && !overBytes) continue;
		try {
			rmSync(directory.path, { recursive: true, force: true });
			removed.push(directory.path);
			retainedCount--;
			retainedBytes -= directory.bytes;
		} catch {
			// Retention is best-effort and must never block a live session.
		}
	}
	return removed;
}

export function acquireContextStoreRetention(
	agentDir: string,
	sessionId: string,
	options: ContextStoreRetentionOptions = {},
): ContextStoreRetentionLease {
	if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return { release: () => {} };
	const roots = [join(agentDir, "context-gc"), join(agentDir, "context-artifacts")];
	const markerPaths: string[] = [];
	for (const root of roots) {
		const sessionDir = join(root, sessionId);
		try {
			mkdirSync(sessionDir, { recursive: true });
			const leaseDir = join(root, LEASES_DIRECTORY, sessionId);
			mkdirSync(leaseDir, { recursive: true });
			const markerPath = join(
				leaseDir,
				`${ACTIVE_MARKER_PREFIX}${process.pid}-${randomUUID()}${ACTIVE_MARKER_SUFFIX}`,
			);
			writeFileSync(markerPath, JSON.stringify({ pid: process.pid, touchedAt: Date.now() }), "utf-8");
			markerPaths.push(markerPath);
			pruneContextStoreRoot(root, options);
		} catch {
			// Retention is best-effort; the caller can still use its normal store path.
		}
	}
	let released = false;
	return {
		release(): void {
			if (released) return;
			released = true;
			for (const markerPath of markerPaths) {
				try {
					unlinkSync(markerPath);
					rmdirSync(dirname(markerPath));
				} catch {}
			}
		},
	};
}
