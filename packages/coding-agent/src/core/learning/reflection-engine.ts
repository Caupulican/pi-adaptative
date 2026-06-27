import type { Usage } from "@caupulican/pi-ai";

export type StopReason = "stop" | "toolUse" | "aborted" | "error" | string;

export interface IsolatedCompletionResult {
	text: string;
	usage: Usage;
	stopReason: StopReason;
}

export type ReflectionTrigger = "complex" | "corrective" | "session-end" | "none";

export interface DemandSignals {
	trigger: ReflectionTrigger;
	toolCallCount: number;
	hadCorrection: boolean;
	contextHeadroomPct: number; // 0..100
	usefulLately: number; // 0..1 rolling score
}

export interface DemandPlan {
	act: "skip" | "reflect";
	reason: string;
	tokenBudget: number;
}

/**
 * Pure zero-I/O heuristic to decide whether the current turn justifies a reflection run
 * and determine the token budget under the cheap-tool net-negative doctrine.
 */
export function decideDemand(signals: DemandSignals): DemandPlan {
	if (signals.trigger === "none") {
		return { act: "skip", reason: "No trigger detected", tokenBudget: 0 };
	}
	if (signals.contextHeadroomPct < 10) {
		return { act: "skip", reason: "Context headroom is critically low (< 10%)", tokenBudget: 0 };
	}

	// Dynamic token budget based on headroom (keep reflection bounded between 500 and 1500 tokens)
	const baseBudget = 1000;
	const tokenBudget = Math.max(500, Math.min(1500, Math.round(baseBudget * (signals.contextHeadroomPct / 100))));

	if (signals.hadCorrection) {
		return { act: "reflect", reason: "Correction detected in the turn", tokenBudget };
	}
	if (signals.trigger === "session-end") {
		return { act: "reflect", reason: "Session end reflection triggered", tokenBudget };
	}
	if (signals.trigger === "complex") {
		if (signals.toolCallCount >= 3) {
			return { act: "reflect", reason: `Complex turn with ${signals.toolCallCount} tool calls`, tokenBudget };
		}
	}

	return { act: "skip", reason: "Signals do not justify reflection overhead", tokenBudget: 0 };
}

export interface ReflectionInput {
	recentTurnText: string; // host serializes the just-finished turn
	existingMemory: string; // current MEMORY.md + USER.md snapshot
	plan: DemandPlan;
	// host-injected isolated completion function:
	complete: (systemPrompt: string, userPrompt: string) => Promise<IsolatedCompletionResult>;
}

export type ReflectionWrite =
	| { kind: "memory_add"; section: "MEMORY" | "USER"; text: string }
	| { kind: "memory_replace"; target: string; text: string }
	| { kind: "memory_remove"; target: string }
	// R7 memory-to-behavior: promote a recurring procedural workflow into an executable skill.
	| { kind: "promote_skill"; name: string; description: string; body: string };

export interface ReflectionResult {
	writes: ReflectionWrite[];
	usage: Usage;
	rationale: string;
}

export class ReflectionEngine {
	/**
	 * Build the reflection prompt, call the injected isolated complete(),
	 * parse the response, confront existing memory, and return memory writes.
	 * Zero direct I/O.
	 */
	async reflect(input: ReflectionInput): Promise<ReflectionResult> {
		const systemPrompt = `You are a reflection engine. Your job is to analyze the recent conversation turn, compare it against the agent's existing memory, and decide if any memory updates are needed.

Existing Memory snapshot:
${input.existingMemory}

Memory guidelines:
- "MEMORY" is for project facts, configuration, repeatable workflows, and coding findings.
- "USER" is for user preferences, patterns, and style specifications.
- Avoid duplicate facts. If the fact is already represented, do not add it.
- CONFRONT existing memory: if the new turn contradicts or updates an existing fact, use "memory_replace" or "memory_remove" to supersede the old fact rather than blindly appending.
- Keep memories short, factual, and direct. No fluff.
- PROMOTE to behavior: if the turn established a REPEATABLE, multi-step PROCEDURE/workflow (not a one-off fact) that should govern a future class of tasks, emit a "promote_skill" instead of (or in addition to) a memory fact. Only promote a genuinely reusable procedure — never a single fact, a one-off narrative, or environment-specific noise. Prefer a memory fact when unsure.

You must output your analysis and writes in the following JSON format inside a \`\`\`json\`\`\` code fence:
{
  "rationale": "Explanation of your reasoning",
  "writes": [
    { "kind": "memory_add", "section": "MEMORY" | "USER", "text": "New direct fact to append" },
    { "kind": "memory_replace", "target": "Exact text substring to replace", "text": "New replacement text" },
    { "kind": "memory_remove", "target": "Exact text substring to remove" },
    { "kind": "promote_skill", "name": "kebab-case-skill-name", "description": "one line of when to use it", "body": "Markdown: the step-by-step procedure" }
  ]
}
`;

		const userPrompt = `Recent turn transcript:
${input.recentTurnText}

Analyze this turn and output your memory updates.`;

		try {
			const compResult = await input.complete(systemPrompt, userPrompt);
			const text = compResult.text;

			const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/{[\s\S]*}/);
			if (!jsonMatch) {
				return {
					writes: [],
					usage: compResult.usage,
					rationale: `Failed to locate JSON response. Raw text:\n${text}`,
				};
			}

			const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
			const rationale = parsed.rationale || "";
			const writes: ReflectionWrite[] = [];

			if (Array.isArray(parsed.writes)) {
				for (const w of parsed.writes) {
					if (w && typeof w === "object") {
						if (
							w.kind === "memory_add" &&
							(w.section === "MEMORY" || w.section === "USER") &&
							typeof w.text === "string"
						) {
							writes.push({ kind: "memory_add", section: w.section, text: w.text });
						} else if (
							w.kind === "memory_replace" &&
							typeof w.target === "string" &&
							typeof w.text === "string"
						) {
							writes.push({ kind: "memory_replace", target: w.target, text: w.text });
						} else if (w.kind === "memory_remove" && typeof w.target === "string") {
							writes.push({ kind: "memory_remove", target: w.target });
						} else if (
							w.kind === "promote_skill" &&
							typeof w.name === "string" &&
							typeof w.description === "string" &&
							typeof w.body === "string"
						) {
							writes.push({ kind: "promote_skill", name: w.name, description: w.description, body: w.body });
						}
					}
				}
			}

			return {
				writes,
				usage: compResult.usage,
				rationale,
			};
		} catch (err) {
			// Zeroed/fallback usage representation
			const emptyUsage: Usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			return {
				writes: [],
				usage: emptyUsage,
				rationale: `Error during reflection: ${String(err)}`,
			};
		}
	}
}
