import type { MarkdownTheme } from "@caupulican/pi-tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import { getMarkdownTheme } from "../theme/theme.ts";
import { ExpandableMarkdownMessageComponent } from "./expandable-markdown-message.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a skill invocation message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 * Only renders the skill block itself - user message is rendered separately.
 */
export class SkillInvocationMessageComponent extends ExpandableMarkdownMessageComponent {
	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(
			{
				label: "skill",
				expandedMarkdown: () => [`**${skillBlock.name}**\n\n`, skillBlock.content].join(""),
				collapsedDetails: [
					{ text: skillBlock.name, color: "customMessageText" },
					{ text: `(${keyText("app.tools.expand")} to expand)`, color: "dim" },
				],
				separateBody: false,
			},
			markdownTheme,
		);
	}
}
