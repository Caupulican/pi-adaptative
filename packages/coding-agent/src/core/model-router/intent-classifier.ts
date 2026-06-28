export type ModelRouterIntent = "research" | "modify";

const MODIFY_INTENT_RE =
	/\b(add|apply|build|change|commit|create|delete|edit|fix|generate|implement|install|modify|patch|refactor|remove|rename|replace|run|test|update|write)\b|\b(npm|pnpm|yarn|bun|git|gh|pytest|vitest|tsc|biome)\b|[;&|]\s*\w+/i;

const EXPLICIT_MODIFY_REQUEST_RE =
	/^(?:can you|could you|please|pls|go ahead and|let'?s|i need you to|we need to|you should)\s+.*\b(add|apply|build|change|commit|create|delete|edit|fix|generate|implement|install|modify|patch|refactor|remove|rename|replace|run|test|update|write)\b/i;

const READ_ONLY_QUESTION_RE = /^(?:how|what|why|when|where|which|who|explain|summarize|compare|describe|list|show)\b/i;

export function classifyModelRouterIntent(prompt: string): ModelRouterIntent {
	const text = prompt.trim();
	if (EXPLICIT_MODIFY_REQUEST_RE.test(text)) return "modify";
	if (READ_ONLY_QUESTION_RE.test(text)) return "research";
	return MODIFY_INTENT_RE.test(text) ? "modify" : "research";
}
