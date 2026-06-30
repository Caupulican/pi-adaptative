import type { RouteDecision } from "../autonomy/contracts.ts";

export type ModelRouterIntent = "research" | "modify";

const EXPLICIT_MODIFY_REQUEST_RE =
	/^(?:can you|could you|please|pls|go ahead and|let'?s|i need you to|we need to|you should)\s+.*\b(add|apply|build|change|commit|create|delete|edit|fix|generate|implement|install|modify|patch|refactor|remove|rename|replace|run|test|update|write|publish|release|push|deploy|tag|reset|clean|rewrite)\b/i;

const READ_ONLY_QUESTION_RE =
	/^(?:(?:can you|could you|please|pls|go ahead and|let'?s|i need you to|we need to|you should)\s+)?(?:how|what|why|when|where|which|who|explain|summarize|compare|describe|list|show|search|find|view|read|locate)\b/i;

const RELEASE_PUBLISH_RE = /\b(publish|release|push|deploy|tag)\b/i;
const SECURITY_AUTH_RE = /\b(auth|token|credential|credentials|secret|api[-_]key)\b/i;
const DESTRUCTIVE_RE = /\b(delete|reset|rm\s+-rf|clean)\b/i;

const SELF_MOD_MUTATE_RE =
	/\b(modify|change|write|update|edit|delete|add|remove)\s+.*\b(skills|prompts|settings|tools|behavior)\b|self[-_]modification/i;
const ARCHITECTURE_MUTATE_RE = /\b(rewrite|redesign|change|modify|rearchitect)\s+.*\b(architecture|architect)\b/i;

const REFACTOR_RE = /\b(refactor|refactoring)\b/i;
const TEST_VALIDATION_RE = /\b(test|testing|validation|lint|vitest|jest|run)\b/i;
const IMPLEMENT_RE = /\b(implement|fix|apply|change|update|create|write|generate|modify|edit|patch|add)\b/i;

export function classifyModelRouterRoute(prompt: string): RouteDecision {
	const text = prompt.trim();

	if (text.length === 0) {
		return {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.1,
			reasonCode: "empty_prompt",
			reasons: ["Empty or whitespace prompt"],
		};
	}

	// 1. Explicit read-only questions/lookups dominate (unless prefixed by explicit mutation verb)
	if (READ_ONLY_QUESTION_RE.test(text) && !EXPLICIT_MODIFY_REQUEST_RE.test(text)) {
		return {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "read_only_question",
			reasons: ["Prompt asks a question or requests an explanation, search, or lookup"],
		};
	}

	// Helper function to match patterns and return appropriate decision
	function matchKeywords(input: string): RouteDecision | null {
		// A. High-risk / approval-required/expensive signals
		if (RELEASE_PUBLISH_RE.test(input)) {
			return {
				tier: "expensive",
				risk: "approval-required",
				confidence: 0.9,
				reasonCode: "release_or_publish",
				reasons: ["Prompt mentions publishing, releasing, pushing, or deploying"],
			};
		}
		if (SECURITY_AUTH_RE.test(input)) {
			return {
				tier: "expensive",
				risk: "high-impact",
				confidence: 0.95,
				reasonCode: "security_or_auth",
				reasons: ["Prompt mentions credentials, authentication, tokens, or secrets"],
			};
		}
		if (DESTRUCTIVE_RE.test(input)) {
			return {
				tier: "expensive",
				risk: "approval-required",
				confidence: 0.85,
				reasonCode: "destructive_or_git_history",
				reasons: ["Prompt mentions deleting, resetting, cleaning, or destructive operations"],
			};
		}
		if (SELF_MOD_MUTATE_RE.test(input)) {
			return {
				tier: "expensive",
				risk: "approval-required",
				confidence: 0.9,
				reasonCode: "settings_or_self_modification",
				reasons: ["Prompt mentions modifying skills, prompts, settings, tools, or self-modification"],
			};
		}
		if (ARCHITECTURE_MUTATE_RE.test(input)) {
			return {
				tier: "expensive",
				risk: "high-impact",
				confidence: 0.9,
				reasonCode: "architecture_or_ambiguous",
				reasons: ["Prompt mentions core architecture or rewrite"],
			};
		}

		// B. Explicit implementation/scoped-write signals route medium
		if (REFACTOR_RE.test(input)) {
			return {
				tier: "medium",
				risk: "scoped-write",
				confidence: 0.8,
				reasonCode: "mechanical_refactor",
				reasons: ["Prompt mentions refactoring code structure"],
			};
		}
		if (TEST_VALIDATION_RE.test(input)) {
			return {
				tier: "medium",
				risk: "scoped-write",
				confidence: 0.8,
				reasonCode: "test_or_validation",
				reasons: ["Prompt mentions testing, validation, or linting"],
			};
		}
		if (IMPLEMENT_RE.test(input)) {
			return {
				tier: "medium",
				risk: "scoped-write",
				confidence: 0.85,
				reasonCode: "normal_implementation",
				reasons: ["Prompt mentions implementing, updating, creating, or modifying code"],
			};
		}

		return null;
	}

	const match = matchKeywords(text);
	if (match) {
		return match;
	}

	// 4. Default fallbacks
	return {
		tier: "cheap",
		risk: "read-only",
		confidence: 0.5,
		reasonCode: "default_read_only",
		reasons: ["No explicit implementation, destructive, or release patterns detected"],
	};
}

export function classifyModelRouterIntent(prompt: string): ModelRouterIntent {
	const decision = classifyModelRouterRoute(prompt);
	return decision.tier === "cheap" ? "research" : "modify";
}
