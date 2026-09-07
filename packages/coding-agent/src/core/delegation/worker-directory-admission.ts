import type { AgentTool } from "@caupulican/pi-agent-core";
import { createExecutionContext, type ExecutionContext } from "@caupulican/pi-agent-core/paths";
import type { WorkerExecutionContract, WorkerProfileExecutionContract } from "../orchestration/contracts.ts";
import { parseWorkerExecutionContract } from "../orchestration/worker-execution-contract.ts";
import { awaitPreflight } from "../preflight.ts";
import { createNativeTaskDirectoryBackend } from "../tasks/native-task-directory-backend.ts";
import { createTaskDirectoryValidator } from "../tasks/task-directory-validation.ts";

export const WORKER_DIRECTORY_PREFLIGHT_TIMEOUT_MS = 10_000;

/** Captures native worker directory identity before durable dispatch and checks the saved identity on execution. */
export class WorkerDirectoryAdmission {
	private readonly backend = createNativeTaskDirectoryBackend();
	private readonly validate = createTaskDirectoryValidator(this.backend, this.backend.validateAttachment);

	/** Fixed task binding: validate before each call, while the core owns invocation receipt identity. */
	bindTool(tool: AgentTool, input: ExecutionContext): AgentTool {
		const executionContext = createExecutionContext(input);
		return {
			...tool,
			execute: tool.execute.bind(tool),
			bindInvocation: async (id, args, signal) => {
				const deadline = AbortSignal.timeout(WORKER_DIRECTORY_PREFLIGHT_TIMEOUT_MS);
				await this.validateContext(executionContext, signal ? AbortSignal.any([signal, deadline]) : deadline);
				signal?.throwIfAborted();
				// A host-supplied backend still owns its executor, context, and lease. Do not replace
				// them with the native directory metadata or acquire the backend lease twice.
				if (tool.bindInvocation) return tool.bindInvocation(id, args, signal);
				return {
					executionContext,
					execute: tool.execute.bind(tool),
					failureRecovery: tool.failureRecovery,
					release() {},
				};
			},
		};
	}

	async capture(
		contract: WorkerExecutionContract,
		sessionId: string,
		signal: AbortSignal,
	): Promise<WorkerExecutionContract> {
		const captureProfile = async (
			profile: WorkerProfileExecutionContract,
		): Promise<WorkerProfileExecutionContract> => {
			if (profile.executionContext) {
				await this.validateContext(profile.executionContext, signal);
				return profile;
			}
			const cwd = profile.authority.cwd;
			if (!cwd) throw new Error("Worker directory is unknown; explicitly select a directory before dispatch");
			const attachmentId = await this.backend.createAttachmentId(cwd, undefined, signal);
			const executionContext = createExecutionContext({
				attachment: {
					workspaceId: "worker",
					attachmentId,
					root: cwd,
					flavor: this.backend.flavor,
					caseSensitive: this.backend.flavor !== "win32",
				},
				cwd,
				sessionId,
				generation: 0,
			});
			await this.validateContext(executionContext, signal);
			return { ...profile, executionContext };
		};
		const worker = await captureProfile(contract.worker);
		const verifier = contract.verifier ? await captureProfile(contract.verifier) : undefined;
		return parseWorkerExecutionContract({ ...contract, worker, ...(verifier ? { verifier } : {}) });
	}

	async validateContext(context: ExecutionContext, signal: AbortSignal): Promise<void> {
		await awaitPreflight(() => this.validate(context, signal), signal);
	}

	async validateWorker(
		contract: WorkerExecutionContract | undefined,
		signal: AbortSignal,
		legacyCwd?: string,
	): Promise<void> {
		const context = contract?.worker.executionContext;
		if (!context) {
			// Historical contracts cannot prove a physical identity they never recorded. Preserve
			// their existing path-based recovery, but only when the controller supplies the cwd
			// resolved by current authority admission. A malformed/new binding never enters here.
			if (!contract || !legacyCwd)
				throw new Error(
					"Worker directory identity is unavailable; explicitly dispatch a fresh worker in the selected directory",
				);
			if (contract.worker.authority.cwd && contract.worker.authority.cwd !== legacyCwd)
				throw new Error("Legacy worker directory differs from its admitted cwd");
			await awaitPreflight(() => this.backend.resolveDirectory(legacyCwd, signal), signal);
			signal.throwIfAborted();
			return;
		}
		await this.validateContext(context, signal);
	}
}
