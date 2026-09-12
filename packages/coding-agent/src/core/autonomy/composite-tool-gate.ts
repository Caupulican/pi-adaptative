import type { AgentTool, BeforeToolCallResult } from "@caupulican/pi-agent-core";
import type { TSchema } from "typebox";
import { wrapToolExecution } from "../tools/tool-execution-wrapper.ts";
import type { CapabilityEnvelope } from "./contracts.ts";
import { evaluateToolGateAsync } from "./gates.ts";

function copyEnvelope(
	envelope: CapabilityEnvelope,
	allowedTools: readonly string[] | undefined = envelope.allowedTools,
): CapabilityEnvelope {
	return {
		...envelope,
		capabilities: [...envelope.capabilities],
		...(allowedTools ? { allowedTools: [...allowedTools] } : {}),
		...(envelope.deniedTools ? { deniedTools: [...envelope.deniedTools] } : {}),
		...(envelope.allowedPaths ? { allowedPaths: [...envelope.allowedPaths] } : {}),
		...(envelope.deniedPaths ? { deniedPaths: [...envelope.deniedPaths] } : {}),
	};
}

/**
 * Derive one immutable child-tool view from an already-authorized composite tool call.
 * Explicit child denials and every capability/path bound remain intact. An allowlist is widened
 * only when it actually grants the parent; direct or accidental use cannot turn a denied parent
 * into authority for its implementation tools.
 */
export function deriveCompositeChildEnvelope(
	parentToolName: string,
	childToolNames: readonly string[],
	envelope: CapabilityEnvelope | undefined,
): CapabilityEnvelope | undefined {
	if (!envelope) return undefined;
	if (
		envelope.deniedTools?.includes(parentToolName) ||
		(envelope.allowedTools !== undefined && !envelope.allowedTools.includes(parentToolName))
	) {
		return copyEnvelope(envelope, []);
	}
	if (!envelope.allowedTools) return copyEnvelope(envelope);
	return copyEnvelope(envelope, [...new Set([...envelope.allowedTools, ...childToolNames])]);
}

/** Apply the complete autonomy gate to a composite tool's concrete child tool at execution time. */
export function wrapToolWithCapabilityEnvelopeGate<TParameters extends TSchema, TDetails>(
	tool: AgentTool<TParameters, TDetails>,
	cwd: string,
	envelope: CapabilityEnvelope | undefined,
	scopeCwd = cwd,
	checkEdge?: (
		toolName: string,
		args: unknown,
		cwd: string | undefined,
		signal: AbortSignal | undefined,
	) => Promise<BeforeToolCallResult | undefined>,
): AgentTool<TParameters, TDetails> {
	if (!envelope && !checkEdge) return tool;
	return wrapToolExecution(tool, (executor, executionContext, pathAuthority) => ({
		...executor,
		async execute(toolCallId, params, signal, onUpdate) {
			if (envelope) {
				const outcome = await evaluateToolGateAsync({
					toolName: tool.name,
					args: params,
					cwd: executionContext?.cwd ?? cwd,
					scopeCwd,
					envelope,
					pathAuthority,
					signal,
				});
				signal?.throwIfAborted();
				if (outcome.outcome === "block" || outcome.outcome === "ask-user") {
					throw new Error(
						`Tool '${tool.name}' execution blocked by autonomy gate [${outcome.gate}]: ${outcome.message ?? "denied"} (${outcome.reasonCode})`,
					);
				}
			}
			if (checkEdge) {
				const edge = await checkEdge(tool.name, params, executionContext?.cwd ?? cwd, signal);
				signal?.throwIfAborted();
				if (edge?.block) {
					throw new Error(`Tool '${tool.name}' execution blocked by edge: ${edge.reason ?? "denied"}`);
				}
			}
			return executor.execute(toolCallId, params, signal, onUpdate);
		},
	}));
}
