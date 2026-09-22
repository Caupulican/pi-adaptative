/**
 * Agent tool-call gate: model-router escalation, autonomy gating, extension tool hooks, and the
 * untrusted-content output boundary.
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). Provides the two agent-core
 * hooks (`beforeToolCall`/`afterToolCall`) as bound arrow-field members the session installs onto its
 * agent. `beforeToolCall` runs the router escalation, then the autonomy tool gate (recording the
 * outcome when a capability envelope is active), then extension `tool_call` handlers. `afterToolCall`
 * runs extension `tool_result` handlers and structurally fences output from untrusted-content sources.
 */

import type { Agent, BeforeToolCallResult } from "@caupulican/pi-agent-core";
import type { CapabilityEnvelope, GateOutcome } from "./autonomy/contracts.ts";
import { classifyAllEdgeOperations, type EdgeClass } from "./autonomy/edge-policy.ts";
import { evaluateToolGateAsync } from "./autonomy/gates.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import { type HostRepositoryEffect, repositoryEffectForCall } from "./objective-execution/repository-effect.ts";
import type {
	RepositoryMutationObserver,
	RepositoryObservationToken,
} from "./objective-execution/repository-mutation-observer.ts";
import { classifyToolTrust, wrapUntrustedText } from "./security/untrusted-boundary.ts";
import type { SystemOneForegroundControl } from "./system-one/foreground-control.ts";
import type { SystemOneController } from "./system-one/index.ts";
import type { ToolSelectionController } from "./tool-selection/tool-selection-controller.ts";
import { retireToolCall } from "./tools/file-mutation-queue.ts";

export const CONTROL_PLANE_TOOL_NAMES: ReadonlySet<string> = new Set([
	"task_steps",
	"goal",
	"create_goal",
	"get_goal",
	"update_goal",
	"task_directory",
	"skill",
	"skill_audit",
	"delegate",
	"tool_task",
	"ask_question",
]);

type BeforeToolCall = NonNullable<Agent["beforeToolCall"]>;
type AfterToolCall = NonNullable<Agent["afterToolCall"]>;

export interface ToolGateControllerDeps {
	/** Router escalation: block a tool the active cheap route is not allowed to run. */
	maybeEscalateToolCall(toolName: string, args: unknown): { block: true; reason: string } | undefined;
	getCwd(): string;
	/** Active foreground capability envelope, if any — presence enables gate-outcome recording. */
	getCapabilityEnvelope(): CapabilityEnvelope | undefined;
	/** Record an autonomy gate outcome (only when a capability envelope is active). */
	recordGateOutcome(outcome: GateOutcome): void;
	getExtensionRunner(): ExtensionRunner;
	/** Observe an execution only after all pre-execution gates and extension hooks allow it. */
	getToolSelectionController?(): ToolSelectionController | undefined;
	/**
	 * The edge: an operation class the operator has not granted asks once (or is blocked when no
	 * one can answer); a granted class and ordinary work return undefined.
	 */
	checkEdge?(
		toolName: string,
		args: unknown,
		executionCwd: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<BeforeToolCallResult | undefined>;
	/** The edge classes an admitted call carries (empty for ordinary work), for the delivery projection. */
	noteEdgeOperations?(toolCallId: string, classes: readonly EdgeClass[]): void;
	/**
	 * Session identity of the group lock this call's announcement belongs to
	 * (see file-mutation-queue.ts). Omitted retires in the process-wide default scope.
	 */
	getMutationScope?(): string;
	/** Direct script execution gate: intercepts shell/process execution of registered automation scripts. */
	checkDirectScriptExecution?(toolName: string, args: unknown, cwd?: string): BeforeToolCallResult | undefined;
	/**
	 * External-acquisition gate, at the real execution boundary: a command that fetches, installs or
	 * executes external code is screened before it runs.
	 */
	checkExternalAcquisition?(
		toolName: string,
		args: unknown,
		signal?: AbortSignal,
	): Promise<BeforeToolCallResult | undefined>;
	/** System One semantic control plane controller, if active for this session/run. */
	getSystemOneController?(): SystemOneController | undefined;
	/** System One's cancel and steer levers over the running turn; absent, its verdicts only block or allow. */
	getForegroundControl?(): SystemOneForegroundControl | undefined;
	/**
	 * Mutation-acceptance rule hook. A blocking violation converts the mutation's own result into an
	 * error carrying the violation, so the transition does not proceed on an accepted mutation.
	 */
	validateMutationAcceptance?(input: {
		toolName: string;
		changedFiles: readonly string[];
	}): Promise<{ blocked: boolean; explanation?: string; repairId?: string } | undefined>;
	/** Successful typed edit/write paths, hashed by the session ledger. */
	noteOwnedWrites?(paths: readonly string[], cwd: string): void;
	/** Bash or run_process changed the checkout, or that fingerprint could not be read. */
	noteShellMutation?(): void;
	/** Session mutation boundary. Absent sessions keep the ledger callbacks above. */
	repositoryObserver?: RepositoryMutationObserver;
	getObjectiveId?(): string;
	deliveryActive?(): boolean;
	hostRepositoryEffect?(toolName: string): HostRepositoryEffect | undefined;
}

/** File paths a mutation tool call names in its own arguments. */
export function collectMutatedPaths(toolName: string, args: unknown): string[] {
	if (!toolName.includes("edit") && !toolName.includes("write")) return [];
	const record = args as Record<string, unknown> | undefined;
	const paths: string[] = [];
	for (const key of ["path", "file_path", "filePath", "file"]) {
		const value = record?.[key];
		if (typeof value === "string" && value.trim()) paths.push(value);
	}
	const edits = record?.edits;
	if (Array.isArray(edits)) {
		for (const edit of edits) {
			const editPath = (edit as Record<string, unknown> | undefined)?.path;
			if (typeof editPath === "string" && editPath.trim()) paths.push(editPath);
		}
	}
	return [...new Set(paths)];
}

export class ToolGateController {
	private readonly deps: ToolGateControllerDeps;
	private readonly pendingObservations = new Map<string, RepositoryObservationToken>();

	constructor(deps: ToolGateControllerDeps) {
		this.deps = deps;
	}

	private async beginObservation(
		toolCallId: string,
		toolName: string,
		args: unknown,
	): Promise<RepositoryObservationToken | undefined> {
		const observer = this.deps.repositoryObserver;
		if (!observer) return undefined;
		const effect = repositoryEffectForCall({
			toolName,
			args,
			deliveryActive: this.deps.deliveryActive?.() ?? false,
			hostEffect: this.deps.hostRepositoryEffect?.(toolName),
		});
		if (effect === "none") return undefined;
		return observer.begin({
			callId: toolCallId,
			objectiveId: this.deps.getObjectiveId?.() ?? "",
			cwd: this.deps.getCwd(),
			effect,
		});
	}

	private async finishObservation(
		toolCallId: string,
		toolName: string,
		args: unknown,
		operationSucceeded: boolean,
	): Promise<void> {
		const token = this.pendingObservations.get(toolCallId);
		if (!token) return;
		this.pendingObservations.delete(toolCallId);
		const declared = token.effect === "typed_owned_write" ? collectMutatedPaths(toolName, args) : [];
		await this.deps.repositoryObserver?.finish({
			token,
			declaredOwnedPaths: declared,
			operationSucceeded,
		});
	}

	readonly beforeToolCall: BeforeToolCall = async (
		{ toolCall, args, executionContext, pathAuthority, requestId, assistantMessage, registerCleanup },
		signal,
	) => {
		signal?.throwIfAborted();
		// Session model selection may change during a provider response or any awaited hook.
		const modelRef = `${assistantMessage.provider}/${assistantMessage.model}`;
		const escalation = this.deps.maybeEscalateToolCall(toolCall.name, args);
		if (escalation) {
			return escalation;
		}

		// The capability envelope is evaluated twice per call - once on the raw arguments before any
		// extension hook can see them, once on the arguments the hooks actually hand to the tool (a
		// hook may rewrite a path in place) - but it is PUBLISHED once: the pre-hook denial when it
		// rejects, otherwise the final post-hook outcome. The `finally` below is the single owner of
		// that publication, so an early hook block, hook failure or later cancellation still leaves
		// exactly one record - the last envelope decision that actually completed. A call cancelled
		// before any evaluation completes leaves none (there is no decision to record).
		const envelope = structuredClone(this.deps.getCapabilityEnvelope());
		const scopeCwd = this.deps.getCwd();
		const evaluateEnvelope = async (currentArgs: unknown): Promise<GateOutcome> => {
			signal?.throwIfAborted();
			return evaluateToolGateAsync({
				toolName: toolCall.name,
				args: currentArgs,
				cwd: executionContext?.cwd ?? scopeCwd,
				scopeCwd,
				envelope,
				pathAuthority,
				signal,
			});
		};
		const blockedBy = (gateResult: GateOutcome): BeforeToolCallResult | undefined =>
			gateResult.outcome === "block"
				? {
						block: true,
						reason: `Tool execution blocked by autonomy gate [${gateResult.gate}]: ${gateResult.message} (${gateResult.reasonCode})`,
					}
				: undefined;

		// 1. Pre-hook capability envelope & path bounds check on raw args
		let terminalOutcome = await evaluateEnvelope(args);
		let observationToken: RepositoryObservationToken | undefined;
		let observationHandedOff = false;
		try {
			const denied = blockedBy(terminalOutcome);
			if (denied) return denied;

			// External acquisition is screened before any extension hook can rewrite the command, so the
			// bytes the gate judged are the bytes that would have run.
			if (this.deps.checkExternalAcquisition) {
				const acquisitionBlock = await this.deps.checkExternalAcquisition(toolCall.name, args, signal);
				if (acquisitionBlock) return acquisitionBlock;
			}

			observationToken = await this.beginObservation(toolCall.id, toolCall.name, args);
			// 2. Extension tool_call hooks
			const runner = this.deps.getExtensionRunner();
			let extensionResult: BeforeToolCallResult | undefined;
			if (runner.hasHandlers("tool_call")) {
				try {
					extensionResult = await runner.emitToolCall(
						{
							type: "tool_call",
							toolName: toolCall.name,
							toolCallId: toolCall.id,
							input: args as Record<string, unknown>,
						},
						executionContext,
					);
				} catch (err) {
					if (err instanceof Error) {
						throw err;
					}
					throw new Error(`Extension failed, blocking execution: ${String(err)}`);
				}
				if (extensionResult?.block) return extensionResult;
			}

			// 3. Post-hook arguments: direct-script gate, then the envelope on what will really run
			// Hooks rewrite event.input in place. The executor retains this same args object;
			// extension return values carry control decisions, never replacement arguments.
			const effectiveCwd = executionContext?.cwd ?? scopeCwd;
			if (this.deps.checkDirectScriptExecution) {
				const directCheck = this.deps.checkDirectScriptExecution(toolCall.name, args, effectiveCwd);
				if (directCheck) {
					return directCheck;
				}
			}
			terminalOutcome = await evaluateEnvelope(args);
			const deniedAfterHook = blockedBy(terminalOutcome);
			if (deniedAfterHook) return deniedAfterHook;

			// 4. Single edge authorization on the actual final operation
			const edge = await this.deps.checkEdge?.(toolCall.name, args, executionContext?.cwd, signal);
			if (edge) return edge;

			// 5. System One semantic tool gate
			const isControlPlaneTool = CONTROL_PLANE_TOOL_NAMES.has(toolCall.name);
			const edgeOperations = classifyAllEdgeOperations({
				toolName: toolCall.name,
				args,
				cwd: executionContext?.cwd ?? scopeCwd,
				scopeCwd,
			});
			const isOperatorAuthorizedEdge = edgeOperations.length > 0;
			this.deps.noteEdgeOperations?.(
				toolCall.id,
				edgeOperations.map((operation) => operation.class),
			);

			// Operator edge authorization outranks advisory semantic tool gates;
			// control-plane tools are internal harness operations, not untrusted repo inputs.
			const systemOne = this.deps.getSystemOneController?.();
			if (systemOne && !isControlPlaneTool && !isOperatorAuthorizedEdge) {
				const impact =
					toolCall.name === "bash"
						? "local_reversible"
						: toolCall.name.includes("edit") || toolCall.name.includes("write")
							? "repo_mutation"
							: "read_only";

				if (systemOne.hookCoordinator?.hasExtensions()) {
					const beforeToolResult = await systemOne.hookCoordinator.runHook("before_tool", {
						schema_version: "1.0",
						run_id: systemOne.store.runId,
						session_id: systemOne.store.runId,
						hook: "before_tool",
						impact,
						tool: toolCall.name,
						metadata: { args },
					});
					if (beforeToolResult?.decision === "deny") {
						return {
							block: true,
							reason:
								beforeToolResult.reasonCodes.join(", ") ||
								"Tool execution blocked by integrity before_tool hook",
						};
					}
					if (impact === "repo_mutation") {
						const beforeMutationResult = await systemOne.hookCoordinator.runHook("before_mutation", {
							schema_version: "1.0",
							run_id: systemOne.store.runId,
							session_id: systemOne.store.runId,
							hook: "before_mutation",
							impact,
							tool: toolCall.name,
							metadata: { args },
						});
						if (beforeMutationResult?.decision === "deny") {
							return {
								block: true,
								reason:
									beforeMutationResult.reasonCodes.join(", ") ||
									"Tool execution blocked by integrity before_mutation hook",
							};
						}
					}
				}

				let systemOneResult: Awaited<ReturnType<typeof systemOne.validateToolGate>> | undefined;
				try {
					systemOneResult = await systemOne.validateToolGate({
						tool: toolCall.name,
						intent: `Invoke tool ${toolCall.name}`,
						impact,
						args,
						call_id: toolCall.id,
					});
				} catch {
					// A missing classification does not refuse the call.
					systemOneResult = undefined;
				}
				const foreground = this.deps.getForegroundControl?.();
				// Jev classifies. Allow and replan stay on the ledger. Only a broad-scope
				// confirm is ranked high enough to reach the model, as one queued line.
				if (systemOneResult?.outcome === "confirm" && foreground) {
					await foreground.steer(
						`System One: the ${toolCall.name} call's scope looks broad relative to the current step; keep to what the step needs and say why if more is required.`,
						"queue",
					);
				}
			}

			let releaseObservation: (() => void) | undefined;
			try {
				const selection = this.deps.getToolSelectionController?.();
				if (selection) {
					const callId = toolCall.id;
					const observation = selection.begin(callId, toolCall.name, args, { modelRef, requestId });
					releaseObservation = () => selection.discard(callId, observation);
				}
			} catch {
				// Advisory ranking/storage reads cannot deny an otherwise authorized operation.
			}
			if (releaseObservation) registerCleanup?.(releaseObservation);
			if (observationToken) {
				observationHandedOff = true;
				this.pendingObservations.set(toolCall.id, observationToken);
			}
			return extensionResult;
		} finally {
			if (observationToken && !observationHandedOff) {
				await this.deps.repositoryObserver?.finish({
					token: observationToken,
					operationSucceeded: false,
				});
			}
			// A later abort does not invalidate a decision the envelope already made; the pre-hook
			// evaluation above either completed (and is published) or threw before this block exists.
			if (envelope) this.deps.recordGateOutcome(terminalOutcome);
		}
	};

	readonly afterToolCall: AfterToolCall = async ({ toolCall, args, result, isError, executionContext }) => {
		// Execution terminal for the emission-order announcement the reservation made: this call can no
		// longer start a file mutation, so a sibling exclusive run emitted after it must stop waiting.
		// Retired first and synchronously, before any hook here can throw -- a write rejected by its own
		// preflight would otherwise park a later bash in the same batch for the rest of the turn.
		retireToolCall(toolCall.id, this.deps.getMutationScope?.());
		const selection = this.deps.getToolSelectionController?.();
		let finishSucceeded = !isError;
		try {
			const runner = this.deps.getExtensionRunner();
			let content = result.content;
			let details = result.details;
			let usage = result.usage;
			let terminate = result.terminate;
			let resolvedIsError = isError;

			if (runner.hasHandlers("tool_result")) {
				const hookResult = await runner.emitToolResult(
					{
						type: "tool_result",
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						input: args as Record<string, unknown>,
						content,
						details,
						isError,
						usage,
					},
					executionContext,
				);
				if (hookResult) {
					content = hookResult.content ?? content;
					details = hookResult.details;
					resolvedIsError = hookResult.isError ?? isError;
					usage = hookResult.usage ?? usage;
					if (hookResult.terminate !== undefined) terminate = hookResult.terminate;
				}
			}

			// Untrusted-content boundary: structurally fence output from attacker-controllable sources
			// (web/search, subagents, recall, third-party tools) so injection payloads are framed as data.
			// First-party tools (read/grep/find/ls/edit/write/bash) are trusted and pass through unchanged.
			if (classifyToolTrust(toolCall.name) === "untrusted") {
				const source = `tool:${toolCall.name}`;
				const wrapped = content.map((block) =>
					block.type === "text" ? { ...block, text: wrapUntrustedText(block.text, source) } : block,
				);
				content = wrapped;
			}

			selection?.complete(toolCall.id, !resolvedIsError, content);

			const systemOne = this.deps.getSystemOneController?.();
			systemOne?.recordToolTerminal({
				call_id: toolCall.id,
				succeeded: !resolvedIsError,
				output: content,
			});
			if (systemOne?.hookCoordinator?.hasExtensions()) {
				const isMutation = toolCall.name.includes("edit") || toolCall.name.includes("write");
				if (isMutation) {
					await systemOne.hookCoordinator.runHook("after_mutation", {
						schema_version: "1.0",
						run_id: systemOne.store.runId,
						session_id: systemOne.store.runId,
						hook: "after_mutation",
						impact: "repo_mutation",
						tool: toolCall.name,
					});
				}
				await systemOne.hookCoordinator.runHook("after_tool", {
					schema_version: "1.0",
					run_id: systemOne.store.runId,
					session_id: systemOne.store.runId,
					hook: "after_tool",
					impact: isMutation ? "repo_mutation" : toolCall.name === "bash" ? "local_reversible" : "read_only",
					tool: toolCall.name,
				});
			}
			// Mutation acceptance: project rules are evaluated on the files this call actually changed,
			// before the successful result is accepted into the transcript. A blocking violation makes
			// this result an error; the RepairWork it queued is durable on the session.
			if (!resolvedIsError) {
				const changedFiles = collectMutatedPaths(toolCall.name, args);
				if (changedFiles.length > 0 && this.deps.validateMutationAcceptance) {
					const verdict = await this.deps.validateMutationAcceptance({
						toolName: toolCall.name,
						changedFiles,
					});
					if (verdict?.blocked) {
						const repair = verdict.repairId ? ` RepairWork ${verdict.repairId} is queued.` : "";
						return {
							content: [
								{
									type: "text",
									text: `Mutation rejected by project rules: ${verdict.explanation ?? "rule violation"}.${repair}`,
								},
							],
							details,
							isError: true,
							usage,
							terminate,
						};
					}
				}
				if (changedFiles.length > 0) {
					this.deps.noteOwnedWrites?.(changedFiles, executionContext?.cwd ?? this.deps.getCwd());
				}
			}
			finishSucceeded = !resolvedIsError;

			if (
				content === result.content &&
				details === result.details &&
				resolvedIsError === isError &&
				usage === result.usage &&
				terminate === result.terminate
			) {
				return undefined;
			}
			return { content, details, isError: resolvedIsError, usage, terminate };
		} finally {
			// Result hooks can fail before complete(). A terminal call must retain no pending
			// observation; a projection failure is not evidence that the tool itself failed.
			selection?.discard(toolCall.id);
			await this.finishObservation(toolCall.id, toolCall.name, args, finishSucceeded);
		}
	};
}
