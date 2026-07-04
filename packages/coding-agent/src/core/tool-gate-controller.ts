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

import type { Agent } from "@caupulican/pi-agent-core";
import type { CapabilityEnvelope, GateOutcome } from "./autonomy/contracts.ts";
import { evaluateToolGate } from "./autonomy/gates.ts";
import type { ExtensionRunner } from "./extensions/index.ts";
import { classifyToolTrust, wrapUntrustedText } from "./security/untrusted-boundary.ts";

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
}

export class ToolGateController {
	private readonly deps: ToolGateControllerDeps;

	constructor(deps: ToolGateControllerDeps) {
		this.deps = deps;
	}

	readonly beforeToolCall: BeforeToolCall = async ({ toolCall, args }) => {
		const escalation = this.deps.maybeEscalateToolCall(toolCall.name, args);
		if (escalation) {
			return escalation;
		}

		// Autonomy tool gating
		const envelope = this.deps.getCapabilityEnvelope();
		const gateResult = evaluateToolGate({
			toolName: toolCall.name,
			args,
			cwd: this.deps.getCwd(),
			envelope,
		});

		if (envelope) {
			this.deps.recordGateOutcome(gateResult);
		}

		if (gateResult.outcome === "block" || gateResult.outcome === "ask-user") {
			return {
				block: true,
				reason: `Tool execution blocked by autonomy gate [${gateResult.gate}]: ${gateResult.message} (${gateResult.reasonCode})`,
			};
		}

		const runner = this.deps.getExtensionRunner();
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		try {
			return await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
			});
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	};

	readonly afterToolCall: AfterToolCall = async ({ toolCall, args, result, isError }) => {
		const runner = this.deps.getExtensionRunner();
		let content = result.content;
		let details = result.details;
		let resolvedIsError = isError;

		if (runner.hasHandlers("tool_result")) {
			const hookResult = await runner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content,
				details,
				isError,
			});
			if (hookResult) {
				content = hookResult.content ?? content;
				details = hookResult.details;
				resolvedIsError = hookResult.isError ?? isError;
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

		if (content === result.content && details === result.details && resolvedIsError === isError) {
			return undefined;
		}
		return { content, details, isError: resolvedIsError };
	};
}
