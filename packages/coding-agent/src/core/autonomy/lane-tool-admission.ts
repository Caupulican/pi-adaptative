import type { BeforeToolCallResult } from "../../kernel/index.ts";
import { type ReadOnlyShellLaneScope, readOnlyShellViolation } from "../model-router/tool-escalation.ts";
import { type CapabilityGateway, CapabilityGatewayDeniedError } from "../orchestration/capability-gateway.ts";
import type { ToolCapabilityManifest } from "../orchestration/contracts.ts";
import { READ_ONLY_SHELL_TOOL_NAMES } from "../tool-capability-policy.ts";
import type { CapabilityEnvelope } from "./contracts.ts";
import { classifyYoloBoundary } from "./edge-policy.ts";
import { evaluateToolGate } from "./gates.ts";

/** The same scope guidance accompanies every lane write refusal. */
export const WORKER_WRITE_SCOPE_GUIDANCE =
	"A worker writes only inside its working directory plus the roots its dispatcher granted with writePaths. Do not route around this: finish what is in scope and report to the parent the absolute path you need to write and why, so it can start a new worker with writePaths for it (a worker's own write scope cannot be widened).";

const WRITE_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

export interface LaneToolAdmissionEvent {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: unknown;
}

interface LaneToolAdmissionOptions {
	readonly cwd: string;
	readonly allowedTools: ReadonlySet<string>;
	readonly manifests: ReadonlyMap<string, ToolCapabilityManifest>;
	readonly gateway?: CapabilityGateway;
	readonly yolo?: boolean;
	/**
	 * Present for a `readOnly` grant's shell: its commands are judged by the read/write line plus this lane's
	 * network grant, scratch directory and private paths (`readOnlyShellViolation`).
	 */
	readonly readOnlyShell?: ReadOnlyShellLaneScope;
	readonly denyCommands?: readonly string[];
	readonly readEnvelope: CapabilityEnvelope;
	readonly writeEnvelope: CapabilityEnvelope;
	readonly writeProtectionEnvelope?: CapabilityEnvelope;
	readonly yoloWriteScopeEnvelope?: CapabilityEnvelope;
	assertOpen(): void;
	checkEdge?(
		toolName: string,
		args: unknown,
		cwd: string,
	): Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;
}

/** One execution admission path; preparation may inspect structure but cannot spend or admit work. */
export class LaneToolAdmission {
	private readonly options: LaneToolAdmissionOptions;
	private failure: { readonly error: unknown } | undefined;
	private observer: ((event: LaneToolAdmissionEvent) => void) | undefined;
	private hadObserver = false;

	constructor(options: LaneToolAdmissionOptions) {
		this.options = options;
	}

	assertHealthy(): void {
		if (this.failure) throw this.failure.error;
	}

	/** The executor owns admission-dependent attribution; a callback failure prevents dispatch. */
	subscribe(observer: (event: LaneToolAdmissionEvent) => void): () => void {
		this.options.assertOpen();
		if (this.observer) throw new Error("Lane tool admission already has an attribution owner.");
		this.observer = observer;
		this.hadObserver = true;
		return () => {
			if (this.observer === observer) this.observer = undefined;
		};
	}

	/** Pure policy diagnostics, shared by preparation and the mandatory execution boundary. */
	check(toolName: string, args: unknown): BeforeToolCallResult | undefined {
		this.assertHealthy();
		const options = this.options;
		options.assertOpen();
		if (!options.allowedTools.has(toolName))
			return { block: true, reason: `Lane tool '${toolName}' is outside the materialized UAC surface.` };
		if (options.readOnlyShell && READ_ONLY_SHELL_TOOL_NAMES.has(toolName.toLowerCase())) {
			const command = (args as { command?: unknown } | undefined)?.command;
			const violation =
				typeof command === "string"
					? readOnlyShellViolation(command, options.cwd, {
							lane: options.readOnlyShell,
							dialect: toolName.toLowerCase() === "powershell" ? "powershell" : "posix",
						})
					: undefined;
			if (violation)
				return {
					block: true,
					reason: `Read-only worker: ${violation}. Read, search and inspect freely; write scratch output only under $TMPDIR (this worker's own scratch directory, removed when it ends); report any change, network access or private file that is needed to the parent instead of reaching it.`,
				};
		}
		if (options.writeProtectionEnvelope && WRITE_TOOLS.has(toolName)) {
			const protection = evaluateToolGate({
				toolName,
				args,
				cwd: options.cwd,
				envelope: options.writeProtectionEnvelope,
			});
			if (protection.outcome !== "allow")
				return {
					block: true,
					reason: `Harness resource is write-protected (${protection.reasonCode}): ${protection.message ?? "write refused"}`,
				};
		}
		if (options.yolo) {
			const boundary = classifyYoloBoundary({
				toolName,
				args,
				cwd: options.cwd,
				scopeCwd: options.cwd,
				denyCommands: options.denyCommands,
			});
			if (boundary)
				return {
					block: true,
					reason:
						boundary.kind === "confirm"
							? `Owner approval required: ${boundary.reason}`
							: `YOLO hardline: ${boundary.reason}`,
				};
			if (options.yoloWriteScopeEnvelope && WRITE_TOOLS.has(toolName)) {
				const scope = evaluateToolGate({
					toolName,
					args,
					cwd: options.cwd,
					envelope: options.yoloWriteScopeEnvelope,
				});
				if (scope.outcome !== "allow")
					return {
						block: true,
						reason: `Lane tool blocked (${scope.reasonCode}): ${scope.message ?? "write is outside this worker's scope"} ${WORKER_WRITE_SCOPE_GUIDANCE}`,
					};
			}
		} else if (!options.gateway) {
			const outcome = evaluateToolGate({
				toolName,
				args,
				cwd: options.cwd,
				envelope: WRITE_TOOLS.has(toolName) ? options.writeEnvelope : options.readEnvelope,
			});
			if (outcome.outcome !== "allow")
				return {
					block: true,
					reason: `Lane tool blocked (${outcome.reasonCode}): ${outcome.message ?? "capability gate denied it"}${WRITE_TOOLS.has(toolName) && outcome.reasonCode.includes("path") ? ` ${WORKER_WRITE_SCOPE_GUIDANCE}` : ""}`,
				};
		}
		return undefined;
	}

	async admit(event: LaneToolAdmissionEvent, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> {
		try {
			signal?.throwIfAborted();
			const structural = this.check(event.toolName, event.args);
			if (structural?.block) return structural;
			const { gateway, manifests, yolo, checkEdge, cwd } = this.options;
			const observer = this.observer;
			if (this.hadObserver && !observer) throw new Error("Lane tool execution attribution is closed.");
			const manifest = gateway && !yolo ? manifests.get(event.toolName) : undefined;
			if (gateway && !yolo) {
				if (!manifest)
					return { block: true, reason: `Lane tool '${event.toolName}' has no compiled capability manifest.` };
				gateway.checkToolCallEligibility(manifest, event.toolName, event.args);
				gateway.assertBudgetAvailable(event.toolName);
			}
			const edge = await checkEdge?.(event.toolName, event.args, cwd);
			signal?.throwIfAborted();
			this.assertHealthy();
			this.options.assertOpen();
			if (this.observer !== observer) throw new Error("Lane tool execution attribution changed before dispatch.");
			if (edge?.block) return edge;
			if (gateway && manifest) gateway.authorizeToolCall(manifest, event.toolName, event.args);
			observer?.(event);
			return undefined;
		} catch (error) {
			if (error instanceof CapabilityGatewayDeniedError && error.status !== "budget_exhausted")
				return {
					block: true,
					reason: `Lane tool blocked (${error.reasonCode}): ${error.message}${error.reasonCode === "scope_denied" ? ` ${WORKER_WRITE_SCOPE_GUIDANCE}` : ""}`,
				};
			// The kernel projects thrown tool errors. Retain fatal admission failures independently
			// so a later report cannot turn exhausted authority or failed accounting into success.
			if (!signal?.aborted) this.failure ??= { error };
			throw error;
		}
	}
}
