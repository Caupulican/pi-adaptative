/**
 * Standalone bash-command execution (the `/bash` path + extension-driven bash).
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Owns the bash abort controller
 * and the pending-message queue that defers appending a bash result while the agent is streaming (so
 * tool_use/tool_result ordering is never broken); the deferred messages are flushed by the session on
 * agent turn completion. Persists results through the session log via deps.
 */

import type { Agent, BashExecutionMessage } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { type BashOperations, createLocalPlatformShellOperations, resolveCommandTimeoutSeconds } from "./tools/bash.ts";

export interface BashExecutionControllerDeps {
	getAgent(): Agent;
	getSessionManager(): SessionManager;
	getSettingsManager(): SettingsManager;
	/** Whether the agent is currently streaming — defers appending a bash result if so. */
	isStreaming(): boolean;
	/** Per-agent persistent shell session key — user `!` commands share the agent's shell state. */
	getShellSessionKey?(): string;
}

export interface BashExecutionOptions {
	excludeFromContext?: boolean;
	operations?: BashOperations;
	/** Injectable target platform for tests and embedded runtimes. */
	platform?: NodeJS.Platform;
	/** Wall-clock timeout in seconds; non-positive values use the bounded default. */
	timeout?: number;
	/** Route complex/state-mutating Bash constructs to the Python engine on Windows. Default: true. */
	pythonEngine?: boolean;
}

export class BashExecutionController {
	private _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	private readonly deps: BashExecutionControllerDeps;

	constructor(deps: BashExecutionControllerDeps) {
		this.deps = deps;
	}

	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: BashExecutionOptions,
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		const commandPrefix = this.deps.getSettingsManager().getShellCommandPrefix();
		const shellPath = this.deps.getSettingsManager().getShellPath();
		const platform = options?.platform ?? process.platform;
		const enableGitFilter = !options?.operations && !commandPrefix && !shellPath;
		const operations = createLocalPlatformShellOperations(
			{
				shellPath,
				commandPrefix,
				operations: options?.operations,
				sessionKey: this.deps.getShellSessionKey?.(),
				pythonEngine: options?.pythonEngine,
			},
			platform,
		);

		try {
			const result = await executeBashWithOperations(command, this.deps.getSessionManager().getCwd(), operations, {
				onChunk,
				signal: abortController.signal,
				enableGitFilter,
				timeout: resolveCommandTimeoutSeconds(options?.timeout),
			});

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.deps.isStreaming()) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.deps.getAgent().state.messages.push(bashMessage);

			// Save to session
			this.deps.getSessionManager().appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const controller of this._bashAbortControllers) {
			controller.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.deps.getAgent().state.messages.push(bashMessage);

			// Save to session
			this.deps.getSessionManager().appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}
}
