import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { SessionManager } from "@caupulican/pi-agent-core/session";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ToolDefinition } from "./extensions/types.ts";

const UPDATE_ENTRY = "runtime-update";
const MAX_ATTEMPTS = 3;
const MAX_TURNS = 12;
const stateSchema = Type.Object({
	version: Type.Literal(1),
	id: Type.String({ minLength: 1, maxLength: 256 }),
	sessionId: Type.String(),
	status: Type.Union([
		Type.Literal("queued"),
		Type.Literal("repairing"),
		Type.Literal("verifying"),
		Type.Literal("restarting"),
		Type.Literal("committing"),
		Type.Literal("complete"),
		Type.Literal("stopped"),
	]),
	mode: Type.Union([Type.Literal("reload"), Type.Literal("restart")]),
	verificationTool: Type.String({ minLength: 1, maxLength: 128 }),
	extensionPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
	attempts: Type.Integer({ minimum: 0, maximum: MAX_ATTEMPTS }),
	turns: Type.Integer({ minimum: 0, maximum: MAX_TURNS }),
	verificationAfter: Type.Optional(Type.String()),
	error: Type.Optional(Type.String({ maxLength: 2000 })),
});
export type RuntimeUpdateState = Static<typeof stateSchema>;

const toolSchema = Type.Object({
	action: Type.Union([
		Type.Literal("reload"),
		Type.Literal("restart"),
		Type.Literal("complete"),
		Type.Literal("stop"),
		Type.Literal("status"),
	]),
	verificationTool: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	extensionPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
});

export interface RuntimeRestartRequest {
	id: string;
	sessionId: string;
	sessionFile: string;
}

export interface RuntimeUpdateControllerDeps {
	sessionManager: Pick<
		SessionManager,
		"getBranch" | "appendCustomEntry" | "getSessionId" | "getSessionFile" | "getLeafId"
	>;
	getMessages(): readonly AgentMessage[];
	/** This is the transactional runtime reload, NOT session/history reconstruction. */
	reload(extensionPath?: string): Promise<void>;
	appendNotice(content: string): Promise<void>;
	isRoot(): boolean;
	onStopped?(): void;
	resume?(prepare: () => Promise<void>): Promise<void>;
}

/** Session-owned, bounded self-modification workflow. It never mutates the existing message prefix. */
export class RuntimeUpdateController {
	private readonly deps: RuntimeUpdateControllerDeps;
	private state: RuntimeUpdateState | undefined;
	private stopPending = false;
	private restoredQueued = false;
	private sourceOrigin: string | undefined;
	private cancellation = new AbortController();
	private restart: ((request: RuntimeRestartRequest, signal?: AbortSignal) => Promise<never>) | undefined;
	private restartFinalization: { commit(id: string): Promise<void>; rollback?(): Promise<void> } | undefined;

	constructor(deps: RuntimeUpdateControllerDeps) {
		this.deps = deps;
		this.refreshState();
		this.restoredQueued = this.state?.status === "queued";
	}

	private refreshState(): void {
		this.state = undefined;
		for (const entry of this.deps.sessionManager.getBranch()) {
			if (
				entry.type === "custom" &&
				entry.customType === UPDATE_ENTRY &&
				Value.Check(stateSchema, entry.data) &&
				entry.data.sessionId === this.deps.sessionManager.getSessionId()
			)
				this.state = entry.data;
		}
	}

	/** Host-only adapter; no executable, arguments, or authority can be supplied through the tool. */
	setRestartHandler(
		handler: (request: RuntimeRestartRequest, signal?: AbortSignal) => Promise<never>,
		finalization?: { commit(id: string): Promise<void>; rollback?(): Promise<void> },
	): void {
		this.restart = handler;
		this.restartFinalization = finalization;
	}

	getState(): RuntimeUpdateState | undefined {
		return this.state ? { ...this.state } : undefined;
	}

	/** Host-owned location; never accepted as a tool argument or inferred from a retained artifact. */
	setSourceOrigin(origin: string): void {
		if (!origin || origin.length > 4096 || origin.includes("\0")) throw new Error("Invalid runtime source origin.");
		this.sourceOrigin = origin;
	}

	private repairSourceNotice(): string {
		return this.sourceOrigin && this.state?.mode === "restart"
			? ` Repair the original source/install location ${JSON.stringify(this.sourceOrigin)}, not the running snapshot. For an installed release, activate a repaired release through the installer before retrying.`
			: "";
	}

	shouldStopAfterTurn(): boolean {
		return this.stopPending || this.isActive();
	}

	noteRunEnd(signal: AbortSignal | undefined): void {
		if (signal?.aborted) this.cancel();
	}

	cancel(): void {
		if (this.isActive()) this.cancellation.abort();
	}

	private isActive(): boolean {
		return this.state !== undefined && this.state.status !== "complete" && this.state.status !== "stopped";
	}

	private save(state: RuntimeUpdateState): void {
		this.deps.sessionManager.appendCustomEntry(UPDATE_ENTRY, state);
		this.state = state;
	}

	private hasVerification(): boolean {
		const state = this.state;
		if (!state?.verificationAfter) return false;
		let after = false;
		for (const entry of this.deps.sessionManager.getBranch()) {
			if (entry.id === state.verificationAfter) {
				after = true;
				continue;
			}
			if (!after || entry.type !== "message" || entry.message.role !== "toolResult") continue;
			const message = entry.message;
			if (message.toolName !== state.verificationTool || message.isError) continue;
			const details: unknown = message.details;
			if (details && typeof details === "object" && "exitCode" in details && details.exitCode !== 0) continue;
			return true;
		}
		return false;
	}

	createTool(): ToolDefinition<typeof toolSchema, unknown> {
		return {
			name: "runtime_update",
			label: "Runtime update",
			description:
				"Reload extensions or restart the host after this tool batch. Verify the change, then complete to resume the original task. Failed updates take priority; stop if unsafe.",
			promptSnippet: "Reload/restart safely; verify before resuming the original task.",
			parameters: toolSchema,
			execute: async (toolCallId, input, signal) => {
				if (!this.deps.isRoot()) throw new Error("Only the root session may update its runtime.");
				if (signal?.aborted) throw new Error("Runtime update cancelled.");
				this.refreshState();
				if (input.action === "complete") {
					if (this.state?.status !== "verifying" || !this.hasVerification()) {
						throw new Error(
							"Run the verificationTool successfully in the new runtime before completing the update.",
						);
					}
					if (this.state.mode === "restart" && !this.restartFinalization)
						throw new Error("The host cannot commit this candidate runtime.");
					this.save({ ...this.state, status: this.state.mode === "restart" ? "committing" : "complete" });
				} else if (input.action === "stop") {
					if (!this.state || !this.isActive()) throw new Error("No active runtime update.");
					this.save({
						...this.state,
						status: "stopped",
						error: "Stopped by the agent; original task remains unfinished.",
					});
					this.stopPending = true;
				} else if (input.action !== "status") {
					if (
						this.state?.status === "queued" ||
						this.state?.status === "restarting" ||
						this.state?.status === "committing" ||
						this.stopPending
					) {
						throw new Error("A runtime update is already pending; finish this tool batch first.");
					}
					if (input.action === "restart" && !this.restart)
						throw new Error("No safe core restart adapter is available in this host.");
					if (input.action === "restart" && input.extensionPath)
						throw new Error("extensionPath applies only to extension reloads.");
					if (!toolCallId || toolCallId.length > 256) throw new Error("Invalid runtime update identity.");
					if (input.action === "restart" && !this.deps.sessionManager.getSessionFile())
						throw new Error("Core restart requires a persisted session.");
					const verificationTool =
						input.verificationTool ?? (this.isActive() ? this.state?.verificationTool : undefined);
					if (!verificationTool || verificationTool === "runtime_update")
						throw new Error("Specify the tool that will verify the change.");
					const active = this.isActive() ? this.state : undefined;
					if (active && active.mode !== input.action)
						throw new Error("Cannot change update mode before the active update is verified or stopped.");
					if (!active) this.cancellation = new AbortController();
					if (active && active.attempts >= MAX_ATTEMPTS)
						throw new Error("Runtime update attempt limit reached; stop and report the failure.");
					this.save({
						version: 1,
						id: active?.id ?? toolCallId,
						sessionId: this.deps.sessionManager.getSessionId(),
						status: "queued",
						mode: input.action,
						verificationTool,
						extensionPath: input.action === "reload" ? (input.extensionPath ?? active?.extensionPath) : undefined,
						attempts: active?.attempts ?? 0,
						turns: active?.turns ?? 0,
					});
				}
				return {
					content: [{ type: "text", text: JSON.stringify(this.state ?? { status: "idle" }) }],
					details: this.getState(),
				};
			},
		};
	}

	/** Called only with the complete tool batch persisted and Agent.isStreaming=false. */
	async settle(signal?: AbortSignal): Promise<"continue" | "stop" | undefined> {
		const updateSignal = signal ? AbortSignal.any([signal, this.cancellation.signal]) : this.cancellation.signal;
		if (this.stopPending) {
			this.stopPending = false;
			this.deps.onStopped?.();
			if (this.state?.mode === "restart") await this.restartFinalization?.rollback?.();
			return "stop";
		}
		if (!this.isActive() || !this.state) return undefined;
		this.refreshState();
		if (!this.isActive() || !this.state) return undefined;
		const last = this.deps.getMessages().at(-1);
		if (updateSignal.aborted || (last?.role === "assistant" && last.stopReason === "aborted")) {
			return this.stop("Runtime update cancelled; no automatic continuation.");
		}
		if (this.restoredQueued) {
			await this.prepareInterruptedRepair();
			return "continue";
		}
		if (this.state.status === "committing") {
			try {
				if (!this.restartFinalization) throw new Error("Candidate commit adapter is unavailable.");
				await this.restartFinalization.commit(this.state.id);
				this.save({ ...this.state, status: "complete" });
				await this.deps.appendNotice(
					"Runtime update verified and committed. Continue the original task without replaying its request.",
				);
				return "continue";
			} catch (error) {
				return this.stop(`Runtime commit failed: ${String(error).slice(0, 1800)}`);
			}
		}
		if (this.state.turns >= MAX_TURNS) return this.stop("Runtime update repair/verification turn limit reached.");
		this.save({ ...this.state, turns: this.state.turns + 1 });
		if (this.state.status === "queued") {
			if (this.state.attempts >= MAX_ATTEMPTS) return this.stop("Runtime update attempt limit reached.");
			this.save({ ...this.state, attempts: this.state.attempts + 1 });
			try {
				if (this.state.mode === "restart") {
					const sessionFile = this.deps.sessionManager.getSessionFile();
					if (!sessionFile || !this.restart)
						throw new Error("Core restart adapter or persisted session unavailable.");
					this.save({ ...this.state, status: "restarting" });
					await this.restart({ id: this.state.id, sessionId: this.state.sessionId, sessionFile }, updateSignal);
				} else {
					await this.deps.reload(this.state.extensionPath);
				}
				if (updateSignal.aborted)
					return this.stop("Runtime update cancelled after reload; verify the loaded change before continuing.");
				this.save({
					...this.state,
					status: "verifying",
					verificationAfter: this.deps.sessionManager.getLeafId() ?? undefined,
				});
				await this.deps.appendNotice(
					`Runtime update loaded. Priority: verify the change using ${this.state.verificationTool}, then call runtime_update complete before resuming the original task. Import success alone is not task verification. Existing history is preserved.`,
				);
			} catch (error) {
				if (updateSignal.aborted) return this.stop("Runtime update cancelled; no automatic continuation.");
				const detail = String(error instanceof Error ? error.message : error).slice(0, 2000);
				this.save({ ...this.state, status: "repairing", error: detail });
				if (this.state.attempts >= MAX_ATTEMPTS)
					return this.stop(`Runtime update failed after ${MAX_ATTEMPTS} attempts: ${detail}`);
				await this.deps.appendNotice(
					`Runtime update failed: ${detail}\nPriority: repair and test the self-modification, then retry runtime_update. Do not resume the original task yet. Do not change permissions or settings to bypass a denial. If repair is unsafe or blocked, call runtime_update stop and report what remains. Attempt ${this.state.attempts}/${MAX_ATTEMPTS}.${this.repairSourceNotice()}`,
				);
			}
			return "continue";
		}
		if (this.state.status === "restarting") {
			await this.prepareInterruptedRepair();
			return "continue";
		}
		if (last?.role === "assistant" && last.stopReason !== "toolUse") {
			return this.stop(
				"Agent ended without completing runtime verification. Self-modification and the original task remain unfinished.",
			);
		}
		return "continue";
	}

	private async stop(reason: string): Promise<"stop"> {
		if (this.state) this.save({ ...this.state, status: "stopped", error: reason.slice(0, 2000) });
		this.restoredQueued = false;
		this.deps.onStopped?.();
		await this.deps.appendNotice(reason);
		if (this.state?.mode === "restart") await this.restartFinalization?.rollback?.();
		return "stop";
	}

	async resumeRestart(id: string, rollbackError?: string): Promise<void> {
		if (!this.deps.resume) throw new Error("Host cannot resume a runtime update.");
		if (rollbackError && (this.state?.status === "stopped" || (this.state?.attempts ?? 0) >= MAX_ATTEMPTS)) {
			await this.acceptRestart(id, rollbackError);
			await this.stop(
				"Known-good runtime restored; autonomous repair limit reached or the update was stopped. Original task remains unfinished.",
			);
			return;
		}
		await this.deps.resume(() => this.acceptRestart(id, rollbackError));
	}

	private async prepareInterruptedRepair(): Promise<void> {
		if (!this.state) return;
		this.restoredQueued = false;
		this.save({
			...this.state,
			status: "repairing",
			verificationAfter: undefined,
			error: "The process was interrupted before a verified runtime commit.",
		});
		await this.deps.appendNotice(
			`An unfinished self-modification was recovered from this session. Priority: inspect and test the change, then request runtime_update reload or restart and verify it. Do not blindly repeat an uncertain update, resume the original task, or bypass a permission denial. Existing history and repair limits remain in force.${this.repairSourceNotice()}`,
		);
	}

	/** Ordinary session restoration repairs uncertain updates automatically; it never replays a mutation. */
	async resumeInterrupted(): Promise<boolean> {
		if (!this.deps.isRoot() || !this.isActive() || !this.deps.resume) return false;
		await this.deps.resume(() => this.prepareInterruptedRepair());
		return true;
	}

	/** Exact handoff only: a later ordinary --resume never repeats a core restart. */
	async acceptRestart(id: string, rollbackError?: string): Promise<void> {
		if (
			!this.deps.isRoot() ||
			this.state?.id !== id ||
			this.state.mode !== "restart" ||
			(!rollbackError && this.state.status !== "restarting")
		) {
			throw new Error("No matching pending core runtime restart on this session branch.");
		}
		this.save({
			...this.state,
			status: rollbackError ? "repairing" : "verifying",
			error: rollbackError?.slice(0, 2000),
			verificationAfter: this.deps.sessionManager.getLeafId() ?? undefined,
		});
		await this.deps.appendNotice(
			rollbackError
				? `The candidate runtime failed and the supervisor automatically restored the known-good code in this same session: ${rollbackError.slice(0, 2000)}. Priority: repair the source change, test it, then retry runtime_update restart. Do not resume the original task or replay its request. Attempt ${this.state.attempts}/${MAX_ATTEMPTS}.${this.repairSourceNotice()}`
				: `Core runtime restarted in the same session. Priority: verify the change using ${this.state.verificationTool}, then call runtime_update complete before resuming the original task. Do not replay the original request.${this.repairSourceNotice()}`,
		);
	}
}
