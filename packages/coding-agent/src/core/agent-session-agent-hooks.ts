/**
 * Hooks the session installs on its agent once, at construction: the provider request options (the text tool-call
 * protocol and its temperature), the request reasoning resolver (lane custody, host turn reasoning and the cost
 * ceiling), and the tool-argument validation observer. Each keeps the order it had in the coordinator's constructor.
 */

import type { Agent } from "../kernel/agent.ts";
import { cacheLaneKey } from "./context/cache-observation-recorder.ts";
import type { CostGuardController } from "./cost-guard-controller.ts";
import type { HostTurnReasoningController } from "./host-turn-reasoning.ts";
import type { SessionAnalytics } from "./session-analytics.ts";
import type { SessionCacheController } from "./session-cache-controller.ts";
import type { ToolProtocolController } from "./tool-protocol-controller.ts";
import type { ToolRecoveryLogger } from "./tool-recovery-logger.ts";
import type { ToolSelectionController } from "./tool-selection/tool-selection-controller.ts";

export interface AgentSessionAgentHookPorts {
	cache(): SessionCacheController;
	costGuard(): CostGuardController;
	hostTurnReasoning(): HostTurnReasoningController;
	sessionId(): string;
	toolProtocol(): ToolProtocolController;
	toolSelection(): ToolSelectionController;
	toolRecoveryLogger(): ToolRecoveryLogger;
	analytics(): SessionAnalytics;
}

export function installSessionRequestHooks(agent: Agent, ports: AgentSessionAgentHookPorts): void {
	const previousPrepareProviderRequest = agent.prepareProviderRequest?.bind(agent);
	agent.prepareProviderRequest = async (model, signal) => {
		const options = await previousPrepareProviderRequest?.(model, signal);
		const textToolCallProtocol =
			options?.textToolCallProtocol ?? ports.toolProtocol().resolveModelToolProtocol(model).protocol;
		return { ...options, textToolCallProtocol, temperature: textToolCallProtocol ? 0 : options?.temperature };
	};
	const previousResolveRequestReasoning = agent.resolveRequestReasoning?.bind(agent);
	agent.resolveRequestReasoning = (reasoning, request) => {
		const resolvedReasoning = previousResolveRequestReasoning
			? previousResolveRequestReasoning(reasoning, request)
			: reasoning;
		// The lane keeps the reasoning it last sent unless the owner changed it or the change is free; the owner's
		// cost ceiling applies after the gate. An isolated lane (a worker) reuses this resolver on its own conversation.
		const conversation =
			request.sessionId !== undefined && request.sessionId !== ports.sessionId() ? request.sessionId : undefined;
		const lane = cacheLaneKey(request.model.api, request.model.provider, request.model.id);
		const held = ports
			.cache()
			.custody.admitReasoning(
				conversation,
				lane,
				resolvedReasoning,
				ports.hostTurnReasoning().resolveRequestReasoning(request.model, request.sourceMessages, resolvedReasoning),
				() => ports.cache().laneCacheGone(request.model, conversation),
			) as typeof resolvedReasoning;
		ports.hostTurnReasoning().noteSent(held);
		const final = ports.costGuard().resolveRequestReasoning(request.model, request.context, held, request.maxTokens);
		if (final !== held)
			ports.cache().custody.overrideReasoning(conversation, lane, final, "the cost ceiling downgraded the level");
		return final;
	};
}

export function installSessionToolArgumentHook(agent: Agent, ports: AgentSessionAgentHookPorts): void {
	const previousToolArgumentValidation = agent.onToolArgumentValidation;
	agent.onToolArgumentValidation = (event) => {
		const taggedEvent = ports.toolProtocol().tagAdaptationRuleTeaching(event);
		if (taggedEvent.outcome === "repaired" || taggedEvent.outcome === "bounced") {
			ports
				.toolSelection()
				.recordValidation(
					taggedEvent.tool,
					taggedEvent.outcome,
					taggedEvent.provider && taggedEvent.model ? `${taggedEvent.provider}/${taggedEvent.model}` : "unknown",
				);
		}
		previousToolArgumentValidation?.(taggedEvent);
		// Protocol health and adaptation are deterministic runtime behavior, not optional recovery
		// logging. Keep them outside the analytics logger's enabled/disabled result.
		ports.toolProtocol().handleValidationOutcome(taggedEvent);
		ports.toolProtocol().handleAdaptationTelemetry(taggedEvent);
		const logRecord = ports.toolRecoveryLogger().recordToolArgumentValidation(taggedEvent);
		if (!logRecord) return;
		ports.analytics().recordToolArgumentValidation(logRecord);
	};
}
