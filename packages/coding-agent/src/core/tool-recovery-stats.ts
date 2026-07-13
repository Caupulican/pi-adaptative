import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ToolArgumentValidationRecord, ToolArgumentValidationStats } from "./session-analytics.ts";
import {
	isToolArgumentValidationLogRecord,
	type ToolArgumentValidationLogRecord,
} from "./tool-recovery-log-records.ts";

const MAX_DETAIL_KEYS = 1_000;
const MAX_STATS_FILES = 1_000;
const MAX_STATS_FILE_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const OTHER_DETAIL_KEY = "__other__";

interface PersistedToolRecoveryStats {
	version: 1;
	sessionId: string;
	lastRecordSequence: number;
	stats: ToolArgumentValidationStats;
}

export function createEmptyToolArgumentValidationStats(): ToolArgumentValidationStats {
	return {
		clean: 0,
		repaired: 0,
		bounced: 0,
		failureModes: {},
		repairsApplied: {},
		taught: { none: 0, note: 0, rule: 0 },
		executionOutcome: { not_run: 0, succeeded: 0, failed: 0 },
		teachEfficacy: {},
	};
}

function boundedDetailKey(record: Record<string, unknown>, key: string): string {
	if (record[key] !== undefined || Object.keys(record).length < MAX_DETAIL_KEYS - 1) return key;
	return OTHER_DETAIL_KEY;
}

export function consumeToolArgumentValidationRecord(
	stats: ToolArgumentValidationStats,
	record: ToolArgumentValidationRecord,
): void {
	stats[record.outcome] += 1;
	const taught = record.taught ?? "none";
	const executionOutcome = record.executionOutcome ?? "not_run";
	stats.taught[taught] += 1;
	stats.executionOutcome[executionOutcome] += 1;
	const modes = new Set([...record.failureModes, ...record.repairsApplied]);
	for (const mode of record.failureModes) {
		const key = boundedDetailKey(stats.failureModes, mode);
		stats.failureModes[key] = (stats.failureModes[key] ?? 0) + 1;
	}
	for (const repair of record.repairsApplied) {
		const key = boundedDetailKey(stats.repairsApplied, repair);
		stats.repairsApplied[key] = (stats.repairsApplied[key] ?? 0) + 1;
	}
	for (const mode of modes) {
		const key = boundedDetailKey(
			stats.teachEfficacy,
			`${record.provider ?? "unknown"}/${record.model ?? "unknown"}:${mode}`,
		);
		let efficacy = stats.teachEfficacy[key];
		if (!efficacy) {
			efficacy = {
				recurrenceBefore: 0,
				recurrenceAfter: 0,
				repairedThenSucceeded: 0,
				repairedThenFailed: 0,
				repairedThenNotRun: 0,
			};
			stats.teachEfficacy[key] = efficacy;
		}
		if (taught === "none") efficacy.recurrenceBefore++;
		else efficacy.recurrenceAfter++;
	}
	if (record.outcome === "repaired") {
		for (const repair of record.repairsApplied) {
			const key = boundedDetailKey(
				stats.teachEfficacy,
				`${record.provider ?? "unknown"}/${record.model ?? "unknown"}:${repair}`,
			);
			let efficacy = stats.teachEfficacy[key];
			if (!efficacy) {
				efficacy = {
					recurrenceBefore: 0,
					recurrenceAfter: 0,
					repairedThenSucceeded: 0,
					repairedThenFailed: 0,
					repairedThenNotRun: 0,
				};
				stats.teachEfficacy[key] = efficacy;
			}
			if (executionOutcome === "succeeded") efficacy.repairedThenSucceeded++;
			if (executionOutcome === "failed") efficacy.repairedThenFailed++;
			if (executionOutcome === "not_run") efficacy.repairedThenNotRun++;
		}
	}
}

export function getToolRecoveryRecordSequence(
	record: Pick<ToolArgumentValidationLogRecord, "recordId" | "sessionId">,
): number {
	const prefix = `${record.sessionId}:`;
	if (!record.recordId.startsWith(prefix)) return -1;
	const sequence = Number(record.recordId.slice(prefix.length));
	return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : -1;
}

function statsPath(eventLogPath: string, sessionId: string): string {
	const id = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
	return join(dirname(eventLogPath), "tool-recovery-stats", `${id}.json`);
}

function isFiniteCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCountRecord(value: unknown): value is Record<string, number> {
	return !!value && typeof value === "object" && Object.values(value).every(isFiniteCount);
}

function isStatsShape(value: unknown): value is ToolArgumentValidationStats {
	if (!value || typeof value !== "object") return false;
	const stats = value as Partial<ToolArgumentValidationStats>;
	if (!isFiniteCount(stats.clean) || !isFiniteCount(stats.repaired) || !isFiniteCount(stats.bounced)) return false;
	if (!isCountRecord(stats.failureModes) || !isCountRecord(stats.repairsApplied)) return false;
	if (!isCountRecord(stats.taught) || !isCountRecord(stats.executionOutcome)) return false;
	if (!stats.teachEfficacy || typeof stats.teachEfficacy !== "object") return false;
	return Object.values(stats.teachEfficacy).every(
		(value) =>
			!!value &&
			isFiniteCount(value.recurrenceBefore) &&
			isFiniteCount(value.recurrenceAfter) &&
			isFiniteCount(value.repairedThenSucceeded) &&
			isFiniteCount(value.repairedThenFailed) &&
			isFiniteCount(value.repairedThenNotRun),
	);
}

function isPersistedStats(value: unknown, sessionId: string): value is PersistedToolRecoveryStats {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<PersistedToolRecoveryStats>;
	return (
		record.version === 1 &&
		record.sessionId === sessionId &&
		isFiniteCount(record.lastRecordSequence) &&
		isStatsShape(record.stats)
	);
}

export function readPersistedToolRecoveryStats(
	eventLogPath: string,
	sessionId: string,
): PersistedToolRecoveryStats | undefined {
	const path = statsPath(eventLogPath, sessionId);
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return isPersistedStats(parsed, sessionId) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function pruneStatsFiles(directory: string, currentPath: string): void {
	const now = Date.now();
	const files = readdirSync(directory)
		.filter((name) => name.endsWith(".json"))
		.map((name) => {
			const path = join(directory, name);
			return { path, mtimeMs: statSync(path).mtimeMs };
		})
		.sort((left, right) => left.mtimeMs - right.mtimeMs);
	let retained = files.length;
	for (const file of files) {
		if (file.path === currentPath) continue;
		if (retained <= MAX_STATS_FILES && now - file.mtimeMs <= MAX_STATS_FILE_AGE_MS) continue;
		try {
			unlinkSync(file.path);
			retained--;
		} catch {}
	}
}

function writePersistedToolRecoveryStats(eventLogPath: string, summary: PersistedToolRecoveryStats): void {
	const path = statsPath(eventLogPath, summary.sessionId);
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true });
	const isNewSummary = !existsSync(path);
	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, JSON.stringify(summary), "utf-8");
	renameSync(temporaryPath, path);
	if (isNewSummary) pruneStatsFiles(directory, path);
}

export function updatePersistedToolRecoveryStats(eventLogPath: string, record: ToolArgumentValidationLogRecord): void {
	let summary = readPersistedToolRecoveryStats(eventLogPath, record.sessionId);
	if (!summary) {
		summary = {
			version: 1,
			sessionId: record.sessionId,
			lastRecordSequence: -1,
			stats: createEmptyToolArgumentValidationStats(),
		};
		try {
			for (const line of readFileSync(eventLogPath, "utf-8").split("\n")) {
				if (line.trim().length === 0) continue;
				const parsed: unknown = JSON.parse(line);
				if (!isToolArgumentValidationLogRecord(parsed) || parsed.sessionId !== record.sessionId) continue;
				const sequence = getToolRecoveryRecordSequence(parsed);
				if (sequence <= summary.lastRecordSequence) continue;
				consumeToolArgumentValidationRecord(summary.stats, parsed);
				summary.lastRecordSequence = sequence;
			}
		} catch {
			// Fall through and at least account for the current record.
		}
	}
	const sequence = getToolRecoveryRecordSequence(record);
	if (sequence > summary.lastRecordSequence) {
		consumeToolArgumentValidationRecord(summary.stats, record);
		summary.lastRecordSequence = sequence;
	}
	writePersistedToolRecoveryStats(eventLogPath, summary);
}
