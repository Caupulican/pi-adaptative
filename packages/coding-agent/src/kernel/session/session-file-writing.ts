/** Transcript file writes under the session file lock: the lock wrapper that shares an active synchronous scope, the append to an existing history, and the full-file write. */
import { closeSync, constants as fsConstants, fstatSync, openSync, type Stats, writeFileSync } from "node:fs";
import { currentSynchronousFileLockScope, withFileLockSync } from "../storage/atomic-file.ts";
import { sameFileVersion } from "../storage/bounded-file.ts";
import { confirmSessionFileWrite } from "./session-write-confirmation.ts";

/** Share the exact active transcript lock when called from its synchronous owner. */
export function withSessionFileLock<T>(filePath: string, operation: () => T): T {
	const borrowedScope = currentSynchronousFileLockScope(filePath);
	return withFileLockSync(filePath, operation, borrowedScope ? { borrowedScope } : undefined);
}

/** An existing history disappearing is a failed write, never permission to create a suffix-only file. */
export function appendToExistingSessionFile(
	filePath: string,
	content: string,
	expected?: Stats,
	onRecoveredWrite?: (error: unknown) => void,
): Stats {
	return writeSessionFile(filePath, fsConstants.O_WRONLY | fsConstants.O_APPEND, content, expected, onRecoveredWrite);
}

/** Creation and append share descriptor ownership, close handling, and exact readback after uncertain I/O. */
export function writeSessionFile(
	filePath: string,
	flags: "wx" | number,
	content: string,
	expected?: Stats,
	onRecoveredWrite?: (error: unknown) => void,
): Stats {
	return withSessionFileLock(filePath, () => {
		const fd = openSync(filePath, flags);
		let before: Stats | undefined;
		let written: Stats | undefined;
		let attempted = false;
		let failure: { error: unknown } | undefined;
		try {
			before = fstatSync(fd);
			if (expected && !sameFileVersion(expected, before))
				throw new Error("Session file changed before its tail repair; reopen it before retrying.");
			attempted = true;
			writeFileSync(fd, content);
			written = fstatSync(fd);
		} catch (error) {
			failure = { error };
		} finally {
			try {
				closeSync(fd);
			} catch (error) {
				failure = {
					error: failure ? new AggregateError([failure.error, error], "Session write and close failed.") : error,
				};
			}
		}
		if (!failure) return written!;
		if (!attempted || !before || !onRecoveredWrite) throw failure.error;
		let confirmed: Stats;
		try {
			confirmed = confirmSessionFileWrite(filePath, before, content);
		} catch (error) {
			throw new AggregateError([failure.error, error], "Session write outcome could not be confirmed.");
		}
		onRecoveredWrite(failure.error);
		return confirmed;
	});
}
