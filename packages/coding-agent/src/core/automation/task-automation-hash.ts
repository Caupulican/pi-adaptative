import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { TaskAutomationHashPort } from "./contracts.ts";

export const MAX_SCRIPT_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

/** Compute SHA-256 hash of a string or buffer. */
export function computeContentHash(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute SHA-256 hash of a file within the workspace directory.
 * Enforces canonical path containment (rejects sibling paths and escaping symlinks),
 * requires a regular file, and strictly caps file size and read allocation at 2 MB.
 * Returns undefined if the file does not exist, escapes workspace, is not regular, or exceeds the size cap.
 */
export function computeScriptFileHash(scriptPath: string, cwd: string): string | undefined {
	if (!scriptPath || typeof scriptPath !== "string" || !cwd || typeof cwd !== "string") {
		return undefined;
	}

	let realCwd: string;
	try {
		realCwd = realpathSync(resolve(cwd));
	} catch {
		return undefined;
	}

	const candidatePath = isAbsolute(scriptPath) ? resolve(scriptPath) : resolve(cwd, scriptPath);

	let realTarget: string;
	try {
		realTarget = realpathSync(candidatePath);
	} catch {
		return undefined;
	}

	const rel = relative(realCwd, realTarget);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		return undefined;
	}

	let fd: number | undefined;
	try {
		fd = openSync(realTarget, "r");
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_SCRIPT_FILE_BYTES) {
			return undefined;
		}

		// Read into a strictly bounded buffer of at most MAX_SCRIPT_FILE_BYTES + 1.
		// If the file grew past the cap between stat and read, the extra byte is detected without unbounded allocation.
		const readLimit = MAX_SCRIPT_FILE_BYTES + 1;
		const buffer = Buffer.allocUnsafe(readLimit);
		let totalBytesRead = 0;

		while (totalBytesRead < readLimit) {
			const bytesRead = readSync(fd, buffer, totalBytesRead, readLimit - totalBytesRead, null);
			if (bytesRead === 0) {
				break;
			}
			totalBytesRead += bytesRead;
		}

		if (totalBytesRead > MAX_SCRIPT_FILE_BYTES) {
			return undefined;
		}

		return computeContentHash(buffer.subarray(0, totalBytesRead));
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// ignore close errors
			}
		}
	}
}

export const defaultTaskAutomationHashPort: TaskAutomationHashPort = {
	computeFileHash: computeScriptFileHash,
	computeContentHash,
};
