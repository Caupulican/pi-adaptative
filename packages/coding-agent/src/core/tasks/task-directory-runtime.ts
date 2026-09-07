import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { AgentTool } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import {
	createExecutionContext,
	type ExecutionAttachment,
	type ExecutionContext,
} from "@caupulican/pi-agent-core/paths";
import type { TSchema } from "typebox";
import type { CapabilityEnvelope } from "../autonomy/contracts.ts";
import { isPathWithinEnvelope } from "../autonomy/envelope-enforcement.ts";
import { awaitPreflight } from "../preflight.ts";
import { getToolCapabilityPolicy } from "../tool-capability-policy.ts";
import { disposeShellExecutionSession, disposeShellExecutionSessionAndWait } from "../tools/shell-execution-session.ts";
import { createNativeTaskDirectoryBackend } from "./native-task-directory-backend.ts";
import { createSessionTaskDirectoryStore } from "./session-task-directory-store.ts";
import { TaskDirectoryController } from "./task-directory-controller.ts";
import { resolveTaskDirectoryContext, type TaskDirectoryCommand } from "./task-directory-state.ts";
import { createTaskDirectoryValidator } from "./task-directory-validation.ts";
import { TaskShellSessions } from "./task-shell-sessions.ts";

export interface TaskDirectoryRuntimeOptions {
	getSessionManager(): SessionManager;
	getCwd(): string;
	getActiveTaskId(): string | undefined;
	getEnvelopes(): readonly CapabilityEnvelope[];
}

export const TASK_DIRECTORY_INITIALIZATION_TIMEOUT_MS = 10_000;

type NativeDirectoryCommand =
	| Exclude<TaskDirectoryCommand, { action: "register" | "reattach" }>
	| (({ action: "register" } | { action: "reattach" }) & { workspaceId: string; path: string });

interface InitializedDirectory {
	controller: TaskDirectoryController;
	initialAttachment: ExecutionAttachment;
	unavailable: string | undefined;
}

interface DirectoryScope {
	session: SessionManager;
	sessionId: string;
	root: string;
	abort: AbortController;
	ready: Promise<InitializedDirectory>;
}

/** Native runtime adapter: one admission owner, no process-global chdir or competing task cursor. */
export class TaskDirectoryRuntime {
	private readonly options: TaskDirectoryRuntimeOptions;
	private readonly contextStorage = new AsyncLocalStorage<ExecutionContext>();
	private readonly backend = createNativeTaskDirectoryBackend();
	private readonly shells = new TaskShellSessions(disposeShellExecutionSessionAndWait);
	private scope: DirectoryScope | undefined;
	private disposed = false;

	constructor(options: TaskDirectoryRuntimeOptions) {
		this.options = options;
	}

	get executionContext(): ExecutionContext | undefined {
		return this.contextStorage.getStore();
	}
	get cwd(): string {
		return this.executionContext?.cwd ?? this.options.getCwd();
	}
	get activeTaskId(): string | undefined {
		return this.options.getActiveTaskId();
	}
	getSnapshot(signal?: AbortSignal) {
		return this.withController(({ controller }) => controller.snapshot, signal);
	}
	getStatus(signal?: AbortSignal) {
		return this.withController((initialized, scope) => {
			const state = initialized.controller.snapshot;
			const activeTaskId = this.activeTaskId;
			let effective: ExecutionContext | undefined;
			let unavailable: string | undefined;
			try {
				effective = resolveTaskDirectoryContext(state, activeTaskId, scope.sessionId, true);
				if (effective.attachment.attachmentId === initialized.initialAttachment.attachmentId)
					unavailable = initialized.unavailable;
			} catch (error) {
				unavailable = error instanceof Error ? error.message : String(error);
			}
			return { state, activeTaskId, effective, unavailable };
		}, signal);
	}

	private attachment(workspaceId: string, root: string, attachmentId: string, sessionId: string): ExecutionAttachment {
		return createExecutionContext({
			attachment: {
				workspaceId,
				attachmentId,
				root,
				flavor: this.backend.flavor,
				caseSensitive: this.backend.flavor !== "win32",
			},
			cwd: root,
			sessionId,
			generation: 0,
		}).attachment;
	}

	change(input: NativeDirectoryCommand, signal?: AbortSignal) {
		const command = structuredClone(input);
		return this.withController((initialized, scope) => {
			const combined = signal ? AbortSignal.any([signal, scope.abort.signal]) : scope.abort.signal;
			let prepared: TaskDirectoryCommand;
			if (command.action === "register" || command.action === "reattach") {
				prepared = {
					action: command.action,
					attachment: this.attachment(command.workspaceId, command.path, randomUUID(), scope.sessionId),
				};
			} else prepared = command;
			return initialized.controller.change(prepared, combined);
		}, signal);
	}

	/** Hold the selected task attachment while a host workflow captures its durable execution plan. */
	async withContext<T>(operation: (context: ExecutionContext) => T | Promise<T>, signal?: AbortSignal): Promise<T> {
		const lease = await this.admit(signal);
		try {
			signal?.throwIfAborted();
			return await this.contextStorage.run(lease.context, () => operation(lease.context));
		} finally {
			lease.release();
		}
	}

	private admit(signal?: AbortSignal) {
		const taskId = this.activeTaskId;
		return this.withController(
			({ controller }, scope) =>
				controller.admit(taskId, signal ? AbortSignal.any([signal, scope.abort.signal]) : scope.abort.signal, true),
			signal,
		);
	}

	bindTool<TParameters extends TSchema, TDetails>(
		tool: AgentTool<TParameters, TDetails>,
		create?: (context: ExecutionContext, shellKey: string) => AgentTool<TParameters, TDetails>,
	): AgentTool<TParameters, TDetails> {
		// A supplied backend owns its binding; native factories must not silently replace it.
		if (tool.bindInvocation) return tool;
		return {
			...tool,
			bindInvocation: async (_id, _params, signal) => {
				const lease = await this.admit(signal);
				let releaseShell: (() => void) | undefined;
				try {
					const context = lease.context;
					// File tools authorize the concrete accessed resource at their existing gate. Requiring
					// their parent cwd to be readable would incorrectly reject file-only grants. Process
					// and unknown extension backends expose cwd itself, so admit that resource here too.
					const policy = getToolCapabilityPolicy(tool.name);
					if (!policy || policy.enforcements.includes("process-launcher")) {
						for (const envelope of this.options.getEnvelopes()) {
							if (!isPathWithinEnvelope(envelope, context.cwd, this.options.getCwd()))
								throw new Error("Task process directory is outside the existing capability grant");
						}
					}
					const key = `task-directory:${createHash("sha256")
						.update(
							JSON.stringify([context.sessionId, context.taskId, context.attachment.attachmentId, context.cwd]),
						)
						.digest("hex")}`;
					const executor = create ? create(context, key) : tool;
					if (create && (tool.name === "bash" || tool.name === "powershell")) {
						releaseShell = await this.shells.acquire(key, signal);
					}
					return {
						executionContext: context,
						failureRecovery: executor.failureRecovery,
						release: () => {
							releaseShell?.();
							lease.release();
						},
						execute: (id, params, abort, update) =>
							this.contextStorage.run(context, () => executor.execute(id, params, abort, update)),
					};
				} catch (error) {
					releaseShell?.();
					lease.release();
					throw error;
				}
			},
		};
	}

	/** Credential changes invalidate every task shell, not only the ambient legacy shell. */
	invalidateShells(): void {
		this.shells.invalidate(disposeShellExecutionSession);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.retireScope();
		await this.shells.dispose();
	}

	private async withController<T>(
		operation: (initialized: InitializedDirectory, scope: DirectoryScope) => T | Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		signal?.throwIfAborted();
		if (this.disposed) throw new Error("Task directory runtime disposed");
		const session = this.options.getSessionManager();
		const sessionId = session.getSessionId();
		const root = this.options.getCwd();
		if (
			this.scope &&
			(this.scope.session !== session || this.scope.sessionId !== sessionId || this.scope.root !== root)
		)
			this.retireScope();
		if (!this.scope) {
			const abort = new AbortController();
			const ready = this.initializeController(session, sessionId, root, abort.signal);
			const scope = { session, sessionId, root, abort, ready };
			this.scope = scope;
			// Shared, read-only setup survives a single cancelled waiter; failed setup remains retryable.
			void ready.catch(() => {
				if (this.scope === scope) this.retireScope();
			});
		}
		const scope = this.scope;
		const initialized = await awaitPreflight(() => scope.ready, signal);
		this.requireCurrentScope(scope);
		return operation(initialized, scope);
	}

	private requireCurrentScope(scope: DirectoryScope): void {
		if (this.scope !== scope) throw new Error("Task directory session changed during setup; refresh before retrying");
		this.requireScopeHost(scope.session, scope.root);
	}

	private requireScopeHost(session: SessionManager, root: string): void {
		if (this.disposed || this.options.getSessionManager() !== session || this.options.getCwd() !== root)
			throw new Error("Task directory session changed during setup; refresh before retrying");
	}

	private retireScope(): void {
		const scope = this.scope;
		if (!scope) return;
		this.scope = undefined;
		scope.abort.abort(new Error("Task directory scope retired"));
		void scope.ready.then(
			({ controller }) => controller.dispose(),
			() => {},
		);
	}

	private async initializeController(
		session: SessionManager,
		sessionId: string,
		root: string,
		signal: AbortSignal,
	): Promise<InitializedDirectory> {
		const deadline = new AbortController();
		const timer = setTimeout(
			() => deadline.abort(new Error("Task directory setup timed out; reattach the workspace")),
			TASK_DIRECTORY_INITIALIZATION_TIMEOUT_MS,
		);
		timer.unref();
		let id: string;
		let unavailable: string | undefined;
		try {
			const combined = AbortSignal.any([signal, deadline.signal]);
			id = await awaitPreflight(() => this.backend.createAttachmentId(root, "session", combined), combined);
		} catch (error) {
			signal.throwIfAborted();
			// This is an unavailable status marker, never an execution fallback. A later occupant
			// cannot gain authority; explicit reattachment must capture its native identity.
			id = randomUUID();
			unavailable = error instanceof Error ? error.message : String(error);
		} finally {
			clearTimeout(timer);
		}
		signal.throwIfAborted();
		const initialAttachment = this.attachment("session", root, id, sessionId);
		const controller = new TaskDirectoryController({
			sessionId,
			initialAttachment,
			store: createSessionTaskDirectoryStore(session, {
				sessionId,
				assertCurrent: () => {
					signal.throwIfAborted();
					this.requireScopeHost(session, root);
				},
			}),
			captureAttachmentIdentity: (attachment, abort) =>
				this.backend.createAttachmentId(attachment.root, undefined, abort),
			validate: createTaskDirectoryValidator(this.backend, this.backend.validateAttachment),
		});
		return { controller, initialAttachment, unavailable };
	}
}
