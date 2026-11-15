/**
 * A persistent bot's live state as one glyph and the tone it is drawn in, and its live watch count in words; every bot
 * list draws the same ones.
 */
import type { PersistentBotView } from "../../../core/delegation/persistent-bot-team-store.ts";
import { interfaceText } from "../../../core/language/interface-text.ts";
import { type ThemeColor, theme } from "../../../presentation/theme-model.ts";

/** The one definition of the remote mark lives in core/remote; the bot views read it from here. */
export { REMOTE_MARK } from "../../../core/remote/remote-jobs.ts";

/** A bot's live watch count as the operator bar draws its own: its label word, then the count ("watching 2"). */
export function botWatchCount(count: number): string {
	return `${interfaceText().frame.operator.watching.toLowerCase()} ${count}`;
}

export interface BotStateMark {
	readonly glyph: string;
	readonly tone: ThemeColor;
}

/** A bot's live state as one toned glyph; the Chats roster and the Team section draw the same one. */
export function botStateGlyph(state: PersistentBotView["state"]): string {
	const { glyph, tone } = botStateMark(state);
	return theme.fg(tone, glyph);
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
		case "offline":
			return { glyph: "◌", tone: "dim" };
		default: {
			const _exhaustive: never = state;
			return _exhaustive;
		}
	}
}
