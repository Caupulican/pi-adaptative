import { matchToolkitScript, type ToolkitScript } from "../toolkit/script-registry.ts";

/**
 * Executor-lane classifier (G16): decides when a USER turn is a direct toolkit command that a
 * small local executor model can own end-to-end ("restore db staging", "run the status report"),
 * instead of spending the frontier model on a one-tool reflex.
 *
 * Deliberately conservative — ALL of:
 *   - the deterministic Level-0 matcher scores an EXACT/direct hit (the same margin rule that
 *     gates tool-side matching; ambiguity never routes to the executor, it stays with the big
 *     model + reflex brain), and
 *   - the prompt LOOKS like a command: single line, short, no code fences/paths of substance.
 * Everything else falls through to normal routing. The executor model itself is gated by the
 * caller (configured + resolved + tool-call fitness), and failures escalate via the existing
 * cheap-tier escalation path.
 */

const EXECUTOR_MAX_PROMPT_CHARS = 120;

export interface ExecutorRouteVerdict {
	execute: boolean;
	scriptName?: string;
	reason: string;
}

export function classifyExecutorTurn(prompt: string, scripts: readonly ToolkitScript[]): ExecutorRouteVerdict {
	const trimmed = prompt.trim();
	if (scripts.length === 0) return { execute: false, reason: "no_toolkit_scripts" };
	if (trimmed.length === 0 || trimmed.length > EXECUTOR_MAX_PROMPT_CHARS) {
		return { execute: false, reason: "not_command_shaped" };
	}
	if (trimmed.includes("\n") || trimmed.includes("```")) {
		return { execute: false, reason: "not_command_shaped" };
	}
	const match = matchToolkitScript(trimmed, scripts);
	if (match.kind !== "exact") {
		return { execute: false, reason: match.kind === "ambiguous" ? "ambiguous_match" : "no_match" };
	}
	return { execute: true, scriptName: match.script.name, reason: "level0_direct_hit" };
}
