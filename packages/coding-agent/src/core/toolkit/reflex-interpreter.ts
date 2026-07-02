import type { ToolkitScript } from "./script-registry.ts";

/**
 * Reflex interpreter (the BRAIN half of the user-ratified brain->muscle pipeline, statistically
 * validated at 10/10 correct interpretations on the hard registry): a strict instruction
 * interpreter that maps a fuzzy user request onto the toolkit registry. It NEVER executes
 * anything — it only proposes `{script, args, danger, confidence}` for the deterministic
 * executor path, which still enforces every safety rule (danger confirmation included).
 */

export const REFLEX_INTERPRETER_SYSTEM_PROMPT = [
	"You are a strict instruction interpreter for a script executor. You NEVER execute anything.",
	"Given a user request and the script registry, output STRICT JSON only:",
	'{"script":"<exact registry name>","args":["..."],"danger":true|false,"confidence":<0..1>}',
	"Pick the single best script. Extract arguments exactly as the script expects. Mark danger from the registry.",
	'If no script fits, output {"script":"none","args":[],"danger":false,"confidence":0}.',
].join("\n");

export interface ReflexPlan {
	script: string;
	args: string[];
	danger: boolean;
	confidence: number;
}

export const REFLEX_MIN_CONFIDENCE = 0.75;

export function buildReflexUserPrompt(request: string, scripts: readonly ToolkitScript[]): string {
	const registry = scripts
		.map((script) => `${script.name}: ${script.description}${script.danger ? " [DANGEROUS]" : ""}`)
		.join("\n");
	return `Registry:\n${registry}\n\nRequest: ${request.slice(0, 2000)}`;
}

export function parseReflexPlan(text: string): ReflexPlan | undefined {
	const trimmed = text.trim();
	// Strip a leading think block some local models emit even with thinking off.
	const thinkEnd = trimmed.indexOf("</think>");
	const body = thinkEnd >= 0 ? trimmed.slice(thinkEnd + 8) : trimmed;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const parsed = JSON.parse(body.slice(start, end + 1)) as {
			script?: unknown;
			args?: unknown;
			danger?: unknown;
			confidence?: unknown;
		};
		if (typeof parsed.script !== "string" || parsed.script.length === 0) return undefined;
		const confidence =
			typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
				? Math.max(0, Math.min(1, parsed.confidence))
				: 0;
		return {
			script: parsed.script,
			args: Array.isArray(parsed.args) ? parsed.args.filter((arg): arg is string => typeof arg === "string") : [],
			danger: parsed.danger === true,
			confidence,
		};
	} catch {
		return undefined;
	}
}

/**
 * Accept a plan only when it is confident AND names a real registry script ("none" and unknown
 * names are honest refusals). The DANGER flag is never trusted from the plan — the registry's
 * own flag governs confirmation, exactly as for a direct match.
 */
export function acceptReflexPlan(
	plan: ReflexPlan | undefined,
	scripts: readonly ToolkitScript[],
): { script: ToolkitScript; args: string[] } | undefined {
	if (!plan || plan.confidence < REFLEX_MIN_CONFIDENCE) return undefined;
	const script = scripts.find((entry) => entry.name === plan.script);
	if (!script) return undefined;
	return { script, args: plan.args };
}
