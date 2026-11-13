/**
 * The authority a watch a worker runtime armed is observed under, stored with it: the facts its lane's grant fixed (where its
 * commands run, whether its shell edits nothing, whether it holds `network.http`, its private paths and its confined read
 * roots), taken when the runtime armed the watch. A worker's watch is observed under the session's authority now and these
 * facts together, so it never runs with more than the worker held nor more than the session holds now. Whether the runtime
 * carries a third party's words is not stored: it is read at every observation from the runtime's durable task state, since
 * a later steer can bring them. A watch the session armed carries no scope and is observed under the session's authority
 * alone; so is a worker's watch saved before the scope existed, which could watch only a path, a process, a pid or a port.
 */
import path from "node:path";
import type { LaneShellFacts } from "../autonomy/lane-shell-scope.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import { boundedRoutineText } from "./routine-field-guards.ts";
import type { RoutineWakeAddress } from "./routine-wake-address.ts";
import type { WatchCondition } from "./watch-contract.ts";

export type WorkerWatchScope = LaneShellFacts;

/** A watch a worker runtime armed: the runtime it wakes and the scope it armed it under. */
export interface WorkerWatchAuthority {
	readonly runtimeId: string;
	readonly scope: WorkerWatchScope;
}

const MAX_SCOPE_PATH_CHARS = 4096;
/** Most private paths or read roots a stored scope holds; a lane's grant names far fewer. */
const MAX_SCOPE_PATHS = 256;

function scopePath(value: unknown, label: string): string {
	const text = boundedRoutineText(value, MAX_SCOPE_PATH_CHARS, label);
	if (!path.isAbsolute(text)) throw new TypeError(`Routine ${label} is invalid.`);
	return text;
}

function scopePaths(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length > MAX_SCOPE_PATHS) throw new TypeError(`Routine ${label} is invalid.`);
	return value.map((entry: unknown) => scopePath(entry, label));
}

/** The stored scope; a malformed one makes the whole routine unreadable. */
export function parseWorkerWatchScope(value: unknown): WorkerWatchScope {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["cwd", "shellReadOnly", "readOnly", "network", "deniedPaths", "readRoots"]) ||
		typeof value.shellReadOnly !== "boolean" ||
		typeof value.readOnly !== "boolean" ||
		typeof value.network !== "boolean"
	)
		throw new TypeError("Routine worker scope is invalid.");
	return {
		cwd: scopePath(value.cwd, "worker scope cwd"),
		shellReadOnly: value.shellReadOnly,
		readOnly: value.readOnly,
		network: value.network,
		deniedPaths: scopePaths(value.deniedPaths, "worker scope private path"),
		...(value.readRoots === undefined ? {} : { readRoots: scopePaths(value.readRoots, "worker scope read root") }),
	};
}

/** The worker authority a watch is observed under besides the session's; undefined for a session's watch and a scope-less one. */
export function routineWorkerAuthority(routine: {
	readonly wake?: RoutineWakeAddress;
	readonly workerScope?: WorkerWatchScope;
}): WorkerWatchAuthority | undefined {
	return routine.wake?.kind === "worker" && routine.workerScope
		? { runtimeId: routine.wake.runtimeId, scope: routine.workerScope }
		: undefined;
}

/**
 * The call a worker's own tools would make to check a condition: its shell for a command, its fetch tool for a page. A
 * worker arms such a watch only when its own gate admits that call, and a runtime carrying a third party's words is judged
 * by it at every observation. A path, a process, a pid or a port needs no tool, so it has none.
 */
export function workerWatchCall(
	condition: WatchCondition,
): { readonly toolName: string; readonly args: Readonly<Record<string, unknown>> } | undefined {
	if (condition.type === "command") return { toolName: "bash", args: { command: condition.command } };
	if (condition.type === "http") return { toolName: "webfetch", args: { url: condition.url } };
	return undefined;
}
