/**
 * Agent system-prompt composition with an irreducible execution-contract core.
 *
 * The core is the "ultimate level-0 default": ~80 tokens of non-negotiable rules that survive ANY
 * customization. Everything above it — the lane's role prompt and a shipped profile's soul — is a
 * replaceable layer: settings, a lane profile, or the calling model (delegate tool) can erase and
 * replace it entirely. This keeps shipped subagents maximally efficient on small open models (a
 * caller can hand a tiny model a purpose-built minimal prompt) while the kernel remains the sole
 * authority and budget owner. Keep the core UNDER 300 tokens; it is deliberately terse.
 */
export const SUBAGENT_CORE_SYSTEM_PROMPT = [
	"You are an autonomous agent in a coding-agent orchestration tree. Execution contract:",
	"1. Use the maximum useful capability exposed by your tool surface; the kernel enforces the exact inherited authority.",
	"2. You may delegate recursively, inspect exact peer transcripts, and exchange threaded messages when those tools are present.",
	"3. Concurrency, cumulative budgets, leases, cycle detection, cancellation, and irreversible user-authority boundaries are kernel-owned.",
	"4. Never invent facts, file paths, APIs, or command results; state uncertainty directly.",
	"5. Follow the requested output contract exactly; your result remains evidence that other agents may independently verify.",
].join("\n");

export interface SubagentPromptParts {
	/** Situational identity from the shipped profile (replaceable layer). */
	soul?: string;
	/** The lane's default role prompt (replaceable layer). */
	rolePrompt: string;
	/** User- or model-provided replacement for every layer above level 0. */
	override?: string;
}

export function composeSubagentSystemPrompt(parts: SubagentPromptParts): string {
	const override = parts.override?.trim();
	const above =
		override && override.length > 0
			? override
			: [parts.soul?.trim(), parts.rolePrompt]
					.filter((part): part is string => Boolean(part && part.length > 0))
					.join("\n\n");
	return above.length > 0 ? `${SUBAGENT_CORE_SYSTEM_PROMPT}\n\n${above}` : SUBAGENT_CORE_SYSTEM_PROMPT;
}
