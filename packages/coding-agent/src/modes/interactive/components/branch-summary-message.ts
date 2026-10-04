import type { MarkdownTheme } from "@caupulican/pi-tui";
import type { BranchSummaryMessage } from "../../../kernel/index.ts";
import { keyText } from "../../../presentation/keybinding-hints.ts";
import { getMarkdownTheme } from "../../../presentation/theme-model.ts";
import { ExpandableMarkdownMessageComponent } from "./expandable-markdown-message.ts";

/**
 * Component that renders a branch summary message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class BranchSummaryMessageComponent extends ExpandableMarkdownMessageComponent {
	constructor(message: BranchSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(
			{
				label: "branch",
				expandedMarkdown: () => ["**Branch Summary**\n\n", message.summary].join(""),
				collapsedSegments: [
					{ text: "Branch summary (", color: "customMessageText" },
					{ text: keyText("app.tools.expand"), color: "dim" },
					{ text: " to expand)", color: "customMessageText" },
				],
				separateBody: true,
			},
			markdownTheme,
		);
	}
}
