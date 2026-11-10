import { interfaceText } from "../../../core/language/interface-text.ts";
import type { Theme } from "../../../presentation/theme-model.ts";

export type ActivityStatusMode = "working" | "thinking" | "workers" | "worker-wait";

/** A small activity pulse, never a percentage or a claim about completion. */
const PULSE_FRAMES = ["·", "•", "●", "•"];
export const ACTIVITY_FRAME_MS = 120;

/**
 * The words for what the harness is doing: one short label per mode. The row says that it is working and for how long; what
 * it is working on is the status bar's business, so the two never repeat each other.
 */
export function activityStatusPhrase(mode: ActivityStatusMode): string {
	const activity = interfaceText().frame.activity;
	switch (mode) {
		case "thinking":
			return activity.thinking;
		case "workers":
			return activity.subagentsWorking;
		case "worker-wait":
			return activity.awaitingSubagents;
		case "working":
			return activity.working;
	}
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
