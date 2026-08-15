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

export class PersistentProcessCoordinator {
	private currentChild: ChildProcess | null = null;
	private queue: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor() {
		installExitHook();
		liveCoordinators.add(this);
	}

	get child(): ChildProcess | null {
		return this.currentChild;
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

		child.stdout?.on("data", (data: Buffer) => {
			if (this.currentChild === child) handlers.onStdout(data);
		});
		child.stderr?.on("data", (data: Buffer) => {
			if (this.currentChild === child) handlers.onStderr(data);
		});
		child.on("error", (error) => {
			if (!this.clear(child)) return;
			handlers.onError(error instanceof Error ? error : new Error(String(error)));
		});
		// Process death is authoritative. Defer one check phase so stream data already delivered
		// by the kernel reaches the active protocol handler before the terminal callback.
		child.on("exit", (code) => {
			if (this.currentChild !== child) return;
			setImmediate(() => {
				if (!this.clear(child)) return;
				handlers.onClose(code);
			});
		});
		// A genuine close may arrive first; `clear` makes exit/close settlement idempotent.
		child.on("close", (code) => {
			if (!this.clear(child)) return;
			handlers.onClose(code);
		});
	}

	kill(): void {
		const child = this.currentChild;
		if (!child) return;
		this.clear(child);
		if (child.pid) killProcessTree(child.pid);
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

	private clear(child: ChildProcess): boolean {
		if (this.currentChild !== child) return false;
		if (child.pid) untrackDetachedChildPid(child.pid);
		this.currentChild = null;
		return true;
	}
}
