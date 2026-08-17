import path from "node:path";
import {
	resolveToolCallCapabilities,
	resolveToolCallPathAccess,
	toolUsesPathScope,
} from "../tool-capability-policy.ts";
import { describeCapabilityRequirementForTool, hasCapabilityPolicyForTool } from "./approval-gate.ts";
import type { CapabilityEnvelope, GateOutcome, GateOutcomeKind } from "./contracts.ts";
import { extractToolPathArguments, isPathWithinEnvelope } from "./envelope-enforcement.ts";
import { isPathWithinScope, safeRealpathSync } from "./path-scope.ts";
import { assessOperationRisk } from "./risk-assessment.ts";

function isGateOutcomeKind(value: unknown): value is GateOutcomeKind {
	return (
		value === "allow" || value === "downgrade" || value === "escalate" || value === "ask-user" || value === "block"
	);
}

function getPrecedence(kind: unknown): number {
	if (kind === "allow") return 0;
	if (kind === "downgrade") return 1;
	if (kind === "escalate") return 2;
	if (kind === "ask-user") return 3;
	if (kind === "block") return 4;
	return 4; // Malformed/unknown outcome kind defaults to most restrictive (block)
}

export function combineGateOutcomes(outcomes: readonly GateOutcome[]): GateOutcome {
	if (outcomes.length === 0) {
		return {
			outcome: "ask-user",
			gate: "gate-combiner",
			reasonCode: "no_gate_outcomes",
			message: "No gate outcomes to combine",
		};
	}

	let winner = outcomes[0];
	let maxPrecedence = getPrecedence(winner.outcome);

	for (let i = 1; i < outcomes.length; i++) {
		const current = outcomes[i];
		const currentPrecedence = getPrecedence(current.outcome);
		if (currentPrecedence > maxPrecedence) {
			winner = current;
			maxPrecedence = currentPrecedence;
		}
	}

	if (!isGateOutcomeKind(winner.outcome)) {
		return {
			...winner,
			outcome: "block",
			message: winner.message || "Malformed outcome kind coerced to block",
		};
	}

	return winner;
}

export function fallbackGateOutcome(args: { gate: string; reversible: boolean; reasonCode: string }): GateOutcome {
	const gate = (args.gate || "").trim() || "unknown_gate";
	const reasonCode = (args.reasonCode || "").trim() || "unknown_reason";
	const outcome: GateOutcomeKind = args.reversible ? "ask-user" : "block";

	return {
		outcome,
		gate,
		reasonCode,
		message: `Fallback gate outcome: ${outcome} for gate ${gate} (${reasonCode})`,
	};
}

export function extractCandidatePaths(toolName: string, args: unknown): string[] {
	return toolUsesPathScope(toolName) ? extractToolPathArguments(toolName, args) : [];
}

export function evaluateToolGate(input: {
	toolName: string;
	args?: unknown;
	cwd: string;
	envelope?: CapabilityEnvelope;
}): GateOutcome {
	if (!input.envelope) {
		return {
			outcome: "allow",
			gate: "tool_gate",
			reasonCode: "no_envelope",
			message: "No envelope active, preserving existing session behavior.",
		};
	}

	const envelope = input.envelope;

	// 1. Tool allow/deny list overrides
	if (envelope.deniedTools?.includes(input.toolName)) {
		return {
			outcome: "block",
			gate: "tool_gate",
			reasonCode: "tool_denied",
			message: `Tool '${input.toolName}' is explicitly denied.`,
		};
	}

	if (envelope.allowedTools && !envelope.allowedTools.includes(input.toolName)) {
		return {
			outcome: "block",
			gate: "tool_gate",
			reasonCode: "tool_not_allowed",
			message: `Tool '${input.toolName}' is not in the allowed tools list.`,
		};
	}

	// 2. Capability checks. Resolve the selected alternatives once so action-sensitive path
	// enforcement cannot disagree with capability admission.
	if (!hasCapabilityPolicyForTool(input.toolName)) {
		return {
			outcome: "block",
			gate: "tool_gate",
			reasonCode: "unknown_tool_capability",
			message: `Tool '${input.toolName}' has no capability policy in the active envelope.`,
		};
	}

	const callCapabilities = resolveToolCallCapabilities(envelope.capabilities, input.toolName, input.args);
	if (!callCapabilities) {
		const requirement = describeCapabilityRequirementForTool(input.toolName, input.args);
		return {
			outcome: "block",
			gate: "tool_gate",
			reasonCode: "missing_capability",
			message: `Tool '${input.toolName}' requires ${requirement || "a classified capability"}, which is missing from the active envelope.`,
		};
	}

	// 3. Path scope containment for caller-controlled paths. A workflow.plan pipeline read is a
	// fixed-root control-plane operation; selecting filesystem.read instead keeps the path gate.
	const pathAccess = resolveToolCallPathAccess(envelope.capabilities, input.toolName, input.args);
	const paths = pathAccess === "none" ? [] : extractCandidatePaths(input.toolName, input.args);
	if (paths.length > 0) {
		for (const targetPath of paths) {
			if (!isPathWithinEnvelope(envelope, targetPath, input.cwd)) {
				let isDenied = false;
				try {
					const target = safeRealpathSync(path.resolve(input.cwd, targetPath));
					isDenied = (envelope.deniedPaths ?? []).some((denied) => {
						try {
							return isPathWithinScope(target, safeRealpathSync(path.resolve(input.cwd, denied)));
						} catch {
							return false;
						}
					});
				} catch {}

				if (isDenied) {
					return {
						outcome: "block",
						gate: "path_scope",
						reasonCode: "path_denied",
						message: `Path '${targetPath}' is explicitly denied.`,
					};
				}
				return {
					outcome: "block",
					gate: "path_scope",
					reasonCode: "path_outside_allowed_roots",
					message: `Path '${targetPath}' is outside all allowed roots.`,
				};
			}
		}
	}

	let command = "";
	if (
		input.toolName === "bash" ||
		input.toolName === "powershell" ||
		input.toolName === "shell" ||
		input.toolName === "python"
	) {
		const argsObj = input.args as Record<string, unknown>;
		if (argsObj && typeof argsObj.command === "string") command = argsObj.command;
		else if (input.toolName === "python" && argsObj && typeof argsObj.code === "string") command = argsObj.code;
		else if (input.toolName === "python" && argsObj && typeof argsObj.scriptPath === "string") {
			command = `python ${argsObj.scriptPath}`;
		}
	} else if (input.toolName === "secret_store") {
		const argsObj = input.args as Record<string, unknown>;
		if (argsObj && typeof argsObj.action === "string") command = argsObj.action;
	}

	const riskResult = assessOperationRisk({
		operation: `Tool ${input.toolName}`,
		toolName: input.toolName,
		command,
		paths,
		capabilities: envelope.capabilities,
	});

	if (riskResult.requiresApproval) {
		return {
			outcome: "ask-user", // or block, prompt says: ask-user/block
			gate: "risk_assessment",
			reasonCode: riskResult.reasonCode,
			message: `Operation requires approval: ${riskResult.reasons.join(", ")}`,
		};
	}

	if (riskResult.risk === "high-impact") {
		return {
			outcome: "ask-user",
			gate: "risk_assessment",
			reasonCode: riskResult.reasonCode,
			message: `High-impact operation requires review: ${riskResult.reasons.join(", ")}`,
		};
	}

	return {
		outcome: "allow",
		gate: "tool_gate",
		reasonCode: "allowed_by_envelope",
		message: "Operation allowed by current capability envelope.",
	};
}
