import path from "node:path";
import { hasCapabilityPolicyForTool, requiredCapabilitiesForTool } from "./approval-gate.ts";
import type { CapabilityEnvelope, GateOutcome, GateOutcomeKind } from "./contracts.ts";
import { checkPathScope } from "./path-scope.ts";
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
	if (!args || typeof args !== "object") return [];
	const obj = args as Record<string, unknown>;
	const paths: string[] = [];

	if (
		toolName === "read" ||
		toolName === "write" ||
		toolName === "edit" ||
		toolName === "ls" ||
		toolName === "grep" ||
		toolName === "find"
	) {
		if (typeof obj.path === "string" && obj.path.trim()) {
			paths.push(obj.path.trim());
		}
	}

	return paths;
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

	// 2. Path scope containment for file tools
	const paths = extractCandidatePaths(input.toolName, input.args);
	if (paths.length > 0 && envelope.allowedPaths) {
		// If envelope has allowedPaths, we must check them
		for (const targetPath of paths) {
			const scopedTargetPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(input.cwd, targetPath);
			let isInsideAny = false;
			let isDenied = false;
			let denyRule = "";

			for (const allowedRoot of envelope.allowedPaths) {
				const decision = checkPathScope(
					{
						root: allowedRoot,
						allowedPaths: envelope.allowedPaths,
						deniedPaths: envelope.deniedPaths,
					},
					scopedTargetPath,
				);

				if (decision.kind === "denied") {
					isDenied = true;
					denyRule = decision.matchedRule || "";
					break;
				}
				if (decision.kind === "inside") {
					isInsideAny = true;
				}
			}

			if (isDenied) {
				return {
					outcome: "block",
					gate: "path_scope",
					reasonCode: "path_denied",
					message: `Path '${targetPath}' is explicitly denied by rule '${denyRule}'.`,
				};
			}

			if (!isInsideAny) {
				// Block only if the tool is mutating. Wait, read path outside allowed root -> block.
				// "read path inside allowed root -> allow. write/edit path outside allowed root -> block. denied path inside allowed root -> block."
				return {
					outcome: "block",
					gate: "path_scope",
					reasonCode: "path_outside_allowed_roots",
					message: `Path '${targetPath}' is outside all allowed roots.`,
				};
			}
		}
	}

	// 2.5. Capability checks
	if (!hasCapabilityPolicyForTool(input.toolName)) {
		return {
			outcome: "block",
			gate: "tool_gate",
			reasonCode: "unknown_tool_capability",
			message: `Tool '${input.toolName}' has no capability policy in the active envelope.`,
		};
	}

	const requiredCaps = requiredCapabilitiesForTool(input.toolName, input.args);
	for (const reqCap of requiredCaps) {
		if (!envelope.capabilities.includes(reqCap)) {
			return {
				outcome: "block",
				gate: "tool_gate",
				reasonCode: "missing_capability",
				message: `Tool '${input.toolName}' requires capability '${reqCap}', which is missing from the active envelope.`,
			};
		}
	}
	let command = "";
	if (input.toolName === "bash" || input.toolName === "shell") {
		const argsObj = input.args as Record<string, unknown>;
		if (argsObj && typeof argsObj.command === "string") {
			command = argsObj.command;
		}
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
