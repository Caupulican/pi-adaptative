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

import { promises as fsPromises } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { stateFile } from "../agent-paths.ts";
import { isAgentIdentity } from "../orchestration/agent-resume.ts";
import { writeFileAtomic, writeFileAtomicSync } from "../util/atomic-file.ts";
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

export async function writeEntry(agentDir: string, entry: ProcessMatrixEntry): Promise<void> {
	await writeFileAtomic(entryPath(agentDir, entry.entryId), serialize(entry));
}

/** Sync counterpart for the `process.on("exit")` best-effort master close -- see `runtime.ts`. */
export function writeEntrySync(agentDir: string, entry: ProcessMatrixEntry): void {
	writeFileAtomicSync(entryPath(agentDir, entry.entryId), serialize(entry));
}

export async function removeEntry(agentDir: string, entryId: string): Promise<void> {
	try {
		await fsPromises.rm(entryPath(agentDir, entryId), { force: true });
	} catch {
		// Best-effort; a missing file is already the desired end state.
	}
}
