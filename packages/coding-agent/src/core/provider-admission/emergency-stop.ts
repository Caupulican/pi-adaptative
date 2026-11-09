import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import { KeyedSignal } from "../util/keyed-signal.ts";
import { retainDirectoryWatch } from "./admission-watch.ts";

/**
 * Machine-wide emergency stop: a sentinel file at `<agentDir>/ESTOP` pauses NEW worker and
 * background provider work in every pi process on this agent directory. In-flight foreground turns
 * continue and nothing is killed, except a turn the owner's phone started in the process that serves
 * its channel: that process stops it at once (the channels core subscribes to this signal). Workers
 * waiting to start stay queued, and a running worker's next
 * provider request waits (bounded) instead of being sent. The check is one `existsSync`, so every
 * scheduler may run it on each tick. A corrupt or empty file still counts as engaged (fail safe):
 * the pause must hold even if the file was created with `touch`.
 *
 * `/estop off` is the owner's continue: it lifts a stop when one is engaged, and it always writes `<agentDir>/ESTOP.resume`.
 * The processes that subscribe with `subscribeOwnerContinue` watch that record, so held work resumes on each of them even
 * when no stop was engaged.
 *
 * Modelled on the operator control that other harnesses ship for the same box-wide situation;
 * ours had no way to hold every pi at once when a shared account was being hammered.
 */

export interface EmergencyStopState {
	engaged: boolean;
	reason?: string;
	engagedAt?: string;
	path: string;
}

export function emergencyStopPath(agentDir: string): string {
	return join(agentDir, "ESTOP");
}

/** A stop engaged or lifted, keyed by the sentinel path: by this process, or seen by the directory watch. */
const emergencyStopChanges = new KeyedSignal();
/** The engaged state last announced per sentinel path, so the watch never repeats a change this process announced. */
const announcedEngaged = new Map<string, boolean>();
/** The owner's continue (a `/estop off`), keyed by agent directory: by this process, or seen through the resume record. */
const ownerContinues = new KeyedSignal();
/** The identity of the stop this process last saw engaged, per agent directory: the stop a lift of it names. */
const engagedStop = new Map<string, string>();
/** The token of the continue last announced per agent directory: one token per continue, whichever source saw it first. */
const announcedContinue = new Map<string, string>();

/**
 * The identity of the engaged stop at `path`: its random `id`, else its `engagedAt` (a sentinel an older build wrote), else the
 * sentinel's mtime when its body is unreadable (a `touch`). Undefined when no stop is engaged.
 */
function stopIdentity(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const { id, engagedAt } = JSON.parse(readFileSync(path, "utf-8")) as { id?: unknown; engagedAt?: unknown };
		if (typeof id === "string") return id;
		if (typeof engagedAt === "string") return engagedAt;
	} catch {
		// An unreadable body is still an engaged stop: its mtime identifies it.
	}
	try {
		return String(statSync(path).mtimeMs);
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
}

function announce(path: string, engaged: boolean): void {
	announcedEngaged.set(path, engaged);
	emergencyStopChanges.notify(path);
}

/**
 * Calls `onChange` whenever the stop of `agentDir` is engaged or lifted: by this process at once, and by another process
 * or an operator's `touch`/`rm` of the sentinel through a watch of the agent directory held while anyone listens.
 */
export function subscribeEmergencyStop(agentDir: string, onChange: () => void): () => void {
	const path = emergencyStopPath(agentDir);
	const unsubscribe = emergencyStopChanges.subscribe(path, onChange);
	const engaged = stopIdentity(path);
	if (engaged !== undefined) engagedStop.set(agentDir, engaged);
	const release = retainDirectoryWatch(`estop:${agentDir}`, () => ({
		dir: agentDir,
		relevant: (name) => name === "ESTOP",
		read: () => new Map(existsSync(path) ? [["ESTOP", stopIdentity(path) ?? "engaged"]] : []),
		changed: () => {
			const identity = stopIdentity(path);
			if (identity !== undefined) engagedStop.set(agentDir, identity);
			if (announcedEngaged.get(path) !== (identity !== undefined)) announce(path, identity !== undefined);
		},
	}));
	return () => {
		unsubscribe();
		release();
	};
}

export function isEmergencyStopEngaged(agentDir: string): boolean {
	return existsSync(emergencyStopPath(agentDir));
}

export function readEmergencyStop(agentDir: string): EmergencyStopState {
	const path = emergencyStopPath(agentDir);
	if (!existsSync(path)) return { engaged: false, path };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as { reason?: unknown; engagedAt?: unknown };
		return {
			engaged: true,
			path,
			...(typeof parsed.reason === "string" && parsed.reason ? { reason: parsed.reason } : {}),
			...(typeof parsed.engagedAt === "string" ? { engagedAt: parsed.engagedAt } : {}),
		};
	} catch {
		// An unreadable body is still an engaged stop.
		return { engaged: true, path };
	}
}

export function engageEmergencyStop(
	agentDir: string,
	reason?: string,
	now: () => number = Date.now,
): EmergencyStopState {
	const path = emergencyStopPath(agentDir);
	const engagedAt = new Date(now()).toISOString();
	const id = randomUUID();
	writeFileSync(path, `${JSON.stringify({ ...(reason ? { reason } : {}), engagedAt, id })}\n`, { mode: 0o600 });
	engagedStop.set(agentDir, id);
	announce(path, true);
	harnessLog.info("provider", "the emergency stop was engaged");
	return { engaged: true, path, engagedAt, ...(reason ? { reason } : {}) };
}

/** The file of the owner's latest continue, within the agent directory. */
const RESUME_FILE = "ESTOP.resume";

/**
 * The owner's latest continue: `{ at, id, lifted }`, rewritten by each `/estop off`. `id` is a fresh nonce per write; `lifted`
 * names the stop the continue lifted and is absent when no stop was engaged. A process announces each continue once, whichever
 * record shows it first.
 */
export function emergencyResumePath(agentDir: string): string {
	return join(agentDir, RESUME_FILE);
}

/** Removes the sentinel. Returns true when a stop was engaged and is now lifted. */
function removeEmergencyStop(agentDir: string): boolean {
	const path = emergencyStopPath(agentDir);
	if (!existsSync(path)) return false;
	try {
		rmSync(path, { force: true });
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}
	announce(path, false);
	harnessLog.info("provider", "the emergency stop was lifted");
	return true;
}

/**
 * The owner's continue (`/estop off`): lifts a stop when one is engaged, and always writes the resume record. A lift reaches
 * the owner-continue subscribers through the stop's removal, in this process and in every other; with no stop engaged the
 * continue is announced here. Returns true only when a stop was lifted.
 */
export function liftEmergencyStop(agentDir: string, now: () => number = Date.now): boolean {
	// The record is written first: if it cannot be written, nothing has changed and the error reaches the owner.
	const at = new Date(now()).toISOString();
	const id = randomUUID();
	const lifted = stopIdentity(emergencyStopPath(agentDir));
	writeFileAtomicSync(
		emergencyResumePath(agentDir),
		`${JSON.stringify({ at, id, ...(lifted !== undefined ? { lifted } : {}) })}\n`,
		{ mode: 0o600 },
	);
	if (lifted !== undefined) engagedStop.set(agentDir, lifted);
	const removed = removeEmergencyStop(agentDir);
	if (!removed) acceptOwnerContinue(agentDir, lifted ?? id);
	harnessLog.info("provider", "the owner continued held work");
	return removed;
}

/**
 * The owner's latest continue as recorded, undefined when none is recorded or the record is unreadable (no continue). `write`
 * identifies the record; `token` names the continue: the stop it lifted, else the record itself.
 */
function readResume(agentDir: string): { readonly write: string; readonly token: string } | undefined {
	try {
		const { at, id, lifted } = JSON.parse(readFileSync(emergencyResumePath(agentDir), "utf-8")) as {
			at?: unknown;
			id?: unknown;
			lifted?: unknown;
		};
		if (typeof at === "string") {
			const write = typeof id === "string" ? id : at;
			return { write, token: typeof lifted === "string" ? lifted : write };
		}
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
	}
	harnessLog.warn("provider", "the owner-continue file is unreadable");
	return undefined;
}

/**
 * Announces one owner continue to this process's subscribers. The token names the continue: the stop it lifted (the stop's
 * random id), or the record's id when no stop was engaged. Nothing is announced while a stop is engaged, since the lift that
 * ends it is the continue, and a token already announced in this process is never announced again.
 */
function acceptOwnerContinue(agentDir: string, token: string | undefined): void {
	if (isEmergencyStopEngaged(agentDir)) return;
	if (token !== undefined) {
		if (announcedContinue.get(agentDir) === token) return;
		announcedContinue.set(agentDir, token);
	}
	ownerContinues.notify(agentDir);
}

/**
 * Calls `onContinue` when the owner continues held work on this agent directory: a stop lifted (by any process, or by an
 * operator's removal of the sentinel), or `/estop off` with no stop engaged (the resume record, written by any process).
 * Each continue reaches `onContinue` once per process, whichever record shows it first. The stop's own engage is not a continue.
 */
export function subscribeOwnerContinue(agentDir: string, onContinue: () => void): () => void {
	const stop = subscribeEmergencyStop(agentDir, () => acceptOwnerContinue(agentDir, engagedStop.get(agentDir)));
	const local = ownerContinues.subscribe(agentDir, onContinue);
	const release = retainDirectoryWatch(`estop-resume:${agentDir}`, () => ({
		dir: agentDir,
		relevant: (name) => name === RESUME_FILE,
		read: () => {
			const resume = readResume(agentDir);
			return new Map<string, string>(resume === undefined ? [] : [[RESUME_FILE, resume.write]]);
		},
		changed: (names) => {
			if (!names.includes(RESUME_FILE)) return;
			const resume = readResume(agentDir);
			if (resume !== undefined) acceptOwnerContinue(agentDir, resume.token);
		},
	}));
	return () => {
		stop();
		local();
		release();
	};
}
