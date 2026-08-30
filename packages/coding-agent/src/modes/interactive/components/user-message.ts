import { Box, Container, Markdown, type MarkdownTheme } from "@caupulican/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { applyMarkdownTransform, type MarkdownTransformFn, type MarkdownTransformSlot } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private contentBox: Box;
	private transformMarkdown?: MarkdownTransformFn;
	private markdownSlot: MarkdownTransformSlot;

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

	override render(width: number): string[] {
		if (this.transformMarkdown) {
			applyMarkdownTransform(this.markdownSlot, this.transformMarkdown, false, width);
		}

		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
