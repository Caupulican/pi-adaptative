import type { MarkdownTheme } from "@caupulican/pi-tui";
import { interfaceText } from "../../../core/language/interface-text.ts";
import type { BranchSummaryMessage } from "../../../kernel/index.ts";
import { keyText } from "../../../presentation/keybinding-hints.ts";
import { getMarkdownTheme } from "../../../presentation/theme-model.ts";
import { ExpandableMarkdownMessageComponent } from "./expandable-markdown-message.ts";

/**
 * Component that renders a branch summary message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class BranchSummaryMessageComponent extends ExpandableMarkdownMessageComponent {
	override get renderRevision(): number {
		return this.revision;
	}

	constructor(message: BranchSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(() => {
			const text = interfaceText().conversation;
			return {
				label: text.branchLabel,
				expandedMarkdown: () => [`**${text.branchSummaryTitle}**\n\n`, message.summary].join(""),
				collapsedSegments: [
					{ text: text.branchSummaryOpen, color: "customMessageText" },
					{ text: keyText("app.tools.expand"), color: "dim" },
					{ text: text.toExpandParen, color: "customMessageText" },
				],
				separateBody: true,
			};
		}, markdownTheme);
	}
}
