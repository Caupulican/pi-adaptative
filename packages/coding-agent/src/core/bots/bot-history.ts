/**
 * A bot's earlier conversations, found from its home whatever session is open. Before a bot had a session of its own its
 * conversations ran as worker runtimes of whichever root session messaged it; each runtime's transcript lives under that
 * root's orchestration directory, and which runtime belonged to which bot is recorded only in that root's own transcript
 * (`pi_bot_runtime_bindings` entries). `bots/<id>/history.json` indexes those runs by reference (a path-free transcript
 * reference plus its time range; nothing is copied), so any later session reads the bot's whole conversation.
 *
 * The index is built by one scan of the root session files that finds every bot's direct runtimes in a single pass
 * (streamed, off the render path; the chat shows what it has until the scan is done and the home watch announces the
 * file). The scan is a one-time reading of the conversations bots had before their runs were indexed: once it has run for
 * the agent directory (`state/bots/history-scan.json`), no process scans again, and a bot made later has nothing in the
 * root files to find. Every later worker-path start of a bot adds its own run as it is bound, so the file is refreshed by
 * the writer that creates the run. Concurrent writers merge under the file's lock. The index holds at most
 * `MAX_HISTORY_RUNS` runs, the newest.
 */

import { createReadStream, type Dirent, existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { orchestrationSessionsDir } from "../../kernel/session/session-bundle-paths.ts";
import { SessionManager } from "../../kernel/session/session-manager.ts";
import { workerTranscriptLocation } from "../../kernel/session/worker-storage-identity.ts";
import {
	encodeWorkerTranscriptReference,
	parseWorkerTranscriptReference,
	type WorkerTranscriptIdentity,
} from "../../kernel/session/worker-transcript-reference.ts";
import { sessionsDir as rootSessionsDir } from "../../kernel/storage/paths.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { botHistoryFile, botHistoryScanFile } from "../agent-paths.ts";
import { BOT_RUNTIME_BINDINGS_CUSTOM_TYPE, directBindingAlias, isBotId } from "../delegation/bot-runtime-bindings.ts";
import type { PersistentBotRecord, PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { ensureBotHome } from "./bot-home.ts";

/** Runs one bot's index keeps, the newest. */
export const MAX_HISTORY_RUNS = 200;
/** Messages one read of a bot's history returns, the newest; older ones are left on disk. */
export const MAX_HISTORY_MESSAGES = 4000;
/** Run transcripts whose messages stay cached between reads. */
const RUN_CACHE_LIMIT = 32;
/** A session-file line longer than this is not read for bindings (an embedded image, not an entry that binds). */
const MAX_SCANNED_LINE_BYTES = 64 * 1024 * 1024;
const SCAN_CHUNK_BYTES = 1024 * 1024;
const BINDINGS_MARKER = Buffer.from(BOT_RUNTIME_BINDINGS_CUSTOM_TYPE);

/** One earlier worker conversation of the bot. */
export interface BotHistoryRun {
	/** The path-free transcript reference (`worker-ref:...`): the exact transcript, never found by name. */
	readonly reference: string;
	readonly parentSessionId: string;
	/** The runtime's id: the transcript's logical agent. */
	readonly runtime: string;
	readonly firstAt: number;
	readonly lastAt: number;
}

interface BotHistoryFile {
	readonly version: 1;
	readonly agentId: string;
	/** The one-time scan of the root session files has run for this bot. */
	readonly scanned: boolean;
	readonly runs: readonly BotHistoryRun[];
}

/** What the chat reads: the runs' messages, oldest run first, and whether the index is still being built. */
export interface BotHistoryRead {
	readonly runs: readonly { readonly runtime: string; readonly messages: AgentMessage[] }[];
	readonly pending: boolean;
}

/** What the history reads from the coordinator. */
export interface BotHistoryPorts {
	agentDir(): string;
	store(): Pick<PersistentBotTeamStore, "getBot" | "listBots">;
	warn(message: string): void;
}

function isRun(value: unknown): value is BotHistoryRun {
	return (
		isPlainRecord(value) &&
		typeof value.reference === "string" &&
		typeof value.parentSessionId === "string" &&
		typeof value.runtime === "string" &&
		typeof value.firstAt === "number" &&
		typeof value.lastAt === "number" &&
		parseWorkerTranscriptReference(value.reference) !== undefined
	);
}

function readHistoryFile(agentDir: string, agentId: string): BotHistoryFile | undefined {
	const file = botHistoryFile(agentDir, agentId);
	if (!existsSync(file)) return undefined;
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!isPlainRecord(value) || value.version !== 1 || !Array.isArray(value.runs)) return undefined;
		return { version: 1, agentId, scanned: value.scanned === true, runs: value.runs.filter(isRun) };
	} catch {
		return undefined;
	}
}

/** The one scan of the root session files has run for this agent directory (see the module comment). */
function rootScanDone(agentDir: string): boolean {
	return existsSync(botHistoryScanFile(agentDir));
}

/** The runs of both lists, one per transcript (the later times win), oldest first, bounded to the newest. */
function mergeRuns(first: readonly BotHistoryRun[], second: readonly BotHistoryRun[]): BotHistoryRun[] {
	const byReference = new Map<string, BotHistoryRun>();
	for (const run of [...first, ...second]) {
		const known = byReference.get(run.reference);
		byReference.set(
			run.reference,
			known
				? { ...run, firstAt: Math.min(known.firstAt, run.firstAt), lastAt: Math.max(known.lastAt, run.lastAt) }
				: run,
		);
	}
	return [...byReference.values()].sort((a, b) => a.firstAt - b.firstAt).slice(-MAX_HISTORY_RUNS);
}

/**
 * The run a transcript identity names, with its time range from the file; undefined when the transcript is not on disk.
 * `present`, when given, is every worker transcript on disk: a transcript it lacks is not looked for.
 */
function runOf(
	agentDir: string,
	identity: WorkerTranscriptIdentity,
	present?: ReadonlySet<string>,
): BotHistoryRun | undefined {
	let location: ReturnType<typeof workerTranscriptLocation>;
	try {
		location = workerTranscriptLocation(agentDir, identity);
	} catch {
		// An id that cannot name a transcript location names no transcript.
		return undefined;
	}
	if (present && !present.has(location.sessionFile)) return undefined;
	const stat = statSync(location.sessionFile, { throwIfNoEntry: false });
	if (!stat?.isFile()) return undefined;
	return {
		reference: encodeWorkerTranscriptReference(identity),
		parentSessionId: identity.parentSessionId,
		runtime: identity.logicalAgentId,
		firstAt: stat.birthtimeMs > 0 ? Math.min(stat.birthtimeMs, stat.mtimeMs) : stat.mtimeMs,
		lastAt: stat.mtimeMs,
	};
}

/** Rewrites the bot's index from `update(current)` under its lock, only when the content changed. */
function saveHistory(
	agentDir: string,
	record: PersistentBotRecord,
	update: (current: BotHistoryFile) => BotHistoryFile,
): void {
	ensureBotHome(agentDir, record);
	const file = botHistoryFile(agentDir, record.agentId);
	withFileLockSync(file, () => {
		const current = readHistoryFile(agentDir, record.agentId) ?? {
			version: 1 as const,
			agentId: record.agentId,
			scanned: false,
			runs: [],
		};
		const next = update(current);
		const text = `${JSON.stringify(next, null, 1)}\n`;
		if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileAtomicSync(file, text, { mode: 0o600 });
	});
}

/** Every `.jsonl` file under `dir`, the root session files. */
async function listSessionFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	const pending = [dir];
	while (pending.length > 0) {
		const current = pending.pop()!;
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		}
	}
	return files;
}

/**
 * Calls `onLine` with each line of the file that holds `marker`, and `onFirst` with the first line, streaming the file.
 * An abort ends the read at the next chunk.
 */
async function scanLines(
	file: string,
	marker: Buffer,
	signal: AbortSignal,
	onFirst: (line: string) => void,
	onLine: (line: string) => void,
): Promise<void> {
	let pieces: Buffer[] = [];
	let length = 0;
	let skipping = false;
	let first = true;
	const finish = () => {
		if (!skipping) {
			const line = pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces);
			if (first && line.length < 64 * 1024) onFirst(line.toString("utf8"));
			if (line.indexOf(marker) !== -1) onLine(line.toString("utf8"));
		}
		first = false;
		pieces = [];
		length = 0;
		skipping = false;
	};
	for await (const chunk of createReadStream(file, { highWaterMark: SCAN_CHUNK_BYTES })) {
		signal.throwIfAborted();
		const buffer = chunk as Buffer;
		let start = 0;
		for (;;) {
			const newline = buffer.indexOf(10, start);
			const end = newline === -1 ? buffer.length : newline;
			if (!skipping) {
				length += end - start;
				if (length > MAX_SCANNED_LINE_BYTES) {
					skipping = true;
					pieces = [];
				} else pieces.push(buffer.subarray(start, end));
			}
			if (newline === -1) break;
			finish();
			start = newline + 1;
		}
	}
	if (length > 0 || pieces.length > 0) finish();
}

/**
 * What one scan of the root session files found: each alias's direct runtimes with their parent root, every root's id,
 * and every worker transcript on disk (the candidates are matched against it rather than each looked for).
 */
interface RootScan {
	readonly bound: Map<string, WorkerTranscriptIdentity[]>;
	readonly rootIds: Set<string>;
	readonly transcripts: ReadonlySet<string>;
}

/** Every worker transcript file under the orchestration bundles: one listing per bundle. */
async function listWorkerTranscripts(agentDir: string, signal: AbortSignal): Promise<Set<string>> {
	const files = new Set<string>();
	const root = orchestrationSessionsDir(agentDir);
	const listing = async (dir: string): Promise<Dirent[]> => {
		try {
			return await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	};
	for (const bundle of await listing(root)) {
		signal.throwIfAborted();
		if (!bundle.isDirectory()) continue;
		const dir = join(root, bundle.name, "worker-conversations");
		for (const entry of await listing(dir))
			if (entry.isFile() && entry.name.endsWith(".jsonl")) files.add(resolve(dir, entry.name));
	}
	return files;
}

async function scanRootSessions(
	agentDir: string,
	warn: (message: string) => void,
	signal: AbortSignal,
): Promise<RootScan> {
	const bound = new Map<string, WorkerTranscriptIdentity[]>();
	const rootIds = new Set<string>();
	for (const file of await listSessionFiles(rootSessionsDir(agentDir))) {
		signal.throwIfAborted();
		try {
			await scanLines(
				file,
				BINDINGS_MARKER,
				signal,
				(line) => {
					try {
						const header: unknown = JSON.parse(line);
						if (isPlainRecord(header) && header.type === "session" && typeof header.id === "string")
							rootIds.add(header.id);
					} catch {
						// A first line that is not a header names no root.
					}
				},
				(line) => {
					let entry: unknown;
					try {
						entry = JSON.parse(line);
					} catch {
						return;
					}
					if (
						!isPlainRecord(entry) ||
						entry.type !== "custom" ||
						entry.customType !== BOT_RUNTIME_BINDINGS_CUSTOM_TYPE ||
						!isPlainRecord(entry.data) ||
						typeof entry.data.sessionId !== "string" ||
						!isPlainRecord(entry.data.bindings)
					)
						return;
					const parentSessionId = entry.data.sessionId;
					for (const [key, runtime] of Object.entries(entry.data.bindings)) {
						const alias = directBindingAlias(key);
						if (alias === undefined || typeof runtime !== "string") continue;
						const list = bound.get(alias) ?? [];
						list.push({ parentSessionId, logicalAgentId: runtime });
						bound.set(alias, list);
					}
				},
			);
		} catch (error) {
			if (signal.aborted) throw error;
			warn(
				`Bot history: a session file could not be read (${error instanceof Error ? error.message : String(error)}).`,
			);
		}
	}
	return { bound, rootIds, transcripts: await listWorkerTranscripts(agentDir, signal) };
}

/** The runs of one bot the scan and its record name that exist on disk. */
function runsFromScan(agentDir: string, record: PersistentBotRecord, scan: RootScan): BotHistoryRun[] {
	const identities: WorkerTranscriptIdentity[] = [...(scan.bound.get(record.agentId) ?? [])];
	// A bot started before runtimes were bound ran under its own alias.
	if (isBotId(record.agentId))
		for (const rootId of scan.rootIds) identities.push({ parentSessionId: rootId, logicalAgentId: record.agentId });
	const last = record.lastTranscriptRef ? parseWorkerTranscriptReference(record.lastTranscriptRef) : undefined;
	if (last) identities.push(last);
	const runs: BotHistoryRun[] = [];
	for (const identity of identities) {
		const run = runOf(agentDir, identity, scan.transcripts);
		if (run) runs.push(run);
	}
	return mergeRuns([], runs);
}

/** Reads and keeps the index of each bot's earlier conversations (see the module comment). */
export class BotHistory {
	private readonly ports: BotHistoryPorts;
	/** The scan in flight, joined by `stop`. */
	private scan: Promise<void> | undefined;
	private readonly stopping = new AbortController();
	private readonly cache = new Map<string, { mtimeMs: number; size: number; messages: AgentMessage[] }>();

	constructor(ports: BotHistoryPorts) {
		this.ports = ports;
	}

	/** The bot's earlier conversations, read from disk; starts the one-time scan when the bot has no finished index. */
	read(agentId: string): BotHistoryRead {
		const agentDir = this.ports.agentDir();
		const index = readHistoryFile(agentDir, agentId);
		const pending = index?.scanned !== true && !rootScanDone(agentDir);
		if (pending) this.requestScan();
		const runs: { runtime: string; messages: AgentMessage[] }[] = [];
		let remaining = MAX_HISTORY_MESSAGES;
		for (const run of [...(index?.runs ?? [])].reverse()) {
			if (remaining <= 0) break;
			const messages = this.runMessages(agentDir, run);
			if (!messages) continue;
			const kept = messages.length > remaining ? messages.slice(messages.length - remaining) : messages;
			remaining -= kept.length;
			runs.unshift({ runtime: run.runtime, messages: kept });
		}
		return { runs, pending };
	}

	/** A worker-path start of the bot's direct conversation was bound: its run joins the index. */
	noteRun(agentId: string, parentSessionId: string, runtime: string): void {
		const record = this.ports.store().getBot(agentId);
		if (!record || record.remote) return;
		const identity = { parentSessionId, logicalAgentId: runtime };
		const now = Date.now();
		saveHistory(this.ports.agentDir(), record, (current) => ({
			...current,
			runs: mergeRuns(current.runs, [
				{
					reference: encodeWorkerTranscriptReference(identity),
					parentSessionId,
					runtime,
					firstAt: now,
					lastAt: now,
				},
			]),
		}));
	}

	/** One pass over the root session files builds the index of every local bot that has none. */
	private requestScan(): void {
		const { signal } = this.stopping;
		if (this.scan || signal.aborted) return;
		const agentDir = this.ports.agentDir();
		if (rootScanDone(agentDir)) return;
		const wanted = this.ports
			.store()
			.listBots({ includeRetired: true })
			.filter((record) => !record.remote && readHistoryFile(agentDir, record.agentId)?.scanned !== true);
		if (wanted.length === 0) return;
		this.scan = scanRootSessions(agentDir, (message) => this.ports.warn(message), signal)
			.then((found) => {
				if (signal.aborted) return;
				for (const record of wanted) {
					const runs = runsFromScan(agentDir, record, found);
					saveHistory(agentDir, record, (current) => ({
						...current,
						scanned: true,
						runs: mergeRuns(current.runs, runs),
					}));
				}
				// Written after every bot's index: a scan cut short leaves no mark, and the next process scans again.
				writeFileAtomicSync(
					botHistoryScanFile(agentDir),
					`${JSON.stringify({ version: 1, scannedAt: Date.now() })}\n`,
					{
						mode: 0o600,
					},
				);
				harnessLog.info("bots", "bot histories were indexed", () => ({ bots: wanted.length }));
			})
			.catch((error: unknown) => {
				// The index stays unfinished: the next read of a bot without one scans again. A stopped scan is not a failure.
				if (signal.aborted) return;
				this.ports.warn(
					`Bot history could not be indexed (${error instanceof Error ? error.message : String(error)}).`,
				);
			})
			.finally(() => {
				// A finished scan left its mark (`rootScanDone`); an unfinished one is requested again by the next read.
				this.scan = undefined;
			});
	}

	/** The run transcript's messages, read without opening it for writing; undefined when it is not on disk. */
	private runMessages(agentDir: string, run: BotHistoryRun): AgentMessage[] | undefined {
		const identity = parseWorkerTranscriptReference(run.reference);
		if (!identity) return undefined;
		const { sessionFile } = workerTranscriptLocation(agentDir, identity);
		const stat = statSync(sessionFile, { throwIfNoEntry: false });
		if (!stat?.isFile()) return undefined;
		const cached = this.cache.get(sessionFile);
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return [...cached.messages];
		let messages: AgentMessage[];
		try {
			messages = SessionManager.openReadOnly(sessionFile, agentDir).buildSessionContext().messages;
		} catch (error) {
			this.ports.warn(
				`Bot history: an earlier conversation could not be read (${error instanceof Error ? error.message : String(error)}).`,
			);
			return undefined;
		}
		if (this.cache.size >= RUN_CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
		this.cache.set(sessionFile, { mtimeMs: stat.mtimeMs, size: stat.size, messages });
		return [...messages];
	}

	/** Stops the scan in flight and resolves once it ended; no scan starts after it. */
	stop(): Promise<void> {
		this.stopping.abort();
		this.cache.clear();
		return this.scan ?? Promise.resolve();
	}
}
