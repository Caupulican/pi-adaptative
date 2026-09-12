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
import { evaluateToolGateAsync } from "./autonomy/gates.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import { classifyToolTrust, wrapUntrustedText } from "./security/untrusted-boundary.ts";
import type { ToolSelectionController } from "./tool-selection/tool-selection-controller.ts";
import { retireToolCall } from "./tools/file-mutation-queue.ts";

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
	/**
	 * Session identity of the group lock this call's announcement belongs to
	 * (see file-mutation-queue.ts). Omitted retires in the process-wide default scope.
	 */
	getMutationScope?(): string;
	/** Direct script execution gate: intercepts shell/process execution of registered automation scripts. */
	checkDirectScriptExecution?(toolName: string, args: unknown, cwd?: string): BeforeToolCallResult | undefined;
}

export class ToolGateController {
	private readonly deps: ToolGateControllerDeps;

	constructor(deps: ToolGateControllerDeps) {
		this.deps = deps;
	}

	readonly beforeToolCall: BeforeToolCall = async ({ toolCall, args, executionContext, pathAuthority }, signal) => {
		signal?.throwIfAborted();
		const escalation = this.deps.maybeEscalateToolCall(toolCall.name, args);
		if (escalation) {
			return escalation;
		}

		// 1. Pre-hook capability envelope & path bounds check on raw args
		const envelope = structuredClone(this.deps.getCapabilityEnvelope());
		const scopeCwd = this.deps.getCwd();
		const evaluateEnvelope = async (currentArgs: unknown): Promise<BeforeToolCallResult | undefined> => {
			signal?.throwIfAborted();
			const gateResult = await evaluateToolGateAsync({
				toolName: toolCall.name,
				args: currentArgs,
				cwd: executionContext?.cwd ?? scopeCwd,
				scopeCwd,
				envelope,
				pathAuthority,
				signal,
			});
			if (envelope) this.deps.recordGateOutcome(gateResult);
			if (gateResult.outcome === "block") {
				return {
					block: true,
					reason: `Tool execution blocked by autonomy gate [${gateResult.gate}]: ${gateResult.message} (${gateResult.reasonCode})`,
				};
			}
			return undefined;
		};

		const denied = await evaluateEnvelope(args);
		if (denied) return denied;

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

		// 3. Post-hook arguments & envelope re-check
		const finalArgs = (extensionResult as { args?: unknown })?.args ?? args;
		const effectiveCwd = executionContext?.cwd ?? scopeCwd;
		if (this.deps.checkDirectScriptExecution) {
			const directCheck = this.deps.checkDirectScriptExecution(toolCall.name, finalArgs, effectiveCwd);
			if (directCheck) {
				return directCheck;
			}
		}
		const deniedAfterHook = await evaluateEnvelope(finalArgs);
		if (deniedAfterHook) return deniedAfterHook;

		// 4. Single edge authorization on the actual final operation
		const edge = await this.deps.checkEdge?.(toolCall.name, finalArgs, executionContext?.cwd, signal);
		if (edge) return edge;

		if (extensionResult) return extensionResult;

		this.deps.getToolSelectionController?.()?.begin(toolCall.id, toolCall.name, finalArgs);
		return undefined;
	};

	readonly afterToolCall: AfterToolCall = async ({ toolCall, args, result, isError, executionContext }) => {
		// Execution terminal for the emission-order announcement the reservation made: this call can no
		// longer start a file mutation, so a sibling exclusive run emitted after it must stop waiting.
		// Retired first and synchronously, before any hook here can throw -- a write rejected by its own
		// preflight would otherwise park a later bash in the same batch for the rest of the turn.
		retireToolCall(toolCall.id, this.deps.getMutationScope?.());
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

		this.deps.getToolSelectionController?.()?.complete(toolCall.id, !resolvedIsError, content);
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
	};
}
