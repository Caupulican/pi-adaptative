import { matchToolkitScript, type ToolkitScript } from "../toolkit/script-registry.ts";

/**
 * Executor-lane classifier (G16): decides when a USER turn is a direct toolkit command the harness
 * runs itself, with no model ("restore-db", a taught alias such as "run the status report"), instead of
 * spending a model on a one-tool reflex.
 *
 * Deliberately conservative — ALL of:
 *   - the deterministic Level-0 matcher finds the script by its exact name or a taught alias (a
 *     scored or ambiguous match never runs here; it stays with the talker and its reflex brain), and
 *   - the prompt LOOKS like a command: single line, short, no code fences/paths of substance.
 * Everything else falls through to normal routing.
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
	// The harness runs the script with no model to read the request, so only the script's own name or a
	// taught alias is a command; a scored match ("is the status report green?") is a reading, and a
	// reading is the talker's to make.
	if (!match.literal) return { execute: false, reason: "scored_match" };
	return { execute: true, scriptName: match.script.name, reason: "level0_direct_hit" };
}
