/**
 * Process-matrix on-disk store: one file per process (`state/process-matrix/<entryId>.json`),
 * durable across restarts and crashes (see `agent-paths.ts` -- this is machine state, not
 * transient `work/`).
 *
 * Each entry is owned by the process it describes: a master writes and heartbeats its OWN entry,
 * a worker self-registers and heartbeats its OWN entry (see `runtime.ts`'s module doc for the one
 * sanctioned, ask-gated exception during orphan adoption/cleanup). A missing or corrupt entry file
 * reads as absent -- never an error -- matching `worktree-sync/store.ts`'s store doctrine.
 */

import { promises as fsPromises, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { stateFile } from "../agent-paths.ts";
import { isAgentIdentity } from "../orchestration/agent-resume.ts";
import { withFileLock, withFileLockSync, writeFileAtomic, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { ProcessMatrixEntry, ProcessRole, ProcessStatus } from "./codes.ts";

function isProcessStatus(value: unknown): value is ProcessStatus {
	return (
		value === "running" ||
		value === "winding_down" ||
		value === "resumable" ||
		value === "adopted" ||
		value === "closed"
	);
}

function isOptionalString(value: unknown, maxLength: number): boolean {
	return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function processMatrixDir(agentDir: string): string {
	return stateFile(agentDir, "process-matrix");
}

export function entryPath(agentDir: string, entryId: string): string {
	return join(processMatrixDir(agentDir), `${entryId}.json`);
}

/** Stable entry identity: one entry per (role, sessionId) pair. */
export function buildEntryId(role: ProcessRole, sessionId: string): string {
	return `${role}-${sessionId}`;
}

async function readJsonFile(filePath: string): Promise<unknown> {
	let raw: string;
	try {
		raw = await fsPromises.readFile(filePath, "utf-8");
	} catch {
		return undefined;
	}
	return parseJson(raw);
}

function readJsonFileSync(filePath: string): unknown {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
	return parseJson(raw);
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		// Corrupt entry files are treated as absent -- reconcile/re-registration rebuilds them.
		return undefined;
	}
}

function isProcessMatrixEntry(value: unknown): value is ProcessMatrixEntry {
	if (!isPlainRecord(value) || !isAgentIdentity(value.agent) || (value.role !== "master" && value.role !== "worker"))
		return false;
	const sessionId = value.agent.resumeContext.sessionId;
	if (
		value.resumable !== undefined &&
		(!isPlainRecord(value.resumable) ||
			!isAgentIdentity(value.resumable.agent) ||
			!isDeepStrictEqual(value.resumable.agent, value.agent) ||
			!isProcessStatus(value.resumable.lastCode) ||
			!isOptionalString(value.resumable.taskRef, 512) ||
			!isOptionalString(value.resumable.taskSummary, 2_000))
	)
		return false;
	if (
		value.terminal !== undefined &&
		(!isPlainRecord(value.terminal) ||
			!(value.terminal.code === null || Number.isSafeInteger(value.terminal.code)) ||
			!(
				value.terminal.signal === null ||
				(typeof value.terminal.signal === "string" && value.terminal.signal.length <= 100)
			) ||
			!isTimestamp(value.terminal.observedAt) ||
			!(value.terminal.notificationDeliveredAt === undefined || isTimestamp(value.terminal.notificationDeliveredAt)))
	)
		return false;
	if (value.terminal !== undefined && value.status !== "closed") return false;
	if (value.status === "resumable" && value.resumable === undefined) return false;
	return (
		value.entryId === buildEntryId(value.role, sessionId) &&
		Number.isSafeInteger(value.pid) &&
		typeof value.hostname === "string" &&
		value.hostname.length <= 255 &&
		isTimestamp(value.startedAt) &&
		isTimestamp(value.heartbeatAt) &&
		isProcessStatus(value.status) &&
		(value.parentPid === undefined || (Number.isSafeInteger(value.parentPid) && Number(value.parentPid) > 0)) &&
		isOptionalString(value.parentSessionId, 512) &&
		isOptionalString(value.tmuxSession, 512) &&
		(value.tmuxPanePid === undefined || Number.isSafeInteger(value.tmuxPanePid)) &&
		isOptionalString(value.taskRef, 512) &&
		isOptionalString(value.taskSummary, 2_000)
	);
}

export async function readEntry(agentDir: string, entryId: string): Promise<ProcessMatrixEntry | undefined> {
	const value = await readJsonFile(entryPath(agentDir, entryId));
	return isProcessMatrixEntry(value) ? value : undefined;
}

export async function listEntries(agentDir: string): Promise<ProcessMatrixEntry[]> {
	let names: string[];
	try {
		names = await fsPromises.readdir(processMatrixDir(agentDir));
	} catch {
		return [];
	}
	const entries: ProcessMatrixEntry[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".json")) continue;
		const entry = await readJsonFile(join(processMatrixDir(agentDir), name));
		if (isProcessMatrixEntry(entry)) entries.push(entry);
	}
	return entries;
}

function serialize(entry: ProcessMatrixEntry): string {
	return `${JSON.stringify(entry, null, "\t")}\n`;
}

async function withEntryLock<T>(agentDir: string, entryId: string, operation: () => Promise<T>): Promise<T> {
	return withFileLock(entryPath(agentDir, entryId), operation);
}

export async function writeEntry(agentDir: string, entry: ProcessMatrixEntry): Promise<void> {
	await withEntryLock(agentDir, entry.entryId, async () => {
		await writeFileAtomic(entryPath(agentDir, entry.entryId), serialize(entry));
	});
}

/** Atomically replace one entry only when its full persisted value still equals `expected`. */
export async function writeEntryIfUnchanged(
	agentDir: string,
	entryId: string,
	expected: ProcessMatrixEntry | undefined,
	next: ProcessMatrixEntry,
): Promise<boolean> {
	if (next.entryId !== entryId) {
		throw new TypeError(`Process-matrix replacement entry '${next.entryId}' does not match '${entryId}'.`);
	}
	return withEntryLock(agentDir, entryId, async () => {
		const value = await readJsonFile(entryPath(agentDir, entryId));
		const current = isProcessMatrixEntry(value) ? value : undefined;
		if (!isDeepStrictEqual(current, expected)) return false;
		await writeFileAtomic(entryPath(agentDir, entryId), serialize(next));
		return true;
	});
}

/** Sync conditional replacement for best-effort `process.on("exit")` terminal writes. */
export function writeEntryIfUnchangedSync(
	agentDir: string,
	expected: ProcessMatrixEntry,
	next: ProcessMatrixEntry,
): boolean {
	if (next.entryId !== expected.entryId) {
		throw new TypeError(`Process-matrix replacement entry '${next.entryId}' does not match '${expected.entryId}'.`);
	}
	return withFileLockSync(
		entryPath(agentDir, expected.entryId),
		() => {
			const value = readJsonFileSync(entryPath(agentDir, expected.entryId));
			const current = isProcessMatrixEntry(value) ? value : undefined;
			if (!isDeepStrictEqual(current, expected)) return false;
			writeFileAtomicSync(entryPath(agentDir, expected.entryId), serialize(next));
			return true;
		},
		{ retries: 0 },
	);
}

export async function removeEntry(agentDir: string, entryId: string): Promise<void> {
	await withEntryLock(agentDir, entryId, async () => {
		try {
			await fsPromises.rm(entryPath(agentDir, entryId), { force: true });
		} catch {
			// Best-effort; a missing file is already the desired end state.
		}
	});
}

export async function removeEntryIfUnchanged(agentDir: string, expected: ProcessMatrixEntry): Promise<boolean> {
	return withEntryLock(agentDir, expected.entryId, async () => {
		const value = await readJsonFile(entryPath(agentDir, expected.entryId));
		const current = isProcessMatrixEntry(value) ? value : undefined;
		if (!isDeepStrictEqual(current, expected)) return false;
		await fsPromises.rm(entryPath(agentDir, expected.entryId), { force: true });
		return true;
	});
}
