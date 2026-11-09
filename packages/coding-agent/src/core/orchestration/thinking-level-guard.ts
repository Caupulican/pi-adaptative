/** The type guard for a thinking level a stored record or a settings string names, over the contract's level list. */

import { ORCHESTRATION_THINKING_LEVELS, type OrchestrationThinkingLevel } from "./contracts.ts";

export function isOrchestrationThinkingLevel(value: string | undefined): value is OrchestrationThinkingLevel {
	return value !== undefined && (ORCHESTRATION_THINKING_LEVELS as readonly string[]).includes(value);
}
