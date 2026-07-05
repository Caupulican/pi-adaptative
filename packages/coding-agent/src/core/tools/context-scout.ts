import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ScoutRunResult } from "../scout-controller.ts";

export const CONTEXT_SCOUT_GUIDANCE = `context_scout: delegate repository exploration to a fast read-only scout. Use it BEFORE editing/answering when the answer spans more than ~3 files or requires tracing logic across modules ("how does X work", "what calls Y", "what breaks if Z changes"). Do NOT use it for: a file you already read this session; a single obvious grep in a known file; pure generation with no exploration. The scout returns a summary plus file:line citations — read the cited regions yourself before acting on them.`;

const contextScoutSchema = Type.Object(
	{
		query: Type.String({ minLength: 8, description: "Repository exploration question for the read-only scout." }),
		maxTurns: Type.Optional(
			Type.Number({ minimum: 1, maximum: 12, description: "Scout turn budget, clamped to 1-12." }),
		),
	},
	{ additionalProperties: false },
);

export type ContextScoutToolInput = Static<typeof contextScoutSchema>;

export interface ContextScoutToolDetails {
	result: ScoutRunResult;
}

export interface ContextScoutToolDependencies {
	runScout(input: ContextScoutToolInput): Promise<ScoutRunResult>;
}

export function createContextScoutToolDefinition(deps: ContextScoutToolDependencies): ToolDefinition {
	return {
		name: "context_scout",
		label: "context_scout",
		description:
			"Scout repository context with a bounded read-only subagent that returns validated file:line citations.",
		promptSnippet: "Delegate broad repository exploration to the read-only context_scout tool.",
		promptGuidelines: [CONTEXT_SCOUT_GUIDANCE],
		parameters: contextScoutSchema,
		async execute(_toolCallId, input: ContextScoutToolInput) {
			const result = await deps.runScout(input);
			return {
				content: [{ type: "text" as const, text: formatScoutResult(result) }],
				details: { result },
			};
		},
	};
}

export function formatScoutResult(result: ScoutRunResult): string {
	if (result.failure) {
		return `scout unavailable: ${result.failure}`;
	}

	const lines: string[] = [result.summary || "Scout found no relevant evidence."];
	const validCitations = result.citations.filter((citation) => citation.valid);
	if (validCitations.length > 0) {
		lines.push("", "Citations:");
		for (const citation of validCitations) {
			lines.push(`- ${citation.path}:${citation.start}-${citation.end}`);
		}
	}
	if (result.droppedCitations > 0) {
		lines.push(``, `Dropped invalid citations: ${result.droppedCitations}`);
	}
	if (result.unreliable) {
		lines.push("Scout result marked unreliable: more than 50% of citations were invalid.");
	}
	if (result.truncated) {
		lines.push(`Scout run truncated after ${result.turnsUsed} turn(s); evidence may be partial.`);
	}
	return lines.join("\n");
}
