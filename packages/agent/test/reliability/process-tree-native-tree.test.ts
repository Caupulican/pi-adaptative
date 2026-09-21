/**
 * Native process-tree adapter coverage on both host operating systems.
 *
 * The existing process-tree suite is POSIX-centric: every test that touches a real process is
 * `posixOnly` and spawns `bash`, so on Windows the only exercised paths are simulated ones
 * (`process.platform` overridden, `spawnSync` mocked). Nothing proves that the real adapter -
 * `taskkill.exe /F /T` on Windows, the group signal on POSIX - actually terminates an owned
 * child/grandchild pair on the host it is running on.
 *
 * This file closes that gap and is expected to pass on both legs; it is control evidence, not a
 * defect reproduction. Everything it spawns is `process.execPath` running one fixture, so there is
 * no bash dependency and the same test body runs unchanged on Windows and Linux.
 *
 * Completion is observed from events only: the child's `exit` event, and the `close` event of the
 * socket (named pipe on Windows) the grandchild holds open against a test-owned server.
 *
 * EVIDENCE BOUNDARY: the grandchild's socket closing proves that *process* died only because of the
 * controlled fixture - the grandchild opens exactly one connection, never closes it itself, and holds
 * no other reason to drop it before its own `STAY_ALIVE_MS` self-destruct. Past that deadline the
 * fixture closes the socket on its own, so a close observed after it would prove nothing. Every
 * assertion here runs far inside that window (READY_TIMEOUT_MS << STAY_ALIVE_MS). The server also
 * consumes the stream (`socket.resume()`): without that the readable side never reaches EOF and a
 * dead peer would never surface as `end`/`close` at all.
 *
 * Ownership is registered the moment the child is forked, not after readiness, so a failure during
 * any readiness await still cleans up. Cleanup signals only pids this test created, never signals a
 * generation already known to have exited (a recycled pid must not be signalled), and waits for the
 * owned exits it asks for under a bound.
 */

import type { ChildProcess } from "node:child_process";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isProcessAlive, killTree, killTreeNow } from "../../src/reliability/process-tree.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "process-tree-live-child.mjs");
const READY_TIMEOUT_MS = 20_000;
const CLEANUP_EXIT_TIMEOUT_MS = 5_000;

interface ReadyMessage {
	type?: string;
	grandchildPid?: number;
}

function delay(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), READY_TIMEOUT_MS);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

function hasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

interface LiveTree {
	child: ChildProcess;
	grandchildPid: number;
	/** Resolves when the grandchild's connection drops, i.e. when that process is gone. */
	grandchildGone: Promise<void>;
	childExited: Promise<void>;
}

/** Registered at fork time so a readiness failure still cleans up a partially started tree. */
interface Owned {
	server: Server;
	directory: string;
	sockets: Set<Socket>;
	child?: ChildProcess;
	childExited: Promise<void>;
	grandchildPid?: number;
	/** Positive evidence the grandchild is gone; suppresses any signal to a possibly recycled pid. */
	grandchildConnectionClosed: boolean;
}

const owned: Owned[] = [];

afterEach(async () => {
	for (const resource of owned.splice(0)) {
		const child = resource.child;
		if (child?.pid !== undefined && !hasExited(child)) {
			try {
				killTreeNow(child.pid);
			} catch {
				// Best-effort cleanup only.
			}
			await Promise.race([resource.childExited, delay(CLEANUP_EXIT_TIMEOUT_MS)]);
		}
		// Never signal a generation already proven gone: that pid may belong to someone else by now.
		if (resource.grandchildPid !== undefined && !resource.grandchildConnectionClosed) {
			if (isProcessAlive(resource.grandchildPid)) {
				try {
					killTreeNow(resource.grandchildPid);
				} catch {
					// Best-effort cleanup only.
				}
			}
		}
		for (const socket of resource.sockets) socket.destroy();
		resource.server.close();
		rmSync(resource.directory, { recursive: true, force: true });
	}
});

async function startLiveTree(): Promise<LiveTree> {
	const directory = mkdtempSync(join(tmpdir(), "pi-process-tree-native-"));
	const socketPath =
		process.platform === "win32"
			? `\\\\.\\pipe\\pi-process-tree-native-${process.pid}-${Date.now()}`
			: join(directory, "tree.sock");
	const sockets = new Set<Socket>();
	let announceGrandchildSocket!: (socket: Socket) => void;
	const grandchildSocket = new Promise<Socket>((resolve) => {
		announceGrandchildSocket = resolve;
	});
	let resolveChildExited!: () => void;
	const childExited = new Promise<void>((resolve) => {
		resolveChildExited = resolve;
	});
	const resource: Owned = {
		server: createServer(),
		directory,
		sockets,
		childExited,
		grandchildConnectionClosed: false,
	};
	owned.push(resource);
	resource.server.on("connection", (socket) => {
		sockets.add(socket);
		// Without consuming the stream the readable side never reaches EOF, so a peer that dies would
		// never surface as "end"/"close" here and the death would be invisible.
		socket.resume();
		socket.on("close", () => {
			sockets.delete(socket);
			resource.grandchildConnectionClosed = true;
		});
		announceGrandchildSocket(socket);
	});
	await withDeadline(
		new Promise<void>((resolve, reject) => {
			resource.server.once("error", reject);
			resource.server.listen(socketPath, () => resolve());
		}),
		"the test socket to listen",
	);

	const child = fork(FIXTURE, ["child", socketPath], {
		// POSIX group kill requires a process-group leader; taskkill /T walks the tree regardless.
		detached: true,
		// The owned tree must not inherit this runner's preload/loader arguments.
		execArgv: [],
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	// Ownership is registered before any await, so every later failure path still reaps this child.
	resource.child = child;
	child.once("exit", () => resolveChildExited());
	if (child.pid === undefined) throw new Error("fork produced no pid");

	const grandchildPid = await withDeadline(
		new Promise<number>((resolve, reject) => {
			child.once("error", reject);
			child.on("message", (value: unknown) => {
				const message = value as ReadyMessage;
				if (message?.type === "ready" && typeof message.grandchildPid === "number") {
					resource.grandchildPid = message.grandchildPid;
					resolve(message.grandchildPid);
				}
			});
		}),
		"the child readiness message",
	);
	const socket = await withDeadline(grandchildSocket, "the grandchild connection");
	const grandchildGone = new Promise<void>((resolve) => {
		socket.once("close", () => resolve());
	});

	return { child, grandchildPid, grandchildGone, childExited };
}

describe("native process-tree termination on this host", () => {
	it("killTree terminates an owned child and its grandchild", async () => {
		const tree = await startLiveTree();
		expect(isProcessAlive(tree.child.pid as number)).toBe(true);
		expect(isProcessAlive(tree.grandchildPid)).toBe(true);

		const diagnostics: string[] = [];
		const outcome = await killTree(tree.child, {
			graceMs: 5_000,
			onDiagnostic: (message) => diagnostics.push(message),
		});
		expect(["terminated", "killed"], diagnostics.join("\n")).toContain(outcome);

		await withDeadline(tree.childExited, "the child exit event");
		await withDeadline(tree.grandchildGone, "the grandchild connection to drop");
		expect(tree.child.exitCode !== null || tree.child.signalCode !== null).toBe(true);
	});

	it("killTreeNow terminates an owned child and its grandchild immediately", async () => {
		const tree = await startLiveTree();
		expect(isProcessAlive(tree.grandchildPid)).toBe(true);

		// The owned handle authorizes the kill; no host-ancestry snapshot runs on this path.
		const result = killTreeNow(tree.child);

		expect(result).toEqual({ success: true });
		await withDeadline(tree.childExited, "the child exit event");
		await withDeadline(tree.grandchildGone, "the grandchild connection to drop");
	});
});
