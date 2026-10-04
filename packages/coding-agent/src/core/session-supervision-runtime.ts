import type { ProcessObservation } from "../kernel/reliability/process-tree.ts";
import type { AgentSession } from "./agent-session.ts";
import type { ActiveSessionContext, AgentSessionRuntimeResource } from "./agent-session-runtime.ts";
import { createCollaborationPeerContext } from "./collaboration/peer-context.ts";
import { isGoalExecutionActive } from "./goals/goal-state.ts";
import { createAgentIdentity } from "./orchestration/agent-resume.ts";
import type { OrphanCleanupRequest, OwnerCleanupDecision, ResumablePayload } from "./process-matrix/codes.ts";
import {
	CLOCK_JUMP_CUSTOM_TYPE,
	getOrchestrationAgentId,
	getProcessTaskRef,
	type ProcessMatrixRuntimeHandle,
	type ResumeWorkerLaunchOutcome,
	startProcessMatrixRuntime,
} from "./process-matrix/runtime.ts";
import { getBoundWorktreeLaneKey } from "./worktree-sync/lane-binding.ts";
import type { WorktreeSyncRuntimeHandle } from "./worktree-sync/runtime.ts";
import { startWorktreeSyncRuntime } from "./worktree-sync/runtime.ts";

/** How long an unanswered cleanup question stays open; expiry is "not approved", never consent. */
const OWNER_CLEANUP_DIALOG_TIMEOUT_MS = 120_000;
const OWNER_QUESTION_TEXT_LIMIT = 300;

/** Matrix fields came from another process's file: no control characters may reach the terminal. */
function printableMatrixText(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.trim()
		.slice(0, OWNER_QUESTION_TEXT_LIMIT);
}

function formatOrphanCleanupQuestion(request: OrphanCleanupRequest): string {
	const task = printableMatrixText(request.taskSummary ?? request.taskRef ?? "") || "unknown";
	const parent = request.parentPid !== undefined ? ` (pid ${request.parentPid})` : "";
	return [
		`Pi worker ${printableMatrixText(request.entryId)} (pid ${request.pid}) is still running, but its parent process${parent} is gone.`,
		`Task: ${task}`,
		"Ask it to wind down? It exits on its own and nothing is killed. No answer leaves it running.",
	].join("\n");
}

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
	orchestrationProfileId?: string;
	observeProcess: (pid: number) => ProcessObservation;
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

	start(session: AgentSession, active: ActiveSessionContext): Promise<void> {
		const generation = ++this.generation;
		return this.enqueueLifecycle(() => this.startGeneration(session, active, generation));
	}

	private async startGeneration(
		session: AgentSession,
		active: ActiveSessionContext,
		generation: number,
	): Promise<void> {
		await this.stopHandles();
		const sessionManager = active.sessionManager;
		const settingsManager = active.services.settingsManager;
		const sessionId = sessionManager.getSessionId();
		const boundWorktreeLaneKey = getBoundWorktreeLaneKey();
		const orchestrationProfileId =
			this.options.orchestrationProfileId ??
			session.capabilityEnvelope?.profileId ??
			settingsManager.getActiveOrchestrationProfile();
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
			resourceProfileNames: settingsManager.getActiveResourceProfileNames(),
			...(session.model ? { modelRef: `${session.model.provider}/${session.model.id}` } : {}),
			contextPointers: [],
		});

		const [worktreeResult, processMatrixResult] = await Promise.allSettled([
			Promise.resolve().then(() =>
				startWorktreeSyncRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.options.agentDir,
					settingsManager: settingsManager,
					sessionId,
					integrationBranch: () => session.localCommitBranch() || undefined,
					notify: (text) => {
						void this.notify(session, "worktree-sync-notice", text).catch(() => {});
					},
					onDiagnostic: this.options.onDiagnostic,
				}),
			),
			Promise.resolve().then(() =>
				startProcessMatrixRuntime({
					agentDir: this.options.agentDir,
					parentOwnership: createCollaborationPeerContext()?.parentOwnership,
					agent,
					...(taskRef ? { taskRef } : {}),
					taskSummary: goal?.userGoal,
					allowAutomaticRecovery: goal === undefined || isGoalExecutionActive(goal.status),
					resumeWorker: (payload) => this.options.resumeWorker(payload, sessionId),
					settings: settingsManager.getProcessMatrixSettings(),
					observeProcess: this.options.observeProcess,
					notify: (text) => this.notify(session, "process-matrix-notice", text),
					recordClockJump: (record) => void sessionManager.appendCustomEntry(CLOCK_JUMP_CUSTOM_TYPE, record),
					onDiagnostic: this.options.onDiagnostic,
					requestExit: this.options.requestExit,
					requestOwnerCleanupDecision: (request, signal) => this.askOwnerAboutOrphan(active, request, signal),
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

	/**
	 * Put a live orphan to the owner through the session's UI. Supervision starts before the mode binds
	 * its UI, so the question waits for the bind event; a headless mode never binds one and the
	 * question stays unasked (the runtime has already reported the orphan as a pending decision).
	 */
	private async askOwnerAboutOrphan(
		active: ActiveSessionContext,
		request: OrphanCleanupRequest,
		signal: AbortSignal,
	): Promise<OwnerCleanupDecision> {
		if (!active.extensionRunner.hasUI()) {
			await new Promise<void>((resolve) => {
				const done = (): void => {
					unsubscribe();
					signal.removeEventListener("abort", done);
					resolve();
				};
				const unsubscribe = active.extensionRunner.onUIContextBound(done);
				signal.addEventListener("abort", done, { once: true });
				if (signal.aborted) done();
			});
		}
		const runner = active.extensionRunner;
		if (signal.aborted || !runner.hasUI()) return "unanswered";
		const startedAt = Date.now();
		const approved = await runner.getUIContext().confirm("Orphaned Pi worker", formatOrphanCleanupQuestion(request), {
			timeout: OWNER_CLEANUP_DIALOG_TIMEOUT_MS,
			signal,
		});
		if (approved) return "approved";
		return signal.aborted || Date.now() - startedAt >= OWNER_CLEANUP_DIALOG_TIMEOUT_MS ? "unanswered" : "declined";
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
