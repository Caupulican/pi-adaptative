/**
 * Shared lifecycle owner for one serialized, persistent child process.
 *
 * Wire protocols, state projection, and respawn policy stay with their concrete shell adapters.
 * This boundary owns only the invariant OS mechanics: one active task, one tracked child, stale
 * event rejection, exit/close arbitration, whole-tree kill, loop references, and parent exit.
 */

import type { ChildProcess } from "node:child_process";
import { setChildProcessLoopRef } from "../../utils/child-process-ref.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";

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

export const PERSISTENT_PROCESS_DISPOSAL_WATCHDOG_MS = 5_000;

export class PersistentProcessCoordinator {
	private currentChild: ChildProcess | null = null;
	private currentTerminalPromise: Promise<void> | null = null;
	private queue: Promise<void> = Promise.resolve();
	private disposed = false;
	private disposalWaitPromise: Promise<void> | null = null;

	constructor() {
		installExitHook();
		liveCoordinators.add(this);
	}

	get child(): ChildProcess | null {
		return this.currentChild;
	}

	get terminalPromise(): Promise<void> {
		return this.currentTerminalPromise ?? Promise.resolve();
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
			if (child.pid) killProcessTree(child.pid);
			throw new Error("Persistent process coordinator is disposed");
		}
		if (this.currentChild) throw new Error("Persistent process coordinator already owns a child");
		this.currentChild = child;
		if (child.pid) trackDetachedChildPid(child.pid);

		let resolveTerminal: () => void;
		const terminalPromise = new Promise<void>((resolve) => {
			resolveTerminal = resolve;
		});
		this.currentTerminalPromise = terminalPromise;

		const settleTerminal = () => {
			if (this.currentTerminalPromise === terminalPromise) {
				this.currentTerminalPromise = null;
			}
			resolveTerminal();
		};

		child.stdout?.on("data", (data: Buffer) => {
			if (this.currentChild === child) handlers.onStdout(data);
		});
		child.stderr?.on("data", (data: Buffer) => {
			if (this.currentChild === child) handlers.onStderr(data);
		});
		child.on("error", (error) => {
			settleTerminal();
			if (!this.clear(child)) return;
			handlers.onError(error instanceof Error ? error : new Error(String(error)));
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
			settleTerminal();
			if (!this.clear(child)) return;
			handlers.onClose(code ?? exitCode);
		});
	}

	kill(): void {
		const child = this.currentChild;
		if (!child) return;
		this.clear(child);
		if (child.pid) killProcessTree(child.pid);
		try {
			child.kill();
		} catch {
			// Process already dead
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		liveCoordinators.delete(this);
		this.kill();
	}

	disposeAndWait(timeoutMs: number = PERSISTENT_PROCESS_DISPOSAL_WATCHDOG_MS): Promise<void> {
		if (this.disposalWaitPromise) return this.disposalWaitPromise;
		const terminalPromise = this.currentTerminalPromise ?? Promise.resolve();
		this.dispose();

		let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
		const watchdogPromise = new Promise<void>((_, reject) => {
			watchdogTimer = setTimeout(() => {
				reject(
					new Error(`Persistent process terminal release timed out after ${timeoutMs}ms before child close event`),
				);
			}, timeoutMs);
			if (typeof watchdogTimer === "object" && watchdogTimer && "unref" in watchdogTimer) {
				watchdogTimer.unref();
			}
		});

		const waitPromise = Promise.race([terminalPromise, watchdogPromise]).finally(() => {
			if (watchdogTimer) clearTimeout(watchdogTimer);
		});

		this.disposalWaitPromise = waitPromise;
		return waitPromise;
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

	private clear(child: ChildProcess): boolean {
		if (this.currentChild !== child) return false;
		if (child.pid) untrackDetachedChildPid(child.pid);
		this.currentChild = null;
		return true;
	}
}
