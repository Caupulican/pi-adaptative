import type { MarkdownTheme } from "@caupulican/pi-tui";
import type { CompactionSummaryMessage } from "../../../kernel/index.ts";
import { keyText } from "../../../presentation/keybinding-hints.ts";
import { getMarkdownTheme } from "../../../presentation/theme-model.ts";
import { ExpandableMarkdownMessageComponent } from "./expandable-markdown-message.ts";

/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class CompactionSummaryMessageComponent extends ExpandableMarkdownMessageComponent {
	constructor(message: CompactionSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		const tokenStr = message.tokensBefore.toLocaleString();
		super(
			{
				label: "compaction",
				expandedMarkdown: () => [`**Compacted from ${tokenStr} tokens**\n\n`, message.summary].join(""),
				collapsedSegments: [
					{ text: `Compacted from ${tokenStr} tokens (`, color: "customMessageText" },
					{ text: keyText("app.tools.expand"), color: "dim" },
					{ text: " to expand)", color: "customMessageText" },
				],
				separateBody: true,
			},
			markdownTheme,
		);
	}
}
