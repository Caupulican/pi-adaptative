/**
 * The input's own hints: what to type, and the few keys that matter every turn. The placeholder is cut from its tail on
 * a narrow terminal, so the key that lists every other key comes first. The words live in the interface text catalogue;
 * this module decides which hint comes where and when it shows at all.
 */

import type { Keybinding } from "@caupulican/pi-tui";
import { interfaceText } from "../../core/language/interface-text.ts";
import { keyText } from "../../presentation/keybinding-hints.ts";

/** The placeholder for the input. A badge means the owner is chatting with a bot rather than the root chat. */
export function composeEditorPlaceholder(botTeamBadge: string | undefined): string {
	const text = interfaceText().frame.placeholder;
	if (botTeamBadge) return text.botTeam(botTeamBadge);
	const withKeys = (binding: Keybinding, phrase: (keys: string) => string): string => {
		const keys = keyText(binding);
		return keys ? phrase(keys) : "";
	};
	return [
		text.askAnything,
		text.shortcuts(keyText("app.shortcuts.show")),
		text.commands,
		text.files,
		text.bash,
		withKeys("app.interrupt", text.interrupt),
		// Windows Terminal swallows alt+enter; the `>>` prefix is the follow-up gesture there.
		process.env.WT_SESSION ? text.followUpWindows : withKeys("app.message.followUp", text.followUp),
		withKeys("app.execution.toggle", text.workArea),
	]
		.filter(Boolean)
		.join(" · ");
}
