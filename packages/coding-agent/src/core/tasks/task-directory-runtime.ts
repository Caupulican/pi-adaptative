import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
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

/** Native runtime adapter: one admission owner, no process-global chdir or competing task cursor. */
export class TaskDirectoryRuntime {
	private readonly options: TaskDirectoryRuntimeOptions;
	private readonly contextStorage = new AsyncLocalStorage<ExecutionContext>();
	private readonly backend = createNativeTaskDirectoryBackend();
	private readonly hostPrefix =
		`native:${createHash("sha256").update(`${process.platform}\0${hostname()}`).digest("hex").slice(0, 32)}:`;
	private readonly shells = new TaskShellSessions(disposeShellExecutionSessionAndWait);
	private controller: TaskDirectoryController | undefined;
	private sessionId: string | undefined;
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
	get snapshot() {
		return this.currentController().snapshot;
	}
	get effectiveContext(): ExecutionContext {
		return resolveTaskDirectoryContext(
			this.snapshot,
			this.activeTaskId,
			this.options.getSessionManager().getSessionId(),
			true,
		);
	}

	createAttachment(workspaceId: string, root: string): ExecutionAttachment {
		return createExecutionContext({
			attachment: {
				workspaceId,
				attachmentId: `${this.hostPrefix}${randomUUID()}`,
				root,
				flavor: this.backend.flavor,
				caseSensitive: this.backend.flavor !== "win32",
			},
			cwd: root,
			sessionId: this.options.getSessionManager().getSessionId(),
			generation: 0,
		}).attachment;
	}

	change(command: TaskDirectoryCommand, signal?: AbortSignal) {
		return this.currentController().change(command, signal);
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
				const lease = await this.currentController().admit(this.activeTaskId, signal, true);
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
		this.controller?.dispose();
		await this.shells.dispose();
	}

	private currentController(): TaskDirectoryController {
		if (this.disposed) throw new Error("Task directory runtime disposed");
		const session = this.options.getSessionManager();
		const sessionId = session.getSessionId();
		if (this.controller && this.sessionId === sessionId) return this.controller;
		this.controller?.dispose();
		const root = this.options.getCwd();
		const initialAttachment = {
			...this.createAttachment("session", root),
			attachmentId: `${this.hostPrefix}session:${createHash("sha256").update(root).digest("hex").slice(0, 32)}`,
		};
		this.controller = new TaskDirectoryController({
			sessionId,
			initialAttachment,
			store: createSessionTaskDirectoryStore(session),
			validate: createTaskDirectoryValidator(this.backend, async (context) => {
				if (!context.attachment.attachmentId.startsWith(this.hostPrefix))
					throw new Error(
						"Workspace attachment belongs to another host; use task_directory reattach before executing",
					);
			}),
		});
		this.sessionId = sessionId;
		return this.controller;
	}
}
