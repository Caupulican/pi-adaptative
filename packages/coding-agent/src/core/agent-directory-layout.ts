import { type Dir, existsSync, opendirSync } from "node:fs";
import { resolve } from "node:path";
import { isCanonicalAgentRootEntry } from "./agent-paths.ts";

const MAX_SCANNED_ROOT_ENTRIES = 10_000;
const MAX_REPORTED_ROOT_ENTRIES = 64;

export interface AgentDirectoryLayoutReport {
	readonly agentDir: string;
	readonly scannedEntries: number;
	readonly unexpectedEntryCount: number;
	readonly unexpectedEntries: readonly string[];
	readonly truncated: boolean;
	readonly error?: string;
}

export interface InspectAgentDirectoryLayoutOptions {
	maxScannedEntries?: number;
	maxReportedEntries?: number;
}

function boundedLimit(value: number | undefined, ceiling: number): number {
	if (value === undefined || !Number.isFinite(value)) return ceiling;
	return Math.max(0, Math.min(Math.floor(value), ceiling));
}

/** Read-only, fixed-budget audit of entries directly beside the agent's critical root files. */
export function inspectAgentDirectoryLayout(
	agentDir: string,
	options: InspectAgentDirectoryLayoutOptions = {},
): AgentDirectoryLayoutReport {
	const resolvedAgentDir = resolve(agentDir);
	if (!existsSync(resolvedAgentDir)) {
		return {
			agentDir: resolvedAgentDir,
			scannedEntries: 0,
			unexpectedEntryCount: 0,
			unexpectedEntries: [],
			truncated: false,
		};
	}

	const maxScannedEntries = boundedLimit(options.maxScannedEntries, MAX_SCANNED_ROOT_ENTRIES);
	const maxReportedEntries = boundedLimit(options.maxReportedEntries, MAX_REPORTED_ROOT_ENTRIES);
	const unexpectedEntries: string[] = [];
	let unexpectedEntryCount = 0;
	let scannedEntries = 0;
	let truncated = false;
	let handle: Dir | undefined;
	try {
		handle = opendirSync(resolvedAgentDir);
		while (true) {
			const entry = handle.readSync();
			if (!entry) break;
			if (scannedEntries >= maxScannedEntries) {
				truncated = true;
				break;
			}
			scannedEntries++;
			if (isCanonicalAgentRootEntry(entry.name)) continue;
			unexpectedEntryCount++;
			if (unexpectedEntries.length < maxReportedEntries) unexpectedEntries.push(entry.name);
		}
	} catch (error) {
		return {
			agentDir: resolvedAgentDir,
			scannedEntries,
			unexpectedEntryCount,
			unexpectedEntries: unexpectedEntries.sort(),
			truncated,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		try {
			handle?.closeSync();
		} catch {}
	}

	return {
		agentDir: resolvedAgentDir,
		scannedEntries,
		unexpectedEntryCount,
		unexpectedEntries: unexpectedEntries.sort(),
		truncated,
	};
}
