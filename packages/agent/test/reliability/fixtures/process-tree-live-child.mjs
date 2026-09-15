/**
 * Owned child/grandchild fixture for the native process-tree adapter test.
 *
 * Deliberately free of any shell dependency: both generations are plain `process.execPath` runs of
 * this same file, so it behaves identically on Windows and POSIX.
 *
 * - `child`  spawns one grandchild, then reports readiness over its parent IPC channel, carrying the
 *            grandchild's pid so the test can verify the whole tree rather than just the root.
 * - `grandchild` connects to the test-owned socket/named pipe and holds it open. The test learns the
 *            grandchild died from that socket's `close` event, never by polling output.
 *
 * Both generations stay alive on a long timer only; nothing here writes to stdout or stderr.
 *
 * EVIDENCE BOUNDARY: the grandchild never closes its own connection before `STAY_ALIVE_MS`, which is
 * what lets the test read a socket close as "that process died". After that deadline the fixture
 * closes the socket itself and the process exits, so a close observed then carries no such meaning.
 * Callers must assert well inside the window.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const STAY_ALIVE_MS = 600_000;
const [mode, socketPath] = process.argv.slice(2);
const selfPath = fileURLToPath(import.meta.url);

if (mode === "grandchild") {
	const socket = connect(socketPath);
	socket.on("connect", () => socket.write("grandchild\n"));
	// A refused or dropped connection must not turn into an unhandled error event.
	socket.on("error", () => {});
	setTimeout(() => socket.destroy(), STAY_ALIVE_MS);
} else {
	const grandchild = spawn(process.execPath, [selfPath, "grandchild", socketPath], {
		stdio: "ignore",
	});
	grandchild.on("error", () => process.exit(1));
	grandchild.once("spawn", () => {
		process.send?.({ type: "ready", grandchildPid: grandchild.pid });
	});
	setTimeout(() => process.exit(0), STAY_ALIVE_MS);
}
