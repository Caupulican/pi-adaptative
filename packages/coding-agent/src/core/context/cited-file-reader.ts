/**
 * Reads a file the context scout cites, for citation verification. The cited path is resolved to its real path once; the
 * workspace envelope is applied to that real path before anything is read, and the same real path is what gets read. So a
 * symlink is followed only to a target the envelope allows, and a target outside it is refused without being opened. The
 * result is the file's text, or why there is none: missing (nothing resolves here) or unreadable (not a regular file within
 * the byte bound, outside the envelope, or a read error). Existence outside the envelope is never revealed.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CapabilityEnvelope } from "../autonomy/contracts.ts";
import { isPathWithinEnvelope } from "../autonomy/envelope-enforcement.ts";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";
import type { CitedFile } from "./citation-verifier.ts";

export interface CitedFileAccess {
	readonly cwd: string;
	readonly scopeCwd: string;
	/** The scout's child envelope. Undefined when the session runs without one (yolo), where no envelope applies. */
	readonly envelope: CapabilityEnvelope | undefined;
	readonly maxBytes: number;
}

/** Error codes for a path that names nothing: a missing leaf, or a path component that is not a directory. */
const ABSENT_PATH_CODES: ReadonlySet<unknown> = new Set(["ENOENT", "ENOTDIR"]);

export function readScoutCitedFile(path: string, access: CitedFileAccess): CitedFile {
	const target = isAbsolute(path) ? path : join(access.cwd, path);
	const allowed = (candidate: string): boolean =>
		access.envelope === undefined || isPathWithinEnvelope(access.envelope, candidate, access.cwd, access.scopeCwd);

	let real: string;
	try {
		real = realpathSync(target);
	} catch (error) {
		// Nothing resolves at the cited path. Outside the envelope the answer is "unreadable", so existence stays hidden.
		if (!allowed(target)) return { status: "unreadable" };
		return ABSENT_PATH_CODES.has((error as { code?: unknown }).code)
			? { status: "missing" }
			: { status: "unreadable" };
	}
	if (!allowed(real)) return { status: "unreadable" };
	// The bounded reader accepts only a regular file, rejecting a directory or FIFO before it opens anything.
	try {
		return { status: "text", text: readBoundedTextFileSync(real, access.maxBytes, "Context scout citation file") };
	} catch {
		return { status: "unreadable" };
	}
}
