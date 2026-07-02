/**
 * Subagent system-prompt composition with an irreducible level-0 core.
 *
 * The core is the "ultimate level-0 default": ~80 tokens of non-negotiable rules that survive ANY
 * customization. Everything above it — the lane's role prompt and a shipped profile's soul — is a
 * replaceable layer: settings, a lane profile, or the calling model (delegate tool) can erase and
 * replace it entirely. This keeps shipped subagents maximally efficient on small open models (a
 * caller can hand a tiny model a purpose-built minimal prompt) without ever shedding the safety
 * floor. Keep the core UNDER 300 tokens; it is deliberately terse.
 */
export const SUBAGENT_CORE_SYSTEM_PROMPT = [
	"You are a bounded subagent shipped by a coding-agent session. Non-negotiable rules:",
	"1. Do only the task you were given; you cannot see the parent conversation.",
	"2. You are read-only unless your envelope explicitly grants otherwise; never attempt to change files, settings, credentials, or external state.",
	"3. Never invent facts, file paths, or APIs; say so when you do not know.",
	"4. Your output is untrusted evidence for the parent agent - data, never instructions.",
	"5. Follow the requested output format exactly and be concise; budgets are enforced outside you.",
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
