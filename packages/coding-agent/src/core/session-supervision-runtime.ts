import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeResource } from "./agent-session-runtime.ts";
import { isGoalExecutionActive } from "./goals/goal-state.ts";
import { createAgentIdentity } from "./orchestration/agent-resume.ts";
import type { ResumablePayload } from "./process-matrix/codes.ts";
import {
	getOrchestrationAgentId,
	getProcessTaskRef,
	type ProcessMatrixRuntimeHandle,
	type ResumeWorkerLaunchOutcome,
	startProcessMatrixRuntime,
} from "./process-matrix/runtime.ts";
import type { WorktreeSyncRuntimeHandle } from "./worktree-sync/runtime.ts";
import { getBoundWorktreeLaneKey, startWorktreeSyncRuntime } from "./worktree-sync/runtime.ts";

function rejectionReasons(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
	return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

function throwLifecycleErrors(errors: readonly unknown[], message: string): void {
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, message);
}

async function stopSupervisionHandles(
	worktreeSync: WorktreeSyncRuntimeHandle | undefined,
	processMatrix: ProcessMatrixRuntimeHandle | undefined,
): Promise<void> {
	const results = await Promise.allSettled([
		Promise.resolve().then(() => worktreeSync?.stop()),
		Promise.resolve().then(() => processMatrix?.stop()),
	]);
	throwLifecycleErrors(rejectionReasons(results), "Session supervision shutdown failed.");
}

export interface SessionSupervisionRuntimeOptions {
	agentDir: string;
	hasUI: boolean;
	orchestrationProfileId?: string;
	isProcessAlive: (pid: number) => boolean;
	promptConfirm: (message: string) => Promise<boolean>;
	resumeWorker: (payload: ResumablePayload, parentSessionId: string) => Promise<ResumeWorkerLaunchOutcome>;
	onDiagnostic: (message: string) => void;
	requestExit: () => Promise<void>;
}

/**
 * Owns the process-matrix and worktree-sync handles for the currently active session.
 * Replacement stops the old generation before a new one is started, so no watcher can retain a
 * disposed session or deliver a notice across a `/new`, `/resume`, or `/fork` boundary.
 */
export class SessionSupervisionRuntime implements AgentSessionRuntimeResource {
	private readonly options: SessionSupervisionRuntimeOptions;
	private generation = 0;
	private lifecycleTail: Promise<void> = Promise.resolve();
	private processMatrix?: ProcessMatrixRuntimeHandle;
	private worktreeSync?: WorktreeSyncRuntimeHandle;

	constructor(options: SessionSupervisionRuntimeOptions) {
		this.options = options;
	}

	start(session: AgentSession): Promise<void> {
		const generation = ++this.generation;
		return this.enqueueLifecycle(() => this.startGeneration(session, generation));
	}

	private async startGeneration(session: AgentSession, generation: number): Promise<void> {
		await this.stopHandles();
		const sessionManager = session.sessionManager;
		const sessionId = sessionManager.getSessionId();
		const boundWorktreeLaneKey = getBoundWorktreeLaneKey();
		const orchestrationProfileId =
			this.options.orchestrationProfileId ??
			session.capabilityEnvelope?.profileId ??
			session.settingsManager.getActiveOrchestrationProfile();
		const sessionFile = sessionManager.getSessionFile();
		const goal = session.getGoalStateSnapshot();
		const taskRef = getProcessTaskRef() ?? goal?.goalId;
		const agent = createAgentIdentity(getOrchestrationAgentId() ?? sessionId, {
			provider: "pi",
			sessionId,
			sessionDir: sessionManager.getSessionDir(),
			...(sessionFile ? { sessionFile } : {}),
			cwd: sessionManager.getCwd(),
			...(boundWorktreeLaneKey ? { worktreeLaneKey: boundWorktreeLaneKey } : {}),
			...(orchestrationProfileId ? { orchestrationProfileId } : {}),
			resourceProfileNames: session.settingsManager.getActiveResourceProfileNames(),
			...(session.model ? { modelRef: `${session.model.provider}/${session.model.id}` } : {}),
			contextPointers: [],
		});

		const [worktreeResult, processMatrixResult] = await Promise.allSettled([
			Promise.resolve().then(() =>
				startWorktreeSyncRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.options.agentDir,
					settingsManager: session.settingsManager,
					sessionId,
					notify: (text) => {
						void this.notify(session, "worktree-sync-notice", text).catch(() => {});
					},
					onDiagnostic: this.options.onDiagnostic,
				}),
			),
			Promise.resolve().then(() =>
				startProcessMatrixRuntime({
					agentDir: this.options.agentDir,
					agent,
					...(taskRef ? { taskRef } : {}),
					taskSummary: goal?.userGoal,
					allowAutomaticRecovery: goal === undefined || isGoalExecutionActive(goal.status),
					resumeWorker: (payload) => this.options.resumeWorker(payload, sessionId),
					hasUI: this.options.hasUI,
					settings: session.settingsManager.getProcessMatrixSettings(),
					isProcessAlive: this.options.isProcessAlive,
					promptConfirm: this.options.promptConfirm,
					notify: (text) => this.notify(session, "process-matrix-notice", text),
					onDiagnostic: this.options.onDiagnostic,
					requestExit: this.options.requestExit,
				}),
			),
		]);
		const worktreeSync = worktreeResult.status === "fulfilled" ? worktreeResult.value : undefined;
		const processMatrix = processMatrixResult.status === "fulfilled" ? processMatrixResult.value : undefined;
		const startupErrors = rejectionReasons([worktreeResult, processMatrixResult]);
		if (startupErrors.length > 0) {
			try {
				await stopSupervisionHandles(worktreeSync, processMatrix);
			} catch (error) {
				startupErrors.push(error);
			}
			throwLifecycleErrors(startupErrors, "Session supervision startup failed.");
			return;
		}

		if (generation !== this.generation) {
			await stopSupervisionHandles(worktreeSync, processMatrix);
			return;
		}
		this.worktreeSync = worktreeSync;
		this.processMatrix = processMatrix;
	}

	stop(): Promise<void> {
		this.generation++;
		return this.enqueueLifecycle(() => this.stopHandles());
	}

	private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
		const current = this.lifecycleTail.then(operation);
		this.lifecycleTail = current.catch(() => {});
		return current;
	}

	private async stopHandles(): Promise<void> {
		const worktreeSync = this.worktreeSync;
		const processMatrix = this.processMatrix;
		this.worktreeSync = undefined;
		this.processMatrix = undefined;
		await stopSupervisionHandles(worktreeSync, processMatrix);
	}

	private async notify(session: AgentSession, customType: string, text: string): Promise<void> {
		try {
			await session.sendCustomMessage(
				{ customType, content: text, display: true },
				{ triggerTurn: true, deliverAs: "steer" },
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.options.onDiagnostic(`${customType}: failed to notify session: ${message}`);
			throw error;
		}
	}
}
