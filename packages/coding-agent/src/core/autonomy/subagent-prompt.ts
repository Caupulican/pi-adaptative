import { SUBAGENT_CORE_SYSTEM_PROMPT } from "../provider-prompt-contracts.ts";

export { SUBAGENT_CORE_SYSTEM_PROMPT };

/**
 * Agent system-prompt composition with an irreducible execution-contract core.
 *
 * The core is the "ultimate level-0 default": ~100 tokens of non-negotiable rules that survive ANY
 * customization. Everything above it — the lane's role prompt and a shipped profile's soul — is a
 * replaceable layer: settings, a lane profile, or the calling model (delegate tool) can erase and
 * replace it entirely. This keeps shipped subagents maximally efficient on small open models (a
 * caller can hand a tiny model a purpose-built minimal prompt) while the kernel remains the sole
 * authority and budget owner. Keep the core UNDER 300 tokens; it is deliberately terse.
 */
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
