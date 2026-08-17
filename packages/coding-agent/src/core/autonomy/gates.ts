import path from "node:path";
import {
	hasCapabilityPolicyForTool,
	hasRequiredCapabilityForTool,
	requiredCapabilitiesForTool,
} from "./approval-gate.ts";
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

const PATH_SCOPE_TOOLS = new Set([
	"read",
	"write",
	"edit",
	"edit-diff",
	"ls",
	"grep",
	"find",
	"artifact_retrieve",
	"context_scout",
	"worktree_sync",
	"skill",
	"skill_audit",
	"skillify",
	"extensionify",
	"secret_store",
]);

const PATH_ARG_KEYS = ["path", "file_path", "filePath", "cwd", "directory", "dir", "target"] as const;
const PATH_LIST_ARG_KEYS = ["paths", "files"] as const;

export function extractCandidatePaths(toolName: string, args: unknown): string[] {
	if (!args || typeof args !== "object" || !PATH_SCOPE_TOOLS.has(toolName.toLowerCase())) return [];
	const obj = args as Record<string, unknown>;
	const paths: string[] = [];

	for (const key of PATH_ARG_KEYS) {
		const val = obj[key];
		if (typeof val === "string" && val.trim()) {
			paths.push(val.trim());
		}
	}

	for (const key of PATH_LIST_ARG_KEYS) {
		const val = obj[key];
		if (Array.isArray(val)) {
			for (const item of val) {
				if (typeof item === "string" && item.trim()) {
					paths.push(item.trim());
				}
			}
		}
	}

	if (toolName === "secret_store" && obj.action === "migrate" && Array.isArray(obj.sources)) {
		for (const source of obj.sources) {
			if (
				source &&
				typeof source === "object" &&
				"path" in source &&
				typeof source.path === "string" &&
				source.path.trim()
			) {
				paths.push(source.path.trim());
			}
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
	if (paths.length > 0) {
		const allowedPaths = envelope.allowedPaths;
		const deniedPaths = envelope.deniedPaths ?? [];

		for (const targetPath of paths) {
			const scopedTargetPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(input.cwd, targetPath);

			// 2.1 Check denied paths first (denials take precedence)
			for (const deniedRoot of deniedPaths) {
				const scopedDenied = path.isAbsolute(deniedRoot) ? deniedRoot : path.resolve(input.cwd, deniedRoot);
				const decision = checkPathScope(
					{
						root: scopedDenied,
						allowedPaths: [scopedDenied],
						deniedPaths: [scopedDenied],
					},
					scopedTargetPath,
				);
				if (decision.kind === "denied" || decision.kind === "inside") {
					return {
						outcome: "block",
						gate: "path_scope",
						reasonCode: "path_denied",
						message: `Path '${targetPath}' is explicitly denied by rule '${deniedRoot}'.`,
					};
				}
			}

			// 2.2 If allowedPaths is specified and non-empty, ensure containment
			if (allowedPaths && allowedPaths.length > 0) {
				let isInsideAny = false;
				for (const allowedRoot of allowedPaths) {
					const scopedAllowed = path.isAbsolute(allowedRoot) ? allowedRoot : path.resolve(input.cwd, allowedRoot);
					const decision = checkPathScope(
						{
							root: scopedAllowed,
							allowedPaths: envelope.allowedPaths,
							deniedPaths: envelope.deniedPaths,
						},
						scopedTargetPath,
					);
					if (decision.kind === "inside") {
						isInsideAny = true;
						break;
					}
				}

				if (!isInsideAny) {
					return {
						outcome: "block",
						gate: "path_scope",
						reasonCode: "path_outside_allowed_roots",
						message: `Path '${targetPath}' is outside all allowed roots.`,
					};
				}
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
	if (!hasRequiredCapabilityForTool(envelope.capabilities, input.toolName, input.args)) {
		return {
			outcome: "block",
			gate: "tool_gate",
			reasonCode: "missing_capability",
			message: `Tool '${input.toolName}' requires capability '${requiredCaps.join(" or ")}', which is missing from the active envelope.`,
		};
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
