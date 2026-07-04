import * as fs from "node:fs";
import { basename, join } from "node:path";
import { loadEntriesFromFile, type SessionEntry } from "@caupulican/pi-agent-core/node";
import type { AssistantMessage, Usage } from "@caupulican/pi-ai";
import { SPAWNED_USAGE_CUSTOM_TYPE, type SpawnedUsageReport } from "../agent-session.ts";

function isUsage(value: unknown): value is Usage {
	if (!value || typeof value !== "object") return false;
	const usage = value as Partial<Usage>;
	const cost = usage.cost as Partial<Usage["cost"]> | undefined;
	return (
		typeof usage.input === "number" &&
		typeof usage.output === "number" &&
		typeof usage.cacheRead === "number" &&
		typeof usage.cacheWrite === "number" &&
		typeof usage.totalTokens === "number" &&
		!!cost &&
		typeof cost.input === "number" &&
		typeof cost.output === "number" &&
		typeof cost.cacheRead === "number" &&
		typeof cost.cacheWrite === "number" &&
		typeof cost.total === "number"
	);
}

export function readAutoLearnSessionIdFromFile(filePath: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const buffer = Buffer.alloc(64 * 1024);
		const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
		const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0]?.trim();
		if (!firstLine) return undefined;
		const header = JSON.parse(firstLine) as Record<string, unknown>;
		return header.type === "session" && typeof header.id === "string" ? header.id : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Ignore close errors
			}
		}
	}
}

export function findChildSessionFile(sessionDir: string, sessionId: string): string | undefined {
	if (!fs.existsSync(sessionDir)) return undefined;

	const jsonlFiles: string[] = [];

	function collectJsonlFiles(dirPath: string) {
		let currentEntries: fs.Dirent[];
		try {
			currentEntries = fs.readdirSync(dirPath, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of currentEntries) {
			const fullPath = join(dirPath, entry.name);
			if (entry.isDirectory()) {
				collectJsonlFiles(fullPath);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				jsonlFiles.push(fullPath);
			}
		}
	}

	collectJsonlFiles(sessionDir);

	for (const file of jsonlFiles) {
		const base = basename(file);
		if (base === `${sessionId}.jsonl` || base.endsWith(`_${sessionId}.jsonl`)) {
			return file;
		}
	}

	for (const file of jsonlFiles) {
		const headerId = readAutoLearnSessionIdFromFile(file);
		if (headerId === sessionId) {
			return file;
		}
	}

	return undefined;
}

export function aggregateCumulativeUsageFromSessionEntries(entries: SessionEntry[]): Usage {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalTokens = 0;
	let costInput = 0;
	let costOutput = 0;
	let costCacheRead = 0;
	let costCacheWrite = 0;
	let costTotal = 0;

	const add = (usage: Usage) => {
		input += usage.input;
		output += usage.output;
		cacheRead += usage.cacheRead;
		cacheWrite += usage.cacheWrite;
		totalTokens += usage.totalTokens;
		costInput += usage.cost.input;
		costOutput += usage.cost.output;
		costCacheRead += usage.cost.cacheRead;
		costCacheWrite += usage.cost.cacheWrite;
		costTotal += usage.cost.total;
	};

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = (entry.message as AssistantMessage).usage;
			if (usage && isUsage(usage)) {
				add(usage);
			}
		} else if (entry.type === "custom" && entry.customType === SPAWNED_USAGE_CUSTOM_TYPE) {
			const data = entry.data as SpawnedUsageReport | undefined;
			if (data?.usage && isUsage(data.usage)) {
				add(data.usage);
			}
		}
	}

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: {
			input: costInput,
			output: costOutput,
			cacheRead: costCacheRead,
			cacheWrite: costCacheWrite,
			total: costTotal,
		},
	};
}

export function reportCompletedAutoLearnUsageHelper(args: {
	runId: string;
	sessionDir: string;
	sessionId: string;
	logPath?: string;
	parentSession: {
		addSpawnedUsage: (
			usage: Usage,
			opts: { label: string; sourceSessionId: string; reportId: string },
		) => string | undefined;
	};
	appendLog?: (logPath: string, message: string) => void;
}): void {
	const { runId, sessionDir, sessionId, logPath, parentSession, appendLog } = args;
	const sessionFile = findChildSessionFile(sessionDir, sessionId);
	if (!sessionFile) {
		if (logPath && appendLog) {
			appendLog(logPath, `Auto Learn usage report skipped: no child session file found for ${sessionId}.`);
		}
		return;
	}
	const fileEntries = loadEntriesFromFile(sessionFile);
	const sessionEntries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
	const usage = aggregateCumulativeUsageFromSessionEntries(sessionEntries);
	if (usage.cost.total === 0 && usage.totalTokens === 0) {
		if (logPath && appendLog) {
			appendLog(logPath, `Auto Learn usage report skipped: child session had no usage for ${sessionId}.`);
		}
		return;
	}
	parentSession.addSpawnedUsage(usage, {
		label: "auto-learn",
		sourceSessionId: sessionId,
		reportId: `auto-learn:${runId}:${sessionId}`,
	});
	if (logPath && appendLog) {
		appendLog(logPath, `Auto Learn usage reported: ${sessionId}.`);
	}
}
