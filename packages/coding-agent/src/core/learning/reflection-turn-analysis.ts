import { createHash } from "node:crypto";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { DemandSignals } from "./reflection-engine.ts";

const REFLECTION_TURN_MAX_CHARS = 12_000;
const REFLECTION_ROLE_MAX_CHARS = 6_000;
const CORRECTION_SIGNAL =
	/\b(next time|for future|from now on|remember this|don't|do not|avoid|instead|you should|should have|you forgot|you missed|not what i asked|wrong again)\b/i;
const EXPLICIT_DURABLE_SIGNAL =
	/\b(remember|store (?:this|that)|keep (?:this|that) in memory|my preference|i prefer|standing rule|always use|never use)\b/i;
const DURABLE_WORK_SIGNAL =
	/\b(confirmed root cause|root cause (?:is|was)|fixed|implemented|regression|invariant|durable decision|repeatable workaround)\b/i;

export function boundReflectionSemanticText(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	const marker = "\n...[semantic digest truncated]...\n";
	const retainedChars = maxChars - marker.length;
	const headChars = Math.ceil(retainedChars / 2);
	return `${trimmed.slice(0, headChars).trimEnd()}${marker}${trimmed.slice(-(retainedChars - headChars)).trimStart()}`;
}

function redactReflectionSecrets(text: string): string {
	return text
		.replace(
			/-----BEGIN [A-Z ]*(?:PRIVATE|OPENSSH|RSA|DSA|EC) KEY-----[\s\S]*?-----END [A-Z ]*(?:PRIVATE|OPENSSH|RSA|DSA|EC) KEY-----/g,
			"[redacted-private-key]",
		)
		.replace(/\b(?:sk|pk)-(?:proj-)?[A-Za-z0-9_-]{12,}/g, "[redacted-api-key]")
		.replace(/\bsk-ant-[A-Za-z0-9_-]{12,}/g, "[redacted-api-key]")
		.replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, "[redacted-github-token]")
		.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted-aws-access-key]")
		.replace(/(?:Bearer\s+)[A-Za-z0-9._-]{16,}/gi, "Bearer [redacted]")
		.replace(/([?&](?:key|token|api_key|access_token|secret|password)=)[^&\s]+/gi, "$1[redacted]")
		.replace(
			/((?:access|refresh|token|apiKey|api_key|password|secret|authorization|auth)\s*[:=]\s*)[^\s,'"}]{8,}/gi,
			"$1[redacted]",
		);
}

function messageText(message: AgentMessage): string {
	const content = (message as unknown as { content?: unknown }).content;
	if (typeof content === "string") return redactReflectionSecrets(content);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string") {
			parts.push(redactReflectionSecrets(candidate.text));
		}
	}
	return parts.join("\n");
}

export interface ReflectionTurnAnalysis {
	trigger: DemandSignals["trigger"];
	toolCallCount: number;
	hadCorrection: boolean;
	explicitUserMemoryInstruction: boolean;
	recentTurnText: string;
	userText: string;
	assistantText: string;
	digest: string;
}

/**
 * Produce the only transcript projection used by automatic learning and provider turn-sync hooks.
 * It retains bounded user/assistant semantics plus tool names/counts, never raw tool-result payloads.
 */
export function analyzeReflectionTurn(messages: AgentMessage[], complexTaskThreshold: number): ReflectionTurnAnalysis {
	const semanticLines: string[] = [];
	const userParts: string[] = [];
	const assistantParts: string[] = [];
	const toolNames = new Set<string>();
	let toolCalls = 0;
	let toolResults = 0;

	for (const message of messages) {
		const raw = message as unknown as Record<string, unknown>;
		const role = String(raw.role ?? "");
		if (role === "user" || role === "assistant") {
			const text = messageText(message).trim();
			if (text) {
				semanticLines.push(`${role}: ${boundReflectionSemanticText(text, 4_000)}`);
				if (role === "user") userParts.push(text);
				else assistantParts.push(text);
			}
		}
		const content = raw.content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const candidate = block as Record<string, unknown>;
				if (candidate.type === "toolCall") {
					toolCalls += 1;
					if (typeof candidate.name === "string") toolNames.add(candidate.name);
				}
			}
		}
		if (role === "toolResult" || role === "bashExecution") {
			toolResults += 1;
			if (typeof raw.toolName === "string") toolNames.add(raw.toolName);
			else if (role === "bashExecution") toolNames.add("bash");
		}
	}

	const toolCallCount = Math.max(toolCalls, toolResults);
	if (toolCallCount > 0) {
		semanticLines.push(`[tools: ${[...toolNames].sort().join(", ") || "unnamed"}; calls=${toolCallCount}]`);
	}
	const userText = boundReflectionSemanticText(userParts.join("\n"), REFLECTION_ROLE_MAX_CHARS);
	const assistantText = boundReflectionSemanticText(assistantParts.join("\n"), REFLECTION_ROLE_MAX_CHARS);
	const hadCorrection = CORRECTION_SIGNAL.test(userText);
	const hasExplicitDurableSignal = userParts.some((part) => EXPLICIT_DURABLE_SIGNAL.test(part));
	const explicitUserMemoryInstruction =
		userParts.length > 0 && userParts.every((part) => EXPLICIT_DURABLE_SIGNAL.test(part));
	const hasDurableSignal = hasExplicitDurableSignal || (toolCallCount > 0 && DURABLE_WORK_SIGNAL.test(assistantText));
	const trigger: DemandSignals["trigger"] = hadCorrection
		? "corrective"
		: hasDurableSignal
			? "durable"
			: toolCallCount >= Math.max(1, complexTaskThreshold)
				? "complex"
				: "none";
	const recentTurnText = boundReflectionSemanticText(semanticLines.join("\n"), REFLECTION_TURN_MAX_CHARS);
	const digest = createHash("sha256")
		.update(`${recentTurnText}\0${toolCallCount}\0${trigger}`)
		.digest("hex")
		.slice(0, 24);
	return {
		trigger,
		toolCallCount,
		hadCorrection,
		explicitUserMemoryInstruction,
		recentTurnText,
		userText,
		assistantText,
		digest,
	};
}

export function reflectionTriggerPriority(trigger: DemandSignals["trigger"]): number {
	switch (trigger) {
		case "corrective":
			return 4;
		case "durable":
			return 3;
		case "complex":
			return 2;
		case "session-end":
			return 1;
		default:
			return 0;
	}
}
