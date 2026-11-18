/**
 * Records host-observed workspace evidence at physical execution boundaries. Completed writes and
 * operations with unknown effects have distinct representations throughout review and recovery.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { OrchestrationHome } from "../agent-paths.ts";
import type { WorkerClaim, WorkerHostFinding, WorkerRequest } from "../autonomy/contracts.ts";
import { hostFindingBlockerLine, uncertainWorkerMutationFinding } from "../autonomy/host-findings.ts";
import { isLaneProcessTool } from "../autonomy/lane-tool-surface.ts";
import { safeRealpathSync } from "../autonomy/path-scope.ts";
import { STABLE_SHELL_TOOL_NAME } from "../default-tool-surface.ts";
import { isProvablyObservationalToolCall } from "../model-router/tool-escalation.ts";
import type { AttemptRuntimeState } from "../orchestration/task-runtime-state.ts";
import { readWorkerActionMutationProgress } from "./worker-action-journal.ts";
import type { AppliedActionsReport } from "./worker-actions.ts";
import { collectBoundedWorkerClaimChangedFiles } from "./worker-claim.ts";
import type { WorkerConversation } from "./worker-conversation-store.ts";
import { boundHostFindings } from "./worker-write-overlap.ts";

type MutationProgressStore = Pick<
	WorkerConversation,
	"getMutationProgress" | "recordChangedFile" | "recordNativeWriteProgress" | "recordUncertainMutation"
>;

function writeTarget(cwd: string, toolName: string, args: unknown): string | undefined {
	if ((toolName !== "write" && toolName !== "edit") || !args || typeof args !== "object" || Array.isArray(args)) {
		return undefined;
	}
	const rawPath = (args as Record<string, unknown>).path;
	if (typeof rawPath !== "string" || rawPath.length === 0) return undefined;
	const absolutePath = path.resolve(cwd, rawPath);
	let canonicalPath = absolutePath;
	try {
		canonicalPath = safeRealpathSync(absolutePath);
	} catch {
		// A write may create the file after this observation.
	}
	return path.relative(cwd, canonicalPath).split(path.sep).join("/");
}

interface WorkerMutationEvidenceOptions {
	attemptId: string;
	cwd: string;
	shellReadOnly: boolean;
	store: MutationProgressStore;
	onOwnedWrite?(path: string): void;
	onPersistenceFailure(message: string): void;
}

export interface NativeWriteCompletion {
	/** Present only when the exact attempted mutation path was durably recorded. */
	readonly recordedPath?: string;
}

export class WorkerMutationEvidence {
	readonly changedFiles: Set<string>;
	private readonly options: WorkerMutationEvidenceOptions;
	private readonly inFlight = new Map<string, { writeId: string; target: string }>();
	private uncertain: boolean;
	private uncertaintyPersisted: boolean;

	constructor(options: WorkerMutationEvidenceOptions) {
		this.options = options;
		const progress = options.store.getMutationProgress(options.attemptId);
		this.changedFiles = new Set(progress.changedFiles);
		this.uncertain = this.uncertaintyPersisted = progress.uncertain;
	}

	start(toolCallId: string, toolName: string, args: unknown): void {
		const target = writeTarget(this.options.cwd, toolName, args);
		if (target !== undefined) {
			const writeId = randomUUID();
			// Record intent before file I/O so an abruptly interrupted process can still report it.
			this.options.store.recordNativeWriteProgress(this.options.attemptId, writeId);
			this.inFlight.set(toolCallId, { writeId, target });
		}
		if (
			isLaneProcessTool(toolName) &&
			(toolName !== STABLE_SHELL_TOOL_NAME ||
				(!this.options.shellReadOnly && !isProvablyObservationalToolCall(toolName, args)))
		) {
			// The observer runs immediately before physical execution and may refuse it.
			if (!this.uncertaintyPersisted) this.options.store.recordUncertainMutation(this.options.attemptId);
			this.uncertain = this.uncertaintyPersisted = true;
		}
	}

	/** Describes a successful native write, including its path when durable evidence is available. */
	end(toolCallId: string, result: unknown): NativeWriteCompletion | undefined {
		const write = this.inFlight.get(toolCallId);
		if (!write) return undefined;
		this.inFlight.delete(toolCallId);
		if (!result || (result as { isError?: boolean }).isError === true) {
			this.noteUncertainty();
			return undefined;
		}
		this.changedFiles.add(write.target);
		let recordedPath: string | undefined;
		try {
			recordedPath = this.options.store.recordNativeWriteProgress(
				this.options.attemptId,
				write.writeId,
				write.target,
			);
		} catch (error) {
			this.uncertain = true;
			this.options.onPersistenceFailure(`Worker changed-file progress could not be persisted: ${String(error)}`);
		}
		this.options.onOwnedWrite?.(write.target);
		return { recordedPath };
	}

	restoreActions(options: Omit<Parameters<typeof readWorkerActionMutationProgress>[0], "cwd" | "attemptId">): void {
		try {
			const progress = readWorkerActionMutationProgress({
				...options,
				cwd: this.options.cwd,
				attemptId: this.options.attemptId,
			});
			for (const path of progress.changedFiles) this.changedFiles.add(path);
			if (progress.uncertain) this.noteUncertainty();
		} catch (error) {
			this.noteUncertainty();
			this.options.onPersistenceFailure(`Worker action progress could not be read: ${String(error)}`);
		}
	}

	recordActions(report: AppliedActionsReport): void {
		for (const filePath of report.changedFiles) this.recordChangedFile(filePath);
		if (report.inspectionRequired.length > 0) this.noteUncertainty();
	}

	seal(): void {
		if (this.inFlight.size > 0) {
			this.inFlight.clear();
			this.uncertain = true;
		}
		this.persistUncertainty();
	}

	finding(): WorkerHostFinding | undefined {
		return this.uncertain ? uncertainWorkerMutationFinding() : undefined;
	}

	private recordChangedFile(filePath: string): void {
		this.changedFiles.add(filePath);
		try {
			this.options.store.recordChangedFile(this.options.attemptId, filePath);
		} catch (error) {
			this.options.onPersistenceFailure(`Worker changed-file progress could not be persisted: ${String(error)}`);
		}
	}

	private noteUncertainty(): void {
		this.uncertain = true;
		this.persistUncertainty();
	}

	private persistUncertainty(): void {
		if (!this.uncertain || this.uncertaintyPersisted) return;
		try {
			this.options.store.recordUncertainMutation(this.options.attemptId);
			this.uncertaintyPersisted = true;
		} catch (error) {
			this.options.onPersistenceFailure(`Worker mutation uncertainty could not be persisted: ${String(error)}`);
		}
	}
}

/** Interrupted claims share the same review fields regardless of how the execution stopped. */
export function interruptedWorkerMutationFields(
	changedFiles: Iterable<string>,
	findings: readonly WorkerHostFinding[],
): Pick<WorkerClaim, "changedFiles" | "hostFindings" | "blockers" | "parentReviewRequired"> {
	const { values: paths, overflowed } = collectBoundedWorkerClaimChangedFiles([...changedFiles]);
	const hostFindings = boundHostFindings(overflowed ? [...findings, uncertainWorkerMutationFinding()] : findings);
	return {
		changedFiles: paths,
		...(hostFindings.length > 0 ? { hostFindings, blockers: hostFindings.map(hostFindingBlockerLine) } : {}),
		...(paths.length > 0 || hostFindings.length > 0 ? { parentReviewRequired: true } : {}),
	};
}

/** Unleased cancellation recovers its exact attempt's progress without creating a fenced worker result. */
export function retainCancelledWorkerMutationClaim(options: {
	attempt: AttemptRuntimeState;
	hasClaim(): boolean;
	openConversation(): WorkerConversation | undefined;
	journal?: { orchestrationHome: OrchestrationHome; parentSessionId: string };
	saveClaim(claim: WorkerClaim, request?: WorkerRequest, options?: { cwd?: string; attemptId?: string }): void;
	warn(message: string): void;
}): boolean {
	const { attempt } = options;
	if (
		attempt.status !== "cancelled" ||
		attempt.result ||
		!attempt.agentId ||
		!attempt.executionStartedAt ||
		attempt.dispatch.executionKind === "managed-process" ||
		options.hasClaim()
	)
		return true;
	let conversation: WorkerConversation | undefined;
	try {
		conversation = options.openConversation();
	} catch (error) {
		options.warn(`Worker conversation for canceled attempt ${attempt.attemptId} is unavailable: ${String(error)}`);
	}
	try {
		const progress = conversation?.getMutationProgress(attempt.attemptId);
		const authority = attempt.dispatch.executionContract?.worker.authority;
		const allowedTools = attempt.grant?.allowedTools ?? authority?.toolNames ?? [];
		const unavailable =
			!progress?.matched &&
			allowedTools.some((tool) => tool === "write" || tool === "edit" || isLaneProcessTool(tool));
		const cwd = authority?.cwd ?? conversation?.getResumeContext().cwd;
		let actions: ReturnType<typeof readWorkerActionMutationProgress> | undefined;
		let journalUnavailable = false;
		if (
			options.journal &&
			cwd &&
			(attempt.grant?.capabilities ?? authority?.capabilities)?.includes("filesystem.write")
		) {
			try {
				actions = readWorkerActionMutationProgress({
					...options.journal,
					cwd,
					taskId: attempt.taskId,
					attemptId: attempt.attemptId,
				});
			} catch (error) {
				journalUnavailable = true;
				options.warn(
					`Worker action evidence for canceled attempt ${attempt.attemptId} is unavailable: ${String(error)}`,
				);
			}
		}
		const changedFiles = [...(progress?.changedFiles ?? []), ...(actions?.changedFiles ?? [])];
		const uncertain = progress?.uncertain || actions?.uncertain || unavailable || journalUnavailable;
		if (!uncertain && changedFiles.length === 0) return true;
		const findings = uncertain ? [uncertainWorkerMutationFinding()] : [];
		options.saveClaim(
			{
				requestId: attempt.taskId,
				terminalAttemptId: attempt.attemptId,
				status: "cancelled",
				summary: "Canceled by the parent before the worker reported.",
				...interruptedWorkerMutationFields(changedFiles, findings),
				createdAt: attempt.updatedAt,
			},
			undefined,
			{ cwd, attemptId: attempt.attemptId },
		);
		return true;
	} catch (error) {
		options.warn(`Could not retain canceled worker mutation evidence for ${attempt.attemptId}: ${String(error)}`);
		return false;
	}
}
