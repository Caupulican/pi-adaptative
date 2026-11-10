/**
 * The text of the start-up header: the key hints above the product name, folded onto one line or listed in full, and the
 * one line that says what the agent can explain about itself. Each piece is built when the header draws, so the hints
 * follow the interface language and the keybindings of the moment.
 */

import type { AppKeybinding } from "../../../core/keybindings.ts";
import { interfaceText } from "../../../core/language/interface-text.ts";
import { keyHint, keyText, rawKeyHint } from "../../../presentation/keybinding-hints.ts";
import { theme } from "../../../presentation/theme-model.ts";

const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

/** Every gesture the start lists, one per line. */
export function expandedStartupHints(): string {
	const words = interfaceText().interactive.startup;
	return [
		hint("app.interrupt", words.toInterrupt),
		hint("app.clear", words.toClear),
		rawKeyHint(`${keyText("app.clear")} twice`, words.toExit),
		hint("app.exit", words.toExitEmpty),
		hint("app.suspend", words.toSuspend),
		keyHint("tui.editor.deleteToLineEnd", words.toDeleteToEnd),
		hint("app.thinking.cycle", words.toCycleThinking),
		rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, words.toCycleModels),
		hint("app.model.select", words.toSelectModel),
		hint("app.tools.expand", words.toExpandTools),
		hint("app.history.load", words.toLoadHistory),
		hint("app.agents.open", words.toInspectAgents),
		hint("app.transcript.open", words.toViewTranscript),
		hint("app.thinking.toggle", words.toExpandThinking),
		hint("app.editor.external", words.forExternalEditor),
		rawKeyHint("/", words.forCommands),
		rawKeyHint("!", words.toRunBash),
		rawKeyHint("!!", words.toRunBashNoContext),
		hint("app.message.followUp", words.toQueueFollowUp),
		rawKeyHint(">>", words.prefixFollowUp),
		hint("app.message.dequeue", words.toEditQueued),
		rawKeyHint("↑", words.toRecallQueued),
		hint("app.clipboard.pasteImage", words.toPasteImage),
		rawKeyHint(words.dropFiles, words.toAttach),
	].join("\n");
}

/** The five gestures the folded start keeps, on one line. */
export function compactStartupHints(): string {
	const words = interfaceText().interactive.startup;
	return [
		hint("app.interrupt", words.compact.interrupt),
		rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, words.compact.clearExit),
		rawKeyHint("/", words.compact.commands),
		rawKeyHint("!", words.compact.bash),
		hint("app.tools.expand", words.compact.expandTools),
	].join(theme.fg("muted", " · "));
}

/** The line that points at the full list and at the session history. */
export function startupHelpLine(): string {
	return theme.fg(
		"dim",
		interfaceText().interactive.startup.fullHelp(keyText("app.tools.expand"), keyText("app.history.load")),
	);
}

/** The line that says the agent explains its own features and looks its docs up. */
export function startupOnboarding(): string {
	return theme.fg("dim", interfaceText().interactive.startup.onboarding);
}
