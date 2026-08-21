import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const JSCPD_REPORT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const JSCPD_REPORT_MAX_RETAINED = 3;
export const JSCPD_REPORT_MAX_RETAINED_BYTES = 64 * 1024 * 1024;
export const JSCPD_REPORT_ACTIVE_GRACE_MS = 60 * 60 * 1000;

const OWNED_REPORT_DIRECTORY = /^pi-jscpd-[A-Za-z0-9]{6}$/u;
const REPORT_FILENAME = "jscpd-report.json";
const MAX_SIZE_SCAN_NODES = 10_000;

function directorySizeUpTo(directory, limitBytes) {
	const pending = [directory];
	let nodes = 0;
	let totalBytes = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return limitBytes + 1;
		}
		for (const entry of entries) {
			nodes++;
			if (nodes > MAX_SIZE_SCAN_NODES) return limitBytes + 1;
			const path = join(current, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile()) {
				try {
					totalBytes += statSync(path).size;
				} catch {
					return limitBytes + 1;
				}
				if (totalBytes > limitBytes) return totalBytes;
			}
		}
	}
	return totalBytes;
}

/**
 * Bound failed clone-scan evidence owned by the Pi harness. Young directories may belong to
 * concurrent scans, and explicit/protected directories are never removed.
 */
export function pruneTemporaryJscpdReports(options) {
	const root = resolve(options.root);
	const nowMs = options.nowMs ?? Date.now();
	const maxAgeMs = options.maxAgeMs ?? JSCPD_REPORT_MAX_AGE_MS;
	const maxRetained = options.maxRetained ?? JSCPD_REPORT_MAX_RETAINED;
	const maxRetainedBytes = options.maxRetainedBytes ?? JSCPD_REPORT_MAX_RETAINED_BYTES;
	const activeGraceMs = options.activeGraceMs ?? JSCPD_REPORT_ACTIVE_GRACE_MS;
	if (!Number.isFinite(nowMs)) throw new TypeError("jscpd retention nowMs must be finite");
	if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) {
		throw new TypeError("jscpd retention maxAgeMs must be a positive safe integer");
	}
	if (!Number.isSafeInteger(maxRetained) || maxRetained < 0) {
		throw new TypeError("jscpd retention maxRetained must be a non-negative safe integer");
	}
	if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes < 1) {
		throw new TypeError("jscpd retention maxRetainedBytes must be a positive safe integer");
	}
	if (!Number.isSafeInteger(activeGraceMs) || activeGraceMs < 1) {
		throw new TypeError("jscpd retention activeGraceMs must be a positive safe integer");
	}
	if (!existsSync(root)) return { removedDirectories: [], failures: [] };

	const protectedDirectories = new Set((options.protectedDirectories ?? []).map((directory) => resolve(directory)));
	const candidates = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !OWNED_REPORT_DIRECTORY.test(entry.name)) continue;
		const directory = resolve(root, entry.name);
		if (dirname(directory) !== root || protectedDirectories.has(directory)) continue;
		try {
			const directoryModifiedAt = statSync(directory).mtimeMs;
			let reportModifiedAt = 0;
			try {
				reportModifiedAt = statSync(join(directory, REPORT_FILENAME)).mtimeMs;
			} catch {
				// A crashed scan may leave only its harness-owned directory.
			}
			const modifiedAt = Math.max(directoryModifiedAt, reportModifiedAt);
			const ageMs = Math.max(0, nowMs - modifiedAt);
			candidates.push({
				directory,
				modifiedAt,
				ageMs,
				sizeBytes: directorySizeUpTo(directory, maxRetainedBytes),
			});
		} catch {
			// A concurrent cleanup may remove the directory between enumeration and stat.
		}
	}

	const expired = candidates.filter((candidate) => candidate.ageMs > maxAgeMs);
	const retainedCandidates = candidates
		.filter((candidate) => candidate.ageMs <= maxAgeMs && candidate.ageMs >= activeGraceMs)
		.sort((left, right) => right.modifiedAt - left.modifiedAt);
	let retainedBytes = 0;
	const excess = [];
	for (const [index, candidate] of retainedCandidates.entries()) {
		if (index >= maxRetained || candidate.sizeBytes > maxRetainedBytes - retainedBytes) {
			excess.push(candidate);
			continue;
		}
		retainedBytes += candidate.sizeBytes;
	}
	const removals = new Set([...expired, ...excess].map((candidate) => candidate.directory));
	const removedDirectories = [];
	const failures = [];
	for (const directory of removals) {
		try {
			rmSync(directory, { recursive: true, force: true });
			removedDirectories.push(directory);
		} catch (error) {
			failures.push({ directory, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { removedDirectories, failures };
}
