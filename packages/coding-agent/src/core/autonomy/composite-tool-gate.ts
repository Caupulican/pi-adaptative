import type { AgentTool } from "@caupulican/pi-agent-core";
import type { TSchema } from "typebox";
import type { CapabilityEnvelope } from "./contracts.ts";
import { evaluateToolGate } from "./gates.ts";

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
): AgentTool<TParameters, TDetails> {
	if (!envelope) return tool;
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate) {
			const outcome = evaluateToolGate({ toolName: tool.name, args: params, cwd, envelope });
			if (outcome.outcome === "block" || outcome.outcome === "ask-user") {
				throw new Error(
					`Tool '${tool.name}' execution blocked by autonomy gate [${outcome.gate}]: ${outcome.message ?? "denied"} (${outcome.reasonCode})`,
				);
			}
			return tool.execute(toolCallId, params, signal, onUpdate);
		},
	};
}
