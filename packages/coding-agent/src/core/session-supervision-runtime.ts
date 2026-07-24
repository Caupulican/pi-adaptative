import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeResource } from "./agent-session-runtime.ts";
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

export interface SessionSupervisionRuntimeOptions {
	agentDir: string;
	hasUI: boolean;
	orchestrationProfileId?: string;
	isProcessAlive: (pid: number) => boolean;
	promptConfirm: (message: string) => Promise<boolean>;
	resumeWorker: (payload: ResumablePayload, parentSessionId: string) => Promise<ResumeWorkerLaunchOutcome>;
	onDiagnostic: (message: string) => void;
	requestExit: (session: AgentSession) => void;
}

/**
 * Owns the process-matrix and worktree-sync handles for the currently active session.
 * Replacement stops the old generation before a new one is started, so no watcher can retain a
 * disposed session or deliver a notice across a `/new`, `/resume`, or `/fork` boundary.
 */
export class SessionSupervisionRuntime implements AgentSessionRuntimeResource {
	private readonly options: SessionSupervisionRuntimeOptions;
	private generation = 0;
	private processMatrix?: ProcessMatrixRuntimeHandle;
	private worktreeSync?: WorktreeSyncRuntimeHandle;

	constructor(options: SessionSupervisionRuntimeOptions) {
		this.options = options;
	}

	async start(session: AgentSession): Promise<void> {
		const generation = ++this.generation;
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

		const [worktreeSync, processMatrix] = await Promise.all([
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
			startProcessMatrixRuntime({
				agentDir: this.options.agentDir,
				agent,
				...(taskRef ? { taskRef } : {}),
				taskSummary: goal?.userGoal,
				allowAutomaticRecovery: goal === undefined || goal.status === "active",
				resumeWorker: (payload) => this.options.resumeWorker(payload, sessionId),
				hasUI: this.options.hasUI,
				settings: session.settingsManager.getProcessMatrixSettings(),
				isProcessAlive: this.options.isProcessAlive,
				promptConfirm: this.options.promptConfirm,
				notify: (text) => this.notify(session, "process-matrix-notice", text),
				onDiagnostic: this.options.onDiagnostic,
				requestExit: () => this.options.requestExit(session),
			}),
		]);

		if (generation !== this.generation) {
			await Promise.all([worktreeSync.stop(), processMatrix.stop()]);
			return;
		}
		this.worktreeSync = worktreeSync;
		this.processMatrix = processMatrix;
	}

	async stop(): Promise<void> {
		this.generation++;
		await this.stopHandles();
	}

	private async stopHandles(): Promise<void> {
		const worktreeSync = this.worktreeSync;
		const processMatrix = this.processMatrix;
		this.worktreeSync = undefined;
		this.processMatrix = undefined;
		await Promise.all([worktreeSync?.stop(), processMatrix?.stop()]);
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
