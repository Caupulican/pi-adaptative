import { visibleWidth } from "@caupulican/pi-tui";
import type { Theme } from "../../../presentation/theme-model.ts";

export type ActivityStatusMode = "working" | "thinking" | "workers" | "worker-wait";

/** A small activity pulse, never a percentage or a claim about completion. */
const PULSE_FRAMES = ["·", "•", "●", "•"];
export const ACTIVITY_FRAME_MS = 120;
const PHRASE_HOLD_MS = 6_000;
const PHRASES: Record<ActivityStatusMode, readonly string[]> = {
	working: ["Working on your request", "Work is underway", "Continuing the task", "Working through the details"],
	thinking: [
		"Thinking it through",
		"Considering the details",
		"Reasoning through the task",
		"Thinking about the next step",
	],
	workers: [
		"Subagents are working",
		"Work continues in parallel",
		"Delegated work is underway",
		"Subagents are on the task",
	],
	"worker-wait": [
		"Waiting on subagents",
		"Awaiting subagent results",
		"Waiting for their handoff",
		"Subagent work is pending",
	],
};
const SHORT_PHRASES: Record<ActivityStatusMode, readonly string[]> = {
	working: ["Working on it", "Work is underway", "Continuing work", "Working through it"],
	thinking: ["Thinking it through", "Considering it", "Reasoning it out", "Thinking ahead"],
	workers: ["Subagents working", "Work in parallel", "Delegated work", "Subagents at work"],
	"worker-wait": ["Awaiting subagents", "Awaiting results", "Awaiting handoff", "Subagents pending"],
};
const COMPACT_LABELS: Record<ActivityStatusMode, string> = {
	working: "Working",
	thinking: "Thinking",
	workers: "Subagents working",
	"worker-wait": "Awaiting subagents",
};

/** Presentation only: no timer, no mutation of the activity or its original label. */
export function activityStatusPhrase(
	mode: ActivityStatusMode,
	elapsedMs: number,
	width: number,
	animate: boolean,
): string {
	const phrases = PHRASES[mode];
	const index = animate ? Math.floor(Math.max(0, elapsedMs) / PHRASE_HOLD_MS) % phrases.length : 0;
	const phrase = phrases[index];
	if (visibleWidth(phrase) <= width) return phrase;
	const shortPhrase = SHORT_PHRASES[mode][index];
	return visibleWidth(shortPhrase) <= width ? shortPhrase : COMPACT_LABELS[mode];
}

export function activityStatusPulse(elapsedMs: number, animate: boolean): string {
	return animate
		? PULSE_FRAMES[Math.floor(Math.max(0, elapsedMs) / (ACTIVITY_FRAME_MS * 2)) % PULSE_FRAMES.length]
		: "●";
}

/** A narrow accent glides across built-in ASCII copy; clocks and custom text stay still. */
export function renderActivityStatusText(theme: Theme, text: string, elapsedMs: number, animate: boolean): string {
	if (!animate) return theme.fg("muted", text);
	const position = Math.floor(Math.max(0, elapsedMs) / ACTIVITY_FRAME_MS) % (text.length + 24);
	if (position >= text.length) return theme.fg("muted", text);
	return (
		theme.fg("muted", text.slice(0, position)) +
		theme.fg("accent", text.slice(position, position + 2)) +
		theme.fg("muted", text.slice(position + 2))
	);
}
