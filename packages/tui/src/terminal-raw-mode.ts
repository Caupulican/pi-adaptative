/** Restores a terminal's raw mode without treating an already detached device as a process crash. */
import { isatty } from "node:tty";

/** Enabling raw mode remains strict; this boundary applies only when relinquishing a terminal. */
export function restoreTerminalRawMode(input: NodeJS.ReadStream, wasRaw: boolean): void {
	if (!input.isTTY || input.destroyed || typeof input.setRawMode !== "function") return;
	// Node and Bun can emit the failure synchronously. Classify this call before an existing
	// process error listener treats a detached device as an unrelated runtime failure.
	const capture = (error: unknown): never => {
		throw error;
	};
	input.prependListener("error", capture);
	try {
		input.setRawMode(wasRaw);
	} catch (error) {
		// isTTY is cached. A fresh device query also closes the race with PTY teardown.
		const fd = "fd" in input ? input.fd : undefined;
		if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0 || fd > 2_147_483_647) throw error;
		if (isatty(fd)) throw error;
	} finally {
		input.removeListener("error", capture);
	}
}
