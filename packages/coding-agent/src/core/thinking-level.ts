import type { ThinkingLevel } from "../kernel/index.ts";

export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}
