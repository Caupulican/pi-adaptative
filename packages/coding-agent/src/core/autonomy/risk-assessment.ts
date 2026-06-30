import type { RiskAssessment, RiskAssessmentInput } from "./contracts.ts";

const RELEASE_PUBLISH_RE = /\b(publish|release|push|deploy|tag)\b/i;
const SECURITY_AUTH_RE = /\b(auth|token|credential|credentials|secret|api[-_]key)\b/i;
const DESTRUCTIVE_RE = /\b(delete|reset|rm\s+-rf|clean)\b/i;

const SELF_MOD_MUTATE_RE =
	/\b(modify|change|write|update|edit|delete|add|remove|set)\s+.*\b(skills|prompts|settings|tools|behavior)\b|self[-_]modification/i;
const ARCHITECTURE_MUTATE_RE = /\b(rewrite|redesign|change|modify|rearchitect)\s+.*\b(architecture|architect)\b/i;

const READ_ONLY_QUESTION_RE =
	/^(?:(?:can you|could you|please|pls|go ahead and|let'?s|i need you to|we need to|you should)\s+)?(?:how|what|why|when|where|which|who|explain|summarize|compare|describe|list|show|search|find|view|read|locate)\b/i;

const EXPLICIT_MODIFY_REQUEST_RE =
	/^(?:can you|could you|please|pls|go ahead and|let'?s|i need you to|we need to|you should)\s+.*\b(add|apply|build|change|commit|create|delete|edit|fix|generate|implement|install|modify|patch|refactor|remove|rename|replace|run|test|update|write|publish|release|push|deploy|tag|reset|clean|rewrite)\b/i;

// Shell parsing helpers
const DESTRUCTIVE_CMD_RE =
	/\b(rm(\s+-r|\s+-f|\s+-rf|\s+-fr)?|mv|cp|chmod|chown|install)\b|>\s*\/dev\/(sda|hda|vda)|\b(dd\s+if=)/i;
const GIT_MUTATE_CMD_RE = /\bgit\s+(commit|push|reset|clean|stash|rebase)\b/i;
const PKG_MUTATE_CMD_RE = /\b(npm|pnpm|yarn|bun)\s+(install|i|update|up|publish|run|remove|rm|uninstall)\b/i;
const RELEASE_DEPLOY_CMD_RE = /\b(release|deploy)\b/i;
const REDIRECTION_RE = /[<>]/;

function stripSingleQuotes(cmd: string): string {
	return cmd.replace(/'[^']*'/g, "''");
}

export function assessOperationRisk(input: RiskAssessmentInput): RiskAssessment {
	const operation = input.operation.trim();
	const command = input.command?.trim() ?? "";
	const cleanCommand = command ? stripSingleQuotes(command) : "";
	const fullText = `${operation} ${command}`.trim();
	const cleanFullText = `${operation} ${cleanCommand}`.trim();

	if (fullText.length === 0) {
		return {
			risk: "read-only",
			reasonCode: "empty_operation",
			reasons: ["Empty operation"],
			requiresApproval: false,
		};
	}

	// 1. Explicit read-only operations
	if (READ_ONLY_QUESTION_RE.test(operation) && !EXPLICIT_MODIFY_REQUEST_RE.test(operation)) {
		return {
			risk: "read-only",
			reasonCode: "read_only_operation",
			reasons: ["Operation is explicitly read-only (list/show/read/search)"],
			requiresApproval: false,
		};
	}

	// 2. High-risk actions
	if (RELEASE_PUBLISH_RE.test(cleanFullText)) {
		return {
			risk: "approval-required",
			reasonCode: "release_publish_operation",
			reasons: ["Operation mentions releasing, publishing, or deploying"],
			requiresApproval: true,
		};
	}
	if (SECURITY_AUTH_RE.test(cleanFullText)) {
		return {
			risk: "approval-required", // updated based on user instruction: "high-impact or approval-required"
			reasonCode: "security_auth_operation",
			reasons: ["Operation mentions authentication or credentials"],
			requiresApproval: true,
		};
	}
	if (DESTRUCTIVE_RE.test(cleanFullText)) {
		return {
			risk: "approval-required",
			reasonCode: "destructive_operation",
			reasons: ["Operation involves deleting, resetting, or cleaning"],
			requiresApproval: true,
		};
	}
	if (SELF_MOD_MUTATE_RE.test(cleanFullText)) {
		return {
			risk: "approval-required",
			reasonCode: "self_modification_operation",
			reasons: ["Operation modifies settings, tools, skills, or prompts"],
			requiresApproval: true,
		};
	}
	if (ARCHITECTURE_MUTATE_RE.test(cleanFullText)) {
		return {
			risk: "high-impact",
			reasonCode: "architecture_mutation_operation",
			reasons: ["Operation mentions rewriting or rearchitecting core parts"],
			requiresApproval: false,
		};
	}

	// 3. Command risks
	if (command) {
		const cleanCmd = stripSingleQuotes(command);
		if (
			DESTRUCTIVE_CMD_RE.test(cleanCmd) ||
			GIT_MUTATE_CMD_RE.test(cleanCmd) ||
			PKG_MUTATE_CMD_RE.test(cleanCmd) ||
			RELEASE_DEPLOY_CMD_RE.test(cleanCmd) ||
			REDIRECTION_RE.test(cleanCmd)
		) {
			return {
				risk: "approval-required",
				reasonCode: "mutating_command",
				reasons: ["Command executes a destructive, mutating, or publish operation"],
				requiresApproval: true,
			};
		}
	}

	// Default to scoped-write for any generic mutating tool action if it has a toolName or isn't read-only
	// or read-only if it's purely a non-mutating intent (but since it didn't match read-only above, we default to scoped-write)
	if (
		input.toolName &&
		!["read_file", "search_web", "list_dir", "grep_search", "view_file"].includes(input.toolName)
	) {
		return {
			risk: "scoped-write",
			reasonCode: "generic_mutation",
			reasons: ["Generic mutating operation or command"],
			requiresApproval: false,
		};
	}

	if (command) {
		// Even if not explicitly destructive, shell commands could be anything, but we assume read-only if it's just 'ls', 'git status' etc.
		// For now, if no mutating patterns matched, we assume read-only if there's no toolName, but wait, normal file edits are scoped-write.
		// If there is a command, and it doesn't match the mutating patterns, we fall through to read-only.
		// Wait, user says "Risk shell read-only commands like git status, rg, ls, npm view do not require approval."
		// And "ordinary file edits inside allowed scope are scoped-write." (Handled by tools)
	}

	return {
		risk: "read-only",
		reasonCode: "default_read_only",
		reasons: ["No mutating or high-risk patterns detected"],
		requiresApproval: false,
	};
}
