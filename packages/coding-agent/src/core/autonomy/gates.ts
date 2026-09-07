import type { ExecutionPathAuthority } from "@caupulican/pi-agent-core";
import {
	resolveToolCallCapabilities,
	resolveToolCallPathAccess,
	toolUsesPathScope,
} from "../tool-capability-policy.ts";
import { describeCapabilityRequirementForTool, hasCapabilityPolicyForTool } from "./approval-gate.ts";
import type { CapabilityEnvelope, GateOutcome, GateOutcomeKind } from "./contracts.ts";
import {
	assessPathWithinEnvelopeAsync,
	assessPathWithinEnvelopeSync,
	extractToolPathArguments,
	type PathEnvelopeAssessment,
} from "./envelope-enforcement.ts";
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

export interface EvaluateToolGateInput {
	toolName: string;
	args?: unknown;
	cwd: string;
	/** Authority roots remain relative to their granting session, not the selected task. */
	scopeCwd?: string;
	envelope?: CapabilityEnvelope;
	pathAuthority?: ExecutionPathAuthority;
	signal?: AbortSignal;
}

function checkEnvelopeAndToolCapabilities(input: EvaluateToolGateInput): {
	earlyOutcome?: GateOutcome;
	paths: string[];
} {
	input.signal?.throwIfAborted();
	if (!input.envelope) {
		return {
			earlyOutcome: {
				outcome: "allow",
				gate: "tool_gate",
				reasonCode: "no_envelope",
				message: "No envelope active, preserving existing session behavior.",
			},
			paths: [],
		};
	}

	const envelope = input.envelope;
	if (envelope.deniedTools?.includes(input.toolName)) {
		return {
			earlyOutcome: {
				outcome: "block",
				gate: "tool_gate",
				reasonCode: "tool_denied",
				message: `Tool '${input.toolName}' is explicitly denied.`,
			},
			paths: [],
		};
	}

	if (envelope.allowedTools && !envelope.allowedTools.includes(input.toolName)) {
		return {
			earlyOutcome: {
				outcome: "block",
				gate: "tool_gate",
				reasonCode: "tool_not_allowed",
				message: `Tool '${input.toolName}' is not in the allowed tools list.`,
			},
			paths: [],
		};
	}

	if (!hasCapabilityPolicyForTool(input.toolName)) {
		return {
			earlyOutcome: {
				outcome: "block",
				gate: "tool_gate",
				reasonCode: "unknown_tool_capability",
				message: `Tool '${input.toolName}' has no capability policy in the active envelope.`,
			},
			paths: [],
		};
	}

	const callCapabilities = resolveToolCallCapabilities(envelope.capabilities, input.toolName, input.args);
	if (!callCapabilities) {
		const requirement = describeCapabilityRequirementForTool(input.toolName, input.args);
		return {
			earlyOutcome: {
				outcome: "block",
				gate: "tool_gate",
				reasonCode: "missing_capability",
				message: `Tool '${input.toolName}' requires ${requirement || "a classified capability"}, which is missing from the active envelope.`,
			},
			paths: [],
		};
	}

	const pathAccess = resolveToolCallPathAccess(envelope.capabilities, input.toolName, input.args);
	const paths = pathAccess === "none" ? [] : extractCandidatePaths(input.toolName, input.args);
	return { paths };
}

function pathBlockOutcome(targetPath: string, reasonCode: "path_denied" | "path_outside_allowed_roots"): GateOutcome {
	return {
		outcome: "block",
		gate: "path_scope",
		reasonCode,
		message:
			reasonCode === "path_denied"
				? `Path '${targetPath}' is explicitly denied.`
				: `Path '${targetPath}' is outside all allowed roots.`,
	};
}

function finalizeGateOutcome(input: EvaluateToolGateInput, paths: string[], envelope: CapabilityEnvelope): GateOutcome {
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
			outcome: "ask-user",
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

function checkPathAssessments(
	paths: readonly string[],
	assess: (path: string) => PathEnvelopeAssessment,
): GateOutcome | undefined {
	for (const path of paths) {
		const res = assess(path);
		if (!res.allowed) {
			return pathBlockOutcome(path, res.reasonCode ?? "path_outside_allowed_roots");
		}
	}
	return undefined;
}

export function evaluateToolGate(input: EvaluateToolGateInput): GateOutcome {
	const checked = checkEnvelopeAndToolCapabilities(input);
	if (checked.earlyOutcome) return checked.earlyOutcome;
	const envelope = input.envelope!;

	const blocked = checkPathAssessments(checked.paths, (targetPath) =>
		assessPathWithinEnvelopeSync(envelope, targetPath, {
			cwd: input.cwd,
			scopeCwd: input.scopeCwd,
			pathAuthority: input.pathAuthority,
			signal: input.signal,
		}),
	);
	if (blocked) return blocked;

	return finalizeGateOutcome(input, checked.paths, envelope);
}

export async function evaluateToolGateAsync(input: EvaluateToolGateInput): Promise<GateOutcome> {
	const checked = checkEnvelopeAndToolCapabilities(input);
	if (checked.earlyOutcome) return checked.earlyOutcome;
	const envelope = input.envelope!;

	for (const targetPath of checked.paths) {
		const assessment = await assessPathWithinEnvelopeAsync(envelope, targetPath, {
			cwd: input.cwd,
			scopeCwd: input.scopeCwd,
			pathAuthority: input.pathAuthority,
			signal: input.signal,
		});
		if (!assessment.allowed) {
			return pathBlockOutcome(targetPath, assessment.reasonCode ?? "path_outside_allowed_roots");
		}
	}

	return finalizeGateOutcome(input, checked.paths, envelope);
}
