import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@caupulican/pi-tui";
import { theme } from "../theme/theme.ts";
import { renderTitleBadge, type TitleBadgeSegment } from "./tool-title.ts";

export interface ExpandableMarkdownMessageOptions {
	label: string;
	expandedMarkdown: () => string;
	collapsedSegments?: TitleBadgeSegment[];
	collapsedDetails?: TitleBadgeSegment[];
	separateBody: boolean;
}

/** Shared expansion, invalidation, and themed rendering lifecycle for transcript markdown notices. */
export class ExpandableMarkdownMessageComponent extends Box {
	private expanded = false;
	private expandedMarkdown: string | undefined;
	private readonly markdownTheme: MarkdownTheme;
	private readonly options: ExpandableMarkdownMessageOptions;

	constructor(options: ExpandableMarkdownMessageOptions, markdownTheme: MarkdownTheme) {
		super(1, 1, (text) => theme.bg("customMessageBg", text));
		this.options = options;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		if (!this.expanded && this.options.collapsedDetails !== undefined) {
			this.addChild(
				new Text(
					renderTitleBadge(theme, { label: this.options.label, details: this.options.collapsedDetails }),
					0,
					0,
				),
			);
			return;
		}

		this.addChild(new Text(renderTitleBadge(theme, { label: this.options.label }), 0, 0));
		if (this.options.separateBody) this.addChild(new Spacer(1));

		if (this.expanded) {
			this.expandedMarkdown ??= this.options.expandedMarkdown();
			this.addChild(
				new Markdown(this.expandedMarkdown, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
			return;
		}

		if (this.options.collapsedSegments !== undefined) {
			const text = this.options.collapsedSegments
				.map((segment) => {
					const raw = String(segment.text ?? "");
					return segment.color === undefined ? raw : theme.fg(segment.color, raw);
				})
				.join("");
			this.addChild(new Text(text, 0, 0));
		}
	}
}
