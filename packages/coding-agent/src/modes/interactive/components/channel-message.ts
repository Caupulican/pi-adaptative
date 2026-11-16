import { Box, Container, Markdown, type MarkdownTheme, Text } from "@caupulican/pi-tui";
import { parseBotMailAddress } from "../../../core/bots/bot-mail.ts";
import { interfaceText } from "../../../core/language/interface-text.ts";
import { plainLabel } from "../../../presentation/plain-text.ts";
import { theme } from "../../../presentation/theme-model.ts";
import { REMOTE_MARK } from "./bot-state-mark.ts";

/**
 * A third party's words that opened a turn (a message from another machine, a chat, a mail), as the owner reads them: where
 * they came from (an agent's mail by its sender, and the group it was written in), then the words. The framing written
 * for the model is never shown.
 */
export class ChannelMessageComponent extends Container {
	private revision = 0;

	/** `from`: the sender a mail's origin records (`TurnOriginRecord.from`); absent for any other channel's words. */
	constructor(channel: string, words: string, markdownTheme: MarkdownTheme, from?: string) {
		super();
		const box = new Box(1, 1, (content: string) => theme.bg("customMessageBg", content));
		const text = interfaceText().conversation;
		const mail = from === undefined ? undefined : parseBotMailAddress(from);
		const source = mail
			? mail.kind === "bot"
				? text.mailReceived(plainLabel(mail.agentId))
				: mail.kind === "group"
					? text.mailReceived(text.you, plainLabel(mail.teamId))
					: mail.kind === "worker"
						? text.mailReceived(text.orchestratorWorker(plainLabel(mail.runtime)))
						: text.mailReceived(text.orchestrator)
			: channel === "link"
				? text.fromAnotherMachine(REMOTE_MARK)
				: text.onChannel(plainLabel(channel));
		box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(source)), 0, 0));
		box.addChild(
			new Markdown(words, 0, 0, markdownTheme, {
				color: (content: string) => theme.fg("customMessageText", content),
			}),
		);
		this.addChild(box);
	}

	get renderRevision(): number {
		return this.revision;
	}

	override invalidate(): void {
		super.invalidate();
		this.revision++;
	}
}
