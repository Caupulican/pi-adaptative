import * as path from "node:path";
import { emergencyStopPath } from "../provider-admission/emergency-stop.ts";
import type { CapabilityEnvelope } from "./contracts.ts";
import { getHarnessWriteProtectedPaths, getPrivateLaneDeniedPaths } from "./lane-private-paths.ts";

export const PI_WORKER_ALLOWED_PATHS_ENV = "PI_WORKER_ALLOWED_PATHS";

function parseAbsolutePathList(raw: string | undefined, envName: string): readonly string[] {
	if (raw === undefined) return Object.freeze([]);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${envName} must be a JSON array of absolute paths.`);
	}
	if (
		!Array.isArray(parsed) ||
		!parsed.every(
			(entry) =>
				typeof entry === "string" &&
				entry.trim().length > 0 &&
				(path.isAbsolute(entry) || path.win32.isAbsolute(entry)),
		)
	) {
		throw new Error(`${envName} must be a JSON array of absolute paths.`);
	}
	return Object.freeze([...new Set(parsed.map((entry) => entry.trim()))]);
}

export function parseWorkerSessionAllowedPaths(raw: string | undefined): readonly string[] {
	return parseAbsolutePathList(raw, PI_WORKER_ALLOWED_PATHS_ENV);
}

/**
 * Exact files the launcher grants a worker to read although a private root denies them (for example the
 * session transcript a read-only learner is asked to study). The grant names files, never directories.
 */
export const PI_WORKER_READABLE_FILES_ENV = "PI_WORKER_READABLE_FILES";

export function parseWorkerSessionReadableFiles(raw: string | undefined): readonly string[] {
	return parseAbsolutePathList(raw, PI_WORKER_READABLE_FILES_ENV);
}

export function encodeWorkerSessionAllowedPaths(paths: readonly string[]): string {
	return JSON.stringify(parseWorkerSessionAllowedPaths(JSON.stringify(paths)));
}

/**
 * Structural filesystem envelope for a standalone worker process (for example a Pi child launched
 * in tmux). An empty allow list deliberately preserves the worker's host-wide project access while
 * the private harness roots remain denied. Process tools are not path-confined by this envelope:
 * bash/python are explicit host-trust boundaries and retain their OS-visible filesystem surface.
 */
export function buildWorkerSessionPrivatePathEnvelope(
	cwd: string,
	agentDir: string,
	allowedPaths: readonly string[] = parseWorkerSessionAllowedPaths(process.env[PI_WORKER_ALLOWED_PATHS_ENV]),
	readableFiles: readonly string[] = parseWorkerSessionReadableFiles(process.env[PI_WORKER_READABLE_FILES_ENV]),
): CapabilityEnvelope {
	const capabilities = Object.freeze(["filesystem.read", "filesystem.write"] as const);
	const immutableAllowedPaths = Object.freeze([...allowedPaths]);
	// The machine-wide emergency stop is the operator's: a worker must not lift it, and process tools
	// reach it through the same lexical guard as the other private roots.
	const deniedPaths = Object.freeze([...getPrivateLaneDeniedPaths(cwd, agentDir), emergencyStopPath(agentDir)]);
	return Object.freeze({
		id: "worker-session-private-paths",
		capabilities,
		allowedPaths: immutableAllowedPaths,
		deniedPaths,
		...(readableFiles.length > 0 ? { exemptPaths: Object.freeze([...readableFiles]) } : {}),
	});
}

/**
 * Default write scope of a worker process that was granted no explicit paths: its own working directory.
 * Reads keep the host-wide project access of the private path envelope; a write beyond the working
 * directory is an explicit grant (`PI_WORKER_ALLOWED_PATHS`, from the dispatch's `writePaths`), in which
 * case the private path envelope already scopes the worker to exactly those roots and this returns nothing.
 * Process tools are not path-confined (see {@link buildWorkerSessionPrivatePathEnvelope}).
 */
export function buildWorkerSessionDefaultWriteScopeEnvelope(
	cwd: string,
	allowedPaths: readonly string[] = parseWorkerSessionAllowedPaths(process.env[PI_WORKER_ALLOWED_PATHS_ENV]),
): CapabilityEnvelope | undefined {
	if (allowedPaths.length > 0) return undefined;
	return Object.freeze({
		id: "worker-session-default-write-scope",
		capabilities: Object.freeze(["filesystem.write"] as const),
		allowedPaths: Object.freeze([path.resolve(cwd)]),
	});
}

/**
 * Write-only companion to the private path envelope: harness resources (skills, extensions, prompts,
 * profiles, keybindings, system prompt files, bin, the emergency stop, project hooks and git config)
 * stay readable but no worker filesystem write may touch them. The envelope carries only
 * `filesystem.write`, so read tools resolve to no path access and are never checked against it.
 */
export function buildWorkerSessionHarnessWriteEnvelope(cwd: string, agentDir: string): CapabilityEnvelope {
	return Object.freeze({
		id: "worker-session-harness-write-protection",
		capabilities: Object.freeze(["filesystem.write"] as const),
		deniedPaths: Object.freeze(getHarnessWriteProtectedPaths(cwd, agentDir)),
	});
}
