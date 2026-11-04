import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ScoutRunResult } from "../scout-controller.ts";

export const CONTEXT_SCOUT_GUIDANCE =
	"Use before editing/answering when the answer spans over ~3 files or traces logic across modules; read cited regions before acting.";

const contextScoutSchema = Type.Object(
	{
		query: Type.String({ minLength: 8 }),
		maxTurns: Type.Optional(Type.Number({ minimum: 1, maximum: 12, description: "Scout turn budget." })),
	},
	{ additionalProperties: false },
);

export type ContextScoutToolInput = Static<typeof contextScoutSchema>;

export interface ContextScoutToolDetails {
	result: ScoutRunResult;
}

export interface ContextScoutToolDependencies {
	runScout(input: ContextScoutToolInput, signal?: AbortSignal): Promise<ScoutRunResult>;
}

export function createContextScoutToolDefinition(deps: ContextScoutToolDependencies): ToolDefinition {
	return {
		name: "context_scout",
		label: "context_scout",
		description: `Delegate repository exploration to a bounded read-only scout subagent; returns a summary with validated file:line citations. ${CONTEXT_SCOUT_GUIDANCE} Skip it for a file already read, a single grep in a known file, or pure generation.`,
		promptSnippet: "Explore the repository via a scout",
		parameters: contextScoutSchema,
		async execute(_toolCallId, input: ContextScoutToolInput, signal) {
			const result = await deps.runScout(input, signal);
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
