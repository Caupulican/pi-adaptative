/**
 * Process-matrix presence channel: the event source for "my parent is gone".
 *
 * A worker cannot rely on an inherited pipe or an IPC channel (tmux-launched and detached resumed
 * workers have neither), and Node has no pidfd or parent-death signal. A master therefore keeps one
 * local listening endpoint per session open for as long as it lives and never writes to it. A worker
 * connects once; when the master exits for any reason -- SIGKILL included -- the kernel closes the
 * connection and the worker's `close` event is the death notice. No timer is involved.
 *
 * The endpoint is a Unix domain socket under a per-user 0700 directory (a named pipe on Windows).
 * It is a wake-up hint only: the worker still verifies the verdict against the master entry, and the
 * interval poll in `runtime.ts` stays as the watchdog for a worker that never managed to connect
 * (a master that predates this channel, or an endpoint that could not be bound).
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function presenceEndpoint(sessionId: string): string {
	const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
	if (process.platform === "win32") return `\\\\.\\pipe\\pi-process-matrix-${key}`;
	return join(tmpdir(), `pi-process-matrix-${process.getuid?.() ?? 0}`, `${key}.sock`);
}

export interface PresenceBeacon {
	stop(): Promise<void>;
}

const NOOP_BEACON: PresenceBeacon = { stop: async () => {} };

/** Hold this session's presence endpoint open. A bind failure is a diagnostic, never a startup failure. */
export async function startPresenceBeacon(
	sessionId: string,
	onDiagnostic?: (message: string) => void,
): Promise<PresenceBeacon> {
	const endpoint = presenceEndpoint(sessionId);
	const sockets = new Set<Socket>();
	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		socket.unref();
		// Never read from or write to a worker; resume only so its disconnect is consumed.
		socket.resume();
	});
	try {
		if (process.platform !== "win32") {
			mkdirSync(join(endpoint, ".."), { recursive: true, mode: 0o700 });
			// A SIGKILLed master of this same session leaves its socket file behind.
			rmSync(endpoint, { force: true });
		}
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(endpoint, () => {
				server.off("error", reject);
				resolve();
			});
		});
	} catch (error) {
		onDiagnostic?.(
			`process-matrix: presence endpoint unavailable (workers fall back to polling): ${error instanceof Error ? error.message : String(error)}`,
		);
		server.close();
		return NOOP_BEACON;
	}
	server.on("error", () => {});
	server.unref();
	return {
		stop: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

export interface PresenceWatch {
	dispose(): void;
}

/**
 * Watch one parent session's presence endpoint. `onClosed(true)` means an established connection
 * ended (the master closed it or died); `onClosed(false)` means no connection could be made, so no
 * event will ever arrive from this watch and the caller must keep polling.
 */
export function watchPresence(sessionId: string, onClosed: (wasConnected: boolean) => void): PresenceWatch {
	let connected = false;
	let disposed = false;
	const socket = connect(presenceEndpoint(sessionId));
	socket.unref();
	socket.on("connect", () => {
		connected = true;
	});
	socket.on("error", () => {});
	socket.on("close", () => {
		if (!disposed) onClosed(connected);
	});
	socket.resume();
	return {
		dispose() {
			disposed = true;
			socket.destroy();
		},
	};
}
