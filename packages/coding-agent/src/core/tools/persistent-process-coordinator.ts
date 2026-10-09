/**
 * Shared lifecycle owner for one serialized, persistent child process.
 *
 * Wire protocols, state projection, and respawn policy stay with their concrete shell adapters.
 * This boundary owns only the invariant OS mechanics: one active task, one current child, every
 * outstanding child terminal, stale event rejection, exit/close arbitration, whole-tree kill,
 * loop references, and parent exit.
 */

import type { ChildProcess } from "node:child_process";
import { setChildProcessLoopRef } from "../../utils/child-process-ref.ts";
import { killProcessTree, trackDetachedChild, untrackDetachedChild } from "../../utils/shell.ts";

export interface PersistentChildHandlers {
	onStdout(data: Buffer): void;
	onStderr(data: Buffer): void;
	onError(error: Error): void;
	onClose(code: number | null): void;
}

const liveCoordinators = new Set<PersistentProcessCoordinator>();
let exitHookInstalled = false;

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const coordinator of liveCoordinators) coordinator.killForProcessExit();
	});
}

export class PersistentProcessCoordinator {
	private currentChild: ChildProcess | null = null;
	private currentTerminal: Promise<void> | null = null;
	private readonly pendingChildTerminals = new Set<Promise<void>>();
	private queue: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor() {
		installExitHook();
		liveCoordinators.add(this);
	}

	get child(): ChildProcess | null {
		return this.currentChild;
	}

	get terminalPromise(): Promise<void> {
		return this.waitForTerminalRelease();
	}

	/** Exact physical close for the owned child, without joining this coordinator's serialized task queue. */
	getChildTerminal(child: ChildProcess): Promise<void> {
		if (this.currentChild !== child || !this.currentTerminal) {
			throw new Error("Persistent process coordinator does not own the requested child terminal");
		}
		return this.currentTerminal;
	}

	runSerialized<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	attach(child: ChildProcess, handlers: PersistentChildHandlers): void {
		if (this.disposed) {
			this.trackTerminal(child);
			this.terminateChild(child);
			throw new Error("Persistent process coordinator is disposed");
		}
		if (this.currentChild) {
			// `attach` transfers lifecycle ownership. A rejected second transfer still has to end
			// inside this coordinator's terminal barrier; otherwise the just-spawned process becomes
			// an untracked orphan as the admission error propagates to its caller.
			this.trackTerminal(child);
			this.terminateChild(child);
			throw new Error("Persistent process coordinator already owns a child");
		}
		this.currentChild = child;
		if (child.pid === undefined) {
			child.once("spawn", () => {
				if (this.currentChild === child) trackDetachedChild(child);
			});
		} else {
			trackDetachedChild(child);
		}
		this.currentTerminal = this.trackTerminal(child);

		child.stdout?.on("data", (data: Buffer) => {
			if (this.currentChild === child) handlers.onStdout(data);
		});
		child.stderr?.on("data", (data: Buffer) => {
			if (this.currentChild === child) handlers.onStderr(data);
		});
		child.on("error", (error) => {
			if (this.currentChild !== child) return;
			const normalized = error instanceof Error ? error : new Error(String(error));
			// A failed spawn never grants process ownership and must not be signaled. A runtime
			// error is different: keep the live child authoritative while its adapter fails the
			// active operation, then terminate it here if the adapter did not already do so. Clearing
			// before the callback makes adapter-owned kill/reset paths no-ops and can leave both the
			// child and this coordinator's physical-close barrier alive forever.
			if (child.pid === undefined) {
				this.clear(child);
				handlers.onError(normalized);
				return;
			}
			try {
				handlers.onError(normalized);
			} finally {
				if (this.clear(child)) this.terminateChild(child);
			}
		});
		let exitCode: number | null = null;
		let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

		child.on("exit", (code) => {
			if (this.currentChild !== child) return;
			exitCode = code;
			fallbackTimer = setTimeout(() => {
				if (!this.clear(child)) return;
				handlers.onClose(exitCode);
			}, 2_000);
			if (typeof fallbackTimer === "object" && fallbackTimer && "unref" in fallbackTimer) {
				fallbackTimer.unref();
			}
		});

		child.on("close", (code) => {
			if (fallbackTimer) clearTimeout(fallbackTimer);
			if (!this.clear(child)) return;
			handlers.onClose(code ?? exitCode);
		});
	}

	kill(): void {
		const child = this.currentChild;
		if (!child) return;
		this.clear(child);
		this.terminateChild(child);
	}

	private terminateChild(child: ChildProcess): void {
		const terminateSpawnedChild = (): void => {
			// Bun's Windows child-process bridge can stop publishing terminal events after every
			// handle has been unref'd. Re-arm the already-installed close observer before killing so
			// strict teardown can distinguish physical handle release from process exit.
			setChildProcessLoopRef(child, true);
			killProcessTree(child);
			try {
				child.kill();
			} catch {
				// Process already dead
			}
		};
		if (child.pid !== undefined) {
			terminateSpawnedChild();
			return;
		}

		// A failed spawn can retain a native handle before its error event. Signaling in that
		// window can target the caller's process group, so wait for the child's spawn event to
		// grant ownership. Error/close proves no later spawn can need termination.
		const cleanup = (): void => {
			child.off("spawn", onSpawn);
			child.off("error", cleanup);
			child.off("close", cleanup);
		};
		const onSpawn = (): void => {
			cleanup();
			terminateSpawnedChild();
		};
		child.once("spawn", onSpawn);
		child.once("error", cleanup);
		child.once("close", cleanup);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		liveCoordinators.delete(this);
		this.kill();
	}

	/** Synchronous best-effort tree kill for the process exit hook. */
	killForProcessExit(): void {
		this.kill();
	}

	/** Idle coordinators must not keep one-shot Node modes alive; active commands must. */
	setLoopRef(active: boolean): void {
		const child = this.currentChild;
		if (!child) return;
		setChildProcessLoopRef(child, active);
	}

	private async waitForTerminalRelease(): Promise<void> {
		await this.queue;
		while (this.pendingChildTerminals.size > 0) {
			await Promise.all(Array.from(this.pendingChildTerminals));
		}
	}

	private trackTerminal(child: ChildProcess): Promise<void> {
		let settled = false;
		let resolveTerminal: () => void;
		const terminalPromise = new Promise<void>((resolve) => {
			resolveTerminal = resolve;
		});
		const settleTerminal = () => {
			if (settled) return;
			settled = true;
			child.off("error", handleTerminalError);
			child.off("close", settleTerminal);
			this.pendingChildTerminals.delete(terminalPromise);
			resolveTerminal();
		};
		const handleTerminalError = () => {
			if (!child.pid) settleTerminal();
		};

		this.pendingChildTerminals.add(terminalPromise);
		child.on("error", handleTerminalError);
		child.once("close", settleTerminal);
		return terminalPromise;
	}

	private clear(child: ChildProcess): boolean {
		if (this.currentChild !== child) return false;
		untrackDetachedChild(child);
		this.currentChild = null;
		this.currentTerminal = null;
		return true;
	}
}
