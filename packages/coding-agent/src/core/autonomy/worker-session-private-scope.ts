import * as path from "node:path";
import type { CapabilityEnvelope } from "./contracts.ts";
import { getPrivateLaneDeniedPaths } from "./lane-private-paths.ts";

export const PI_WORKER_ALLOWED_PATHS_ENV = "PI_WORKER_ALLOWED_PATHS";

export function parseWorkerSessionAllowedPaths(raw: string | undefined): readonly string[] {
	if (raw === undefined) return Object.freeze([]);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${PI_WORKER_ALLOWED_PATHS_ENV} must be a JSON array of absolute paths.`);
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
		throw new Error(`${PI_WORKER_ALLOWED_PATHS_ENV} must be a JSON array of absolute paths.`);
	}
	return Object.freeze([...new Set(parsed.map((entry) => entry.trim()))]);
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
): CapabilityEnvelope {
	const capabilities = Object.freeze(["filesystem.read", "filesystem.write"] as const);
	const immutableAllowedPaths = Object.freeze([...allowedPaths]);
	const deniedPaths = Object.freeze(getPrivateLaneDeniedPaths(cwd, agentDir));
	return Object.freeze({
		id: "worker-session-private-paths",
		capabilities,
		allowedPaths: immutableAllowedPaths,
		deniedPaths,
	});
}
