/** A persistent bot's live state as one glyph and the tone it is drawn in; every bot list draws the same one. */
import type { PersistentBotView } from "../../../core/delegation/persistent-bot-team-store.ts";
import type { ThemeColor } from "../../../presentation/theme-model.ts";

export interface BotStateMark {
	readonly glyph: string;
	readonly tone: ThemeColor;
}

/**
 * The plain glyph and its tone, apart: a list that colours its selected row as a whole (the Bot & Team selector)
 * draws the glyph plain, because a toned glyph's foreground reset would cut that row's colour; the others tone it.
 */
export function botStateMark(state: PersistentBotView["state"]): BotStateMark {
	switch (state) {
		case "running":
		case "queued":
			return { glyph: "●", tone: "accent" };
		case "awaiting_parent":
			return { glyph: "◐", tone: "warning" };
		case "failed":
			return { glyph: "✗", tone: "error" };
		case "idle":
		case "retired":
			return { glyph: "○", tone: "muted" };
		default: {
			const _exhaustive: never = state;
			return _exhaustive;
		}
	}
}
