/** Bounded objective display text points to the complete definition retained by the goal owner. */
import type { Requirement } from "../goals/goal-state.ts";
import { requirementKey } from "../goals/requirement-proof.ts";

/** Includes JSON quotes, escaping, and the reference marker, so 256 descriptions use at most 256 KiB. */
export const MAX_GOAL_OBJECTIVE_DESCRIPTION_BYTES = 1024;

export function goalObjectiveRequirementDescription(requirement: Requirement): string {
	const text = requirement.text;
	if (Buffer.byteLength(JSON.stringify(text), "utf8") <= MAX_GOAL_OBJECTIVE_DESCRIPTION_BYTES) return text;
	const characters = Array.from(text);
	const marker = ` … [Display excerpt; full definition ${requirementKey(requirement)} is retained in the source goal.]`;
	let low = 0;
	let high = characters.length;
	while (low < high) {
		const count = Math.ceil((low + high) / 2);
		const candidate = characters.slice(0, count).join("") + marker;
		if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_GOAL_OBJECTIVE_DESCRIPTION_BYTES) low = count;
		else high = count - 1;
	}
	return characters.slice(0, low).join("") + marker;
}
