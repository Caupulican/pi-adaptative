import type { ModelCapabilityClass } from "./model-capability.ts";

export type ProjectContextFilesMode = "on-demand" | "off";

export const PROJECT_INSTRUCTION_ISOLATION_PROMPT = `PI PROJECT INSTRUCTION ISOLATION
- Global-only mode is active. Never discover, read, or apply project-local AGENTS-family files or skills. Never use cwd/ancestor .pi/skills, .agents/skills, .codex/skills, or .claude/skills through ordinary tools. Global, bundled, and explicitly external user resources remain available. Enable project instructions on-demand before using project-local instruction resources.`;

export const PROJECT_INSTRUCTION_ISOLATION_COMPACT = "NO PROJECT INSTRUCTIONS.";

/** Prompt-layer isolation for global-only mode. Omitted mode defaults to off. */
export function buildProjectInstructionIsolationPrompt(options?: {
	mode?: ProjectContextFilesMode;
	capabilityClass?: ModelCapabilityClass;
}): string | undefined {
	if ((options?.mode ?? "off") !== "off") return undefined;
	if (options?.capabilityClass && options.capabilityClass !== "full") {
		return PROJECT_INSTRUCTION_ISOLATION_COMPACT;
	}
	return PROJECT_INSTRUCTION_ISOLATION_PROMPT;
}
