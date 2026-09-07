/**
 * Owns task-directory admission leases and serialized durable binding changes. Filesystem authority
 * stays behind the validation port; waiters wake on lease release, never process-output polling.
 */
import {
	createExecutionContext,
	type ExecutionAttachment,
	type ExecutionContext,
} from "@caupulican/pi-agent-core/paths";
import { awaitPreflight } from "../preflight.ts";
import {
	createTaskDirectoryState,
	resolveTaskDirectoryContext,
	type TaskDirectoryCommand,
	type TaskDirectoryState,
	transitionTaskDirectoryState,
} from "./task-directory-state.ts";

export interface TaskDirectoryStore {
	read(): { state: TaskDirectoryState | undefined; revisionId: string | null };
	/** Synchronous compare-and-append: failure must leave the durable snapshot unchanged. */
	commit(state: TaskDirectoryState, expectedRevisionId: string | null): string;
}

export interface TaskDirectoryControllerOptions {
	sessionId: string;
	initialAttachment: ExecutionAttachment;
	store: TaskDirectoryStore;
	/** Read-only backend directory existence and capability validation, including resolved links. */
	validate(context: ExecutionContext, signal?: AbortSignal): Promise<void>;
}

export interface TaskDirectoryLease {
	readonly context: ExecutionContext;
	release(): void;
}

interface HeldDirectory {
	taskId: string | undefined;
	context: ExecutionContext;
}

function affectsLease(command: TaskDirectoryCommand, lease: HeldDirectory): boolean {
	if (command.action === "bind" || command.action === "forget") return command.taskId === lease.taskId;
	return command.action === "reattach" && command.attachment.workspaceId === lease.context.attachment.workspaceId;
}

export class TaskDirectoryController {
	private readonly options: TaskDirectoryControllerOptions;
	private readonly initial: TaskDirectoryState;
	private readonly held = new Set<HeldDirectory>();
	private readonly waiters = new Set<() => void>();
	private readonly shutdown = new AbortController();
	private readonly pendingChanges = new Set<TaskDirectoryCommand>();
	private changing: TaskDirectoryCommand | undefined;

	constructor(options: TaskDirectoryControllerOptions) {
		this.options = options;
		this.initial = createTaskDirectoryState(options.initialAttachment);
	}

	get snapshot(): TaskDirectoryState {
		return this.options.store.read().state ?? this.initial;
	}

	get activeCount(): number {
		return this.held.size;
	}
	get waiterCount(): number {
		return this.waiters.size;
	}

	async change(input: TaskDirectoryCommand, signal?: AbortSignal): Promise<TaskDirectoryState> {
		const command = structuredClone(input);
		const combined = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
		combined.throwIfAborted();
		if (this.pendingChanges.size >= 256) throw new Error("Task directory change capacity reached");
		this.pendingChanges.add(command);
		try {
			while (
				this.changing ||
				this.pendingChanges.values().next().value !== command ||
				[...this.held].some((lease) => affectsLease(command, lease))
			) {
				await this.waitForChange(combined);
			}
			combined.throwIfAborted();
			// No await between the conflict check and reservation: two continuations cannot both win.
			this.changing = command;
			const before = this.options.store.read();
			const current = before.state ?? this.initial;
			const next = transitionTaskDirectoryState(current, command);
			if (next === current) return current;
			const contexts: ExecutionContext[] = [];
			if (command.action === "register" || command.action === "reattach" || command.action === "select") {
				const id = command.action === "select" ? command.workspaceId : command.attachment.workspaceId;
				const attachment = next.workspaces.find((item) => item.workspaceId === id);
				if (!attachment) throw new Error("Directory transition lost its workspace");
				contexts.push(
					createExecutionContext({
						attachment,
						cwd: attachment.root,
						sessionId: this.options.sessionId,
						generation: next.revision,
					}),
				);
			}
			for (const binding of next.bindings) {
				if (
					(command.action === "bind" && binding.taskId === command.taskId) ||
					(command.action === "select" && !binding.pinned) ||
					(command.action === "reattach" &&
						(binding.workspaceId ?? next.selectedWorkspaceId) === command.attachment.workspaceId)
				) {
					contexts.push(resolveTaskDirectoryContext(next, binding.taskId, this.options.sessionId));
				}
			}
			for (const context of contexts) await awaitPreflight(() => this.options.validate(context, combined), combined);
			combined.throwIfAborted();
			this.options.store.commit(next, before.revisionId);
			return next;
		} finally {
			if (this.changing === command) this.changing = undefined;
			this.pendingChanges.delete(command);
			this.notify();
		}
	}

	/** Unconfigured tasks may explicitly inherit selection; validation failures never fall back. */
	async admit(taskId: string | undefined, signal?: AbortSignal, inheritUnbound = false): Promise<TaskDirectoryLease> {
		const combined = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
		combined.throwIfAborted();
		let held: HeldDirectory;
		let revisionId: string | null;
		for (;;) {
			const snapshot = this.options.store.read();
			revisionId = snapshot.revisionId;
			const context = resolveTaskDirectoryContext(
				snapshot.state ?? this.initial,
				taskId,
				this.options.sessionId,
				inheritUnbound,
			);
			held = { taskId, context };
			if (![...this.pendingChanges].some((command) => affectsLease(command, held))) break;
			await this.waitForChange(combined);
		}
		if (this.held.size >= 256) throw new Error("Task directory admission capacity reached");
		this.held.add(held);
		const release = () => {
			if (this.held.delete(held)) this.notify();
		};
		try {
			await awaitPreflight(() => this.options.validate(held.context, combined), combined);
			combined.throwIfAborted();
			if (this.options.store.read().revisionId !== revisionId) {
				throw new Error("Task directory state changed during admission; refresh before retrying");
			}
			return Object.freeze({ context: held.context, release });
		} catch (error) {
			release();
			throw error;
		}
	}

	/** Active operation leases remain held until their owner actually settles and releases them. */
	dispose(): void {
		this.shutdown.abort(new Error("Task directory controller disposed"));
	}

	private async waitForChange(signal: AbortSignal): Promise<void> {
		if (this.waiters.size >= 256) throw new Error("Task directory wait capacity reached");
		const changed = Promise.withResolvers<void>();
		this.waiters.add(changed.resolve);
		try {
			await awaitPreflight(() => changed.promise, signal);
		} finally {
			this.waiters.delete(changed.resolve);
		}
	}

	private notify(): void {
		for (const resolve of this.waiters) resolve();
	}
}
