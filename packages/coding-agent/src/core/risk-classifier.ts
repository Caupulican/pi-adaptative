import type { OperationRisk, RiskAssessment, RiskAssessmentInput, RouteDecision } from "./autonomy/contracts.ts";

export type ModelRouterIntent = "research" | "modify";

const EXPLICIT_MODIFY_REQUEST_RE =
	/^(?:can you|could you|please|pls|go ahead and|let'?s|i need you to|we need to|you should)\s+.*\b(add|apply|build|change|commit|create|delete|edit|fix|generate|implement|install|modify|patch|remove|rename|replace|run|test|update|write|publish|release|push|deploy|tag|reset|clean|rewrite)\b/i;
const READ_ONLY_QUESTION_RE =
	/^(?:(?:can you|could you|please|pls|go ahead and|let'?s|i need you to|we need to|you should)\s+)?(?:how|what|why|when|where|which|who|explain|summarize|compare|describe|list|show|search|find|view|read|locate)\b/i;
const RELEASE_PUBLISH_RE = /\b(publish|release|push|deploy|tag)\b/i;
const SECURITY_AUTH_RE = /\b(auth|token|credential|credentials|secret|api[-_]key)\b/i;
const DESTRUCTIVE_RE = /\b(delete|reset|rm\s+-rf|clean)\b/i;
const SELF_MOD_MUTATE_RE =
	/\b(modify|change|write|update|edit|delete|add|remove|set)\s+.*\b(skills|prompts|settings|tools|behavior)\b|self[-_]modification/i;
const ARCHITECTURE_MUTATE_RE = /\b(rewrite|redesign|change|modify|rearchitect)\s+.*\b(architecture|architect)\b/i;
const PLANNING_CORE_RE = /\b(plan|planning|roadmap|strategy)\b/i;
const PLANNING_DESIGN_WORD_RE = /\b(design|architect\w*|structure|approach)\b/i;
const PLANNING_PROSPECTIVE_RE =
	/\b(how (?:should|would|do we|can we)|what(?:'s| is) the (?:best|cleanest|right)|propose|draft|come up with|figure out|decide (?:on|how))\b/i;
const REFACTOR_RE = /\b(refactor|refactoring)\b/i;
const TEST_VALIDATION_RE = /\b(test|testing|validation|lint|vitest|jest|run)\b/i;
const IMPLEMENT_RE = /\b(implement|fix|apply|change|update|create|write|generate|modify|edit|patch|add)\b/i;
const DESTRUCTIVE_CMD_RE =
	/\b(rm(\s+-r|\s+-f|\s+-rf|\s+-fr)?|mv|cp|chmod|chown|install)\b|>\s*\/dev\/(sda|hda|vda)|\b(dd\s+if=)/i;
const GIT_APPROVAL_CMD_RE = /\bgit\s+(push|reset|clean|stash|rebase)\b/i;
const GIT_LOCAL_COMMIT_CMD_RE = /^\s*git(?:\s+-C\s+\S+)?\s+commit(?:\s|$)/i;
const GIT_COMMIT_HISTORY_RE = /(?:^|\s)--amend(?:\s|$)/i;
const SHELL_CONTROL_RE = /(?:&&|\|\||[;&|<>`\r\n]|\$\()/;
const PKG_MUTATE_CMD_RE = /\b(npm|pnpm|yarn|bun)\s+(install|i|update|up|publish|run|remove|rm|uninstall)\b/i;
const RELEASE_DEPLOY_CMD_RE = /\b(release|deploy)\b/i;
const PYTHON_HIGH_IMPACT_RE =
	/\b(?:shutil\.(?:rmtree|move|copy|copy2|copytree)|os\.(?:remove|unlink|rmdir|removedirs|system)|subprocess\.(?:run|call|check_call|check_output|Popen)|Path\([^)]*\)\.(?:unlink|rmdir))\b/i;
const REDIRECTION_RE = /[<>]/;

interface RiskSignal {
	risk: OperationRisk;
	kind: "release" | "security" | "destructive" | "self-modification" | "architecture";
	reason: string;
}

function isPlanningPrompt(text: string): boolean {
	return PLANNING_CORE_RE.test(text) || (PLANNING_DESIGN_WORD_RE.test(text) && PLANNING_PROSPECTIVE_RE.test(text));
}

function highRiskSignal(text: string): RiskSignal | undefined {
	if (RELEASE_PUBLISH_RE.test(text)) {
		return {
			risk: "approval-required",
			kind: "release",
			reason: "Operation mentions releasing, publishing, or deploying",
		};
	}
	if (SECURITY_AUTH_RE.test(text)) {
		return {
			risk: "approval-required",
			kind: "security",
			reason: "Operation mentions authentication or credentials",
		};
	}
	if (DESTRUCTIVE_RE.test(text)) {
		return {
			risk: "approval-required",
			kind: "destructive",
			reason: "Operation involves deleting, resetting, or cleaning",
		};
	}
	if (SELF_MOD_MUTATE_RE.test(text)) {
		return {
			risk: "approval-required",
			kind: "self-modification",
			reason: "Operation modifies settings, tools, skills, or prompts",
		};
	}
	if (ARCHITECTURE_MUTATE_RE.test(text)) {
		return {
			risk: "high-impact",
			kind: "architecture",
			reason: "Operation mentions rewriting or rearchitecting core parts",
		};
	}
	return undefined;
}

function stripSingleQuotes(command: string): string {
	return command.replace(/'[^']*'/g, "''");
}

export function classifyModelRouterRoute(prompt: string): RouteDecision {
	const text = prompt.trim();
	if (!text) {
		return {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.1,
			reasonCode: "empty_prompt",
			reasons: ["Empty or whitespace prompt"],
		};
	}
	if (READ_ONLY_QUESTION_RE.test(text) && !EXPLICIT_MODIFY_REQUEST_RE.test(text)) {
		if (isPlanningPrompt(text)) {
			return {
				tier: "medium",
				risk: "read-only",
				confidence: 0.75,
				reasonCode: "planning_min_medium",
				reasons: ["Planning/design prompts never route cheap by default; a judge may deem them trivial"],
			};
		}
		return {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "read_only_question",
			reasons: ["Prompt asks a question or requests an explanation, search, or lookup"],
		};
	}
	const highRisk = highRiskSignal(text);
	if (highRisk) {
		const reasonCode: Record<RiskSignal["kind"], string> = {
			release: "release_or_publish",
			security: "security_or_auth",
			destructive: "destructive_or_git_history",
			"self-modification": "settings_or_self_modification",
			architecture: "architecture_or_ambiguous",
		};
		return {
			tier: "expensive",
			risk: highRisk.kind === "security" ? "high-impact" : highRisk.risk,
			confidence: highRisk.kind === "security" ? 0.95 : highRisk.kind === "destructive" ? 0.85 : 0.9,
			reasonCode: reasonCode[highRisk.kind],
			reasons: [highRisk.reason],
		};
	}
	if (isPlanningPrompt(text)) {
		return {
			tier: "medium",
			risk: "read-only",
			confidence: 0.75,
			reasonCode: "planning_min_medium",
			reasons: ["Planning/design prompts never route cheap by default; a judge may deem them trivial"],
		};
	}
	if (REFACTOR_RE.test(text)) {
		return {
			tier: "medium",
			risk: "scoped-write",
			confidence: 0.8,
			reasonCode: "mechanical_refactor",
			reasons: ["Prompt mentions refactoring code structure"],
		};
	}
	if (TEST_VALIDATION_RE.test(text)) {
		return {
			tier: "medium",
			risk: "scoped-write",
			confidence: 0.8,
			reasonCode: "test_or_validation",
			reasons: ["Prompt mentions testing, validation, or linting"],
		};
	}
	if (IMPLEMENT_RE.test(text)) {
		return {
			tier: "medium",
			risk: "scoped-write",
			confidence: 0.85,
			reasonCode: "normal_implementation",
			reasons: ["Prompt mentions implementing, updating, creating, or modifying code"],
		};
	}
	return {
		tier: "cheap",
		risk: "read-only",
		confidence: 0.5,
		reasonCode: "default_read_only",
		reasons: ["No explicit implementation, destructive, or release patterns detected"],
	};
}

export function classifyModelRouterIntent(prompt: string): ModelRouterIntent {
	return classifyModelRouterRoute(prompt).tier === "cheap" ? "research" : "modify";
}

export function assessOperationRisk(input: RiskAssessmentInput): RiskAssessment {
	const operation = input.operation.trim();
	const command = input.command?.trim() ?? "";
	const cleanCommand = stripSingleQuotes(command);
	const fullText = `${operation} ${command}`.trim();
	const cleanFullText = `${operation} ${cleanCommand}`.trim();
	if (!fullText) {
		return {
			risk: "read-only",
			reasonCode: "empty_operation",
			reasons: ["Empty operation"],
			requiresApproval: false,
		};
	}
	if (input.toolName === "secret_store") {
		if (command === "migrate") {
			return {
				risk: "scoped-write",
				reasonCode: "authorized_credential_migration",
				reasons: ["Credential values move through a model-blind host adapter into the current-project vault"],
				requiresApproval: false,
			};
		}
		return {
			risk: "read-only",
			reasonCode: "authorized_credential_use",
			reasons: ["Credential operations are model-blind and limited to the user plane and current project"],
			requiresApproval: false,
		};
	}
	if (READ_ONLY_QUESTION_RE.test(operation) && !EXPLICIT_MODIFY_REQUEST_RE.test(operation)) {
		return {
			risk: "read-only",
			reasonCode: "read_only_operation",
			reasons: ["Operation is explicitly read-only (list/show/read/search)"],
			requiresApproval: false,
		};
	}
	const isCommitCommand = command.length > 0 && GIT_LOCAL_COMMIT_CMD_RE.test(cleanCommand);
	const isHistoryRewritingCommit = isCommitCommand && GIT_COMMIT_HISTORY_RE.test(cleanCommand);
	const isShellComposedCommit = isCommitCommand && SHELL_CONTROL_RE.test(cleanCommand);
	const isLocalCommitOnly = isCommitCommand && !isHistoryRewritingCommit && !isShellComposedCommit;
	// A commit message may legitimately contain words such as "release". Classify the operation text
	// separately, then admit only one plain local commit command; shell composition and history rewrite
	// stay on the approval path below.
	if (isLocalCommitOnly && !highRiskSignal(operation)) {
		return {
			risk: "scoped-write",
			reasonCode: "local_git_commit",
			reasons: ["A local commit is a reversible repository checkpoint and does not publish changes"],
			requiresApproval: false,
		};
	}
	const highRisk = highRiskSignal(cleanFullText);
	if (highRisk) {
		const reasonCode: Record<RiskSignal["kind"], string> = {
			release: "release_publish_operation",
			security: "security_auth_operation",
			destructive: "destructive_operation",
			"self-modification": "self_modification_operation",
			architecture: "architecture_mutation_operation",
		};
		return {
			risk: highRisk.risk,
			reasonCode: reasonCode[highRisk.kind],
			reasons: [highRisk.reason],
			requiresApproval: highRisk.risk === "approval-required",
		};
	}
	if (
		command &&
		(DESTRUCTIVE_CMD_RE.test(cleanCommand) ||
			GIT_APPROVAL_CMD_RE.test(cleanCommand) ||
			isHistoryRewritingCommit ||
			isShellComposedCommit ||
			PKG_MUTATE_CMD_RE.test(cleanCommand) ||
			RELEASE_DEPLOY_CMD_RE.test(cleanCommand) ||
			PYTHON_HIGH_IMPACT_RE.test(cleanCommand) ||
			REDIRECTION_RE.test(cleanCommand))
	) {
		return {
			risk: "approval-required",
			reasonCode: "mutating_command",
			reasons: ["Command executes a destructive, mutating, or publish operation"],
			requiresApproval: true,
		};
	}
	if (
		input.toolName &&
		!["read_file", "search_web", "list_dir", "grep_search", "view_file", "memory"].includes(input.toolName)
	) {
		return {
			risk: "scoped-write",
			reasonCode: "generic_mutation",
			reasons: ["Generic mutating operation or command"],
			requiresApproval: false,
		};
	}
	return {
		risk: "read-only",
		reasonCode: "default_read_only",
		reasons: ["No mutating or high-risk patterns detected"],
		requiresApproval: false,
	};
}
