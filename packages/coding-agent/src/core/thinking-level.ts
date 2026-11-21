import type { ThinkingLevel } from "../kernel/index.ts";

export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export function isValidThinkingLevel(level: unknown): level is ThinkingLevel {
	return typeof level === "string" && (VALID_THINKING_LEVELS as readonly string[]).includes(level);
}
