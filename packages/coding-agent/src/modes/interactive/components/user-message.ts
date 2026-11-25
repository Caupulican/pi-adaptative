import {
	Box,
	Container,
	collectTerminalRows,
	componentTerminalRows,
	joinTerminalRows,
	Markdown,
	type MarkdownTheme,
	type TerminalRows,
} from "@caupulican/pi-tui";
import { getMarkdownTheme, theme } from "../../../presentation/theme-model.ts";
import { applyMarkdownTransform, type MarkdownTransformFn, type MarkdownTransformSlot } from "./markdown-transform.ts";
import { markPromptZone } from "./prompt-zone-rows.ts";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private contentBox: Box;
	private transformMarkdown?: MarkdownTransformFn;
	private markdownSlot: MarkdownTransformSlot;
	private revision = 0;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		transformMarkdown?: MarkdownTransformFn,
	) {
		super();
		this.transformMarkdown = transformMarkdown;
		this.contentBox = new Box(1, 1, (content: string) => theme.bg("userMessageBg", content));
		const markdown = new Markdown(
			text,
			0,
			0,
			markdownTheme,
			{
				color: (content: string) => theme.fg("userMessageText", content),
			},
			{ preserveOrderedListMarkers: true },
		);
		this.markdownSlot = { component: markdown, rawText: text, messageType: "user" };
		this.contentBox.addChild(markdown);
		this.addChild(this.contentBox);
	}

	get renderRevision(): number {
		return this.revision;
	}

	override invalidate(): void {
		super.invalidate();
		this.revision++;
	}

	override render(width: number): string[] {
		return collectTerminalRows(this.renderRows(width));
	}

	renderRows(width: number): TerminalRows {
		if (this.transformMarkdown) {
			applyMarkdownTransform(this.markdownSlot, this.transformMarkdown, false, width);
		}
		return markPromptZone(joinTerminalRows(this.children.map((child) => componentTerminalRows(child, width))));
	}
}
