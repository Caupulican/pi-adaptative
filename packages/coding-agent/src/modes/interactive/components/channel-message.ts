import { Box, Container, Markdown, type MarkdownTheme, Text } from "@caupulican/pi-tui";
import { interfaceText } from "../../../core/language/interface-text.ts";
import { plainLabel } from "../../../presentation/plain-text.ts";
import { theme } from "../../../presentation/theme-model.ts";
import { REMOTE_MARK } from "./bot-state-mark.ts";

/**
 * A third party's words that opened a turn (a message from another machine, a chat, a mail), as the owner reads them: where
 * they came from, then the words. The framing written for the model is never shown.
 */
export class ChannelMessageComponent extends Container {
	constructor(channel: string, words: string, markdownTheme: MarkdownTheme) {
		super();
		const box = new Box(1, 1, (content: string) => theme.bg("customMessageBg", content));
		const text = interfaceText().conversation;
		const source = channel === "link" ? text.fromAnotherMachine(REMOTE_MARK) : text.onChannel(plainLabel(channel));
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(source)), 0, 0));
		box.addChild(
			new Markdown(words, 0, 0, markdownTheme, {
				color: (content: string) => theme.fg("customMessageText", content),
			}),
		);
		this.addChild(box);
	}
}
