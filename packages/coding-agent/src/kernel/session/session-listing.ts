/** Session discovery and listing: the most recent session lookup, bounded-concurrency session info loading, and the per-directory session file listing. */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Message, TextContent } from "@caupulican/pi-ai/types";
import type { AgentMessage } from "../types.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { isSessionLifecycleEntry } from "./lifecycle-ledger.ts";
import type { SessionMessageEntry } from "./session-entries.ts";
import {
	getSessionHeaderCwd,
	parseSessionEntryLine,
	readSessionHeader,
	sessionCwdMatches,
} from "./session-file-reading.ts";
import { readSessionHeaderResult, type SessionHeader } from "./session-header.ts";
import { isAutoLearnSessionId } from "./session-id-generation.ts";
import type { FileEntry, SessionInfo } from "./session-manager-types.ts";

/** Exported for testing */
export function findMostRecentSession(
	sessionDir: string,
	cwd?: string,
	skip?: (sessionId: string) => boolean,
): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	const resolvedCwd = cwd ? resolvePath(cwd) : undefined;
	try {
		const files = readdirSync(resolvedSessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(resolvedSessionDir, f))
			.map((path) => ({ path, header: readSessionHeader(path) }))
			.filter(
				(file): file is { path: string; header: SessionHeader } =>
					file.header !== null &&
					!isAutoLearnSessionId(file.header.id) &&
					(!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(file.header), resolvedCwd)) &&
					!skip?.(file.header.id),
			)
			.flatMap(({ path }) => {
				try {
					return [{ path, mtime: statSync(path).mtime }];
				} catch {
					return [];
				}
			})
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files[0]?.path || null;
	} catch {
		return null;
	}
}

export function findMostRecentSessionInDirs(
	sessionDirs: string[],
	cwd?: string,
	skip?: (sessionId: string) => boolean,
): string | null {
	let mostRecent: { path: string; mtime: number } | null = null;
	for (const dir of sessionDirs) {
		const sessionPath = findMostRecentSession(dir, cwd, skip);
		if (!sessionPath) continue;
		try {
			const mtime = statSync(sessionPath).mtime.getTime();
			if (!mostRecent || mtime > mostRecent.mtime) {
				mostRecent = { path: sessionPath, mtime };
			}
		} catch {
			// Ignore races/deleted files
		}
	}
	return mostRecent?.path ?? null;
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

const MAX_SESSION_SEARCH_TEXT_CHARS = 20_000;

function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
	const message = entry.message;
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return msgTimestamp;
	}

	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	try {
		// The header is admitted exactly as the open path admits it: a file whose header id is not a valid session id is not
		// listed, since opening it would be refused.
		if (!readSessionHeaderResult(filePath).ok) return null;
		const stats = await stat(filePath);
		let header: SessionHeader | null = null;
		let messageCount = 0;
		let firstMessage = "";
		let allMessagesText = "";
		let name: string | undefined;
		let lastActivityTime: number | undefined;

		const appendSearchText = (text: string) => {
			if (!text || allMessagesText.length >= MAX_SESSION_SEARCH_TEXT_CHARS) return;
			const prefix = allMessagesText.length === 0 ? "" : " ";
			const remaining = MAX_SESSION_SEARCH_TEXT_CHARS - allMessagesText.length - prefix.length;
			if (remaining <= 0) return;
			allMessagesText += `${prefix}${text.slice(0, remaining)}`;
		};

		const rl = createInterface({
			input: createReadStream(filePath, { encoding: "utf8" }),
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			const entry = parseSessionEntryLine(line);
			if (!entry) continue;

			if (!header) {
				if (entry.type !== "session") return null;
				header = entry;
				continue;
			}

			// Extract session name (use latest, including explicit clears)
			if (entry.type === "session_info") {
				name = entry.name?.trim() || undefined;
				continue;
			}

			if (entry.type !== "message") continue;
			messageCount++;

			const activityTime = getMessageActivityTime(entry);
			if (typeof activityTime === "number") {
				lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			}

			const message = entry.message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			appendSearchText(textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		if (!header || isAutoLearnSessionId(header.id)) return null;
		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = header.parentSession;
		const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
		const modified =
			typeof lastActivityTime === "number" && lastActivityTime > 0
				? new Date(lastActivityTime)
				: !Number.isNaN(headerTime)
					? new Date(headerTime)
					: stats.mtime;

		return {
			path: filePath,
			id: header.id,
			cwd,
			name,
			parentSessionPath,
			created: new Date(header.timestamp),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText,
		};
	} catch {
		return null;
	}
}

export type SessionListProgress = (loaded: number, total: number) => void;

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

export async function buildSessionInfosWithConcurrency(
	files: string[],
	onLoaded: () => void,
): Promise<(SessionInfo | null)[]> {
	const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const inFlight = new Set<Promise<void>>();
	let nextIndex = 0;

	const startNext = (): void => {
		const index = nextIndex++;
		const file = files[index];
		if (!file) return;

		let task: Promise<void>;
		task = buildSessionInfo(file)
			.then((info) => {
				results[index] = info;
			})
			.catch(() => {
				results[index] = null;
			})
			.finally(() => {
				inFlight.delete(task);
				onLoaded();
			});
		inFlight.add(task);
	};

	while (nextIndex < files.length || inFlight.size > 0) {
		while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
			startNext();
		}
		if (inFlight.size > 0) {
			await Promise.race(inFlight);
		}
	}

	return results;
}

export async function countSessionFiles(dir: string): Promise<number> {
	if (!existsSync(dir)) return 0;
	try {
		const dirEntries = await readdir(dir);
		return dirEntries.filter((f) => f.endsWith(".jsonl")).length;
	} catch {
		return 0;
	}
}

export async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	progressOffset = 0,
	progressTotal?: number,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) {
		return sessions;
	}

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
		const total = progressTotal ?? files.length;

		let loaded = 0;
		const results = await buildSessionInfosWithConcurrency(files, () => {
			loaded++;
			onProgress?.(progressOffset + loaded, total);
		});
		for (const info of results) {
			if (info) {
				sessions.push(info);
			}
		}
	} catch {
		// Return empty list on error
	}

	return sessions;
}

/**
 * Entries that require physical persistence before publication. Owner input must be durable before its
 * delivery releases recovery custody, even when the session has no reply yet.
 */
export function requiresSessionFile(entry: FileEntry): boolean {
	if (entry.type === "session") return false;
	return (
		(entry.type === "message" &&
			(entry.ownerInputId !== undefined ||
				entry.message.role === "assistant" ||
				entry.message.role === "bashExecution")) ||
		isSessionLifecycleEntry(entry) ||
		(entry.type === "custom" && entry.customType === "continuous_chat_work_report")
	);
}
