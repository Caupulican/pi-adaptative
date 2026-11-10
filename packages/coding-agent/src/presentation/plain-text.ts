/**
 * The owner's words for what the host records under technical names. A record type (`background_tool_task`) or a
 * model-facing payload is never shown as it is stored: the stored form stays the source for the model and the transcript,
 * and the words the owner reads come from the catalogue at the moment the line is drawn.
 */

import { interfaceText } from "../core/language/interface-text.ts";

/** Words that stay upper case when a stored name is spelled out. */
const ACRONYMS = new Set(["icm", "okf", "usd", "ci", "id", "api", "url", "mcp", "ui", "tui", "cpu", "gpu", "pid"]);

/** A readable name for a record type: a known one by its phrase, any other with the separators turned into spaces. */
export function plainLabel(id: string): string {
	const labels: Readonly<Record<string, string>> = interfaceText().labels.record;
	const known = labels[id];
	if (known) return known;
	const spaced = id
		.replace(/^pi[_-]/, "")
		.replace(/[_-]+/g, " ")
		.trim()
		.split(" ")
		.map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word))
		.join(" ");
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const MODEL_FACING_MARKERS = [
	"[harness]",
	"[team-bot-message]",
	"[bot:",
	"<untrusted_content",
	"REPORT REVIEW",
	'"MUST"',
];

/** Whether a message body is a payload written for the model (a marker, or a whole JSON document), not prose for the owner. */
export function isModelFacingText(text: string): boolean {
	if (MODEL_FACING_MARKERS.some((marker) => text.includes(marker))) return true;
	const trimmed = text.trim();
	if (!/^[[{]/.test(trimmed)) return false;
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

/** The line the owner sees where a model-facing payload would have been. */
export const MODEL_FACING_PLACEHOLDER = "Details for the assistant; they are kept in the transcript.";
