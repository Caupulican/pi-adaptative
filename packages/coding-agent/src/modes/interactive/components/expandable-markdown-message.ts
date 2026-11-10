import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@caupulican/pi-tui";
import { theme } from "../../../presentation/theme-model.ts";
import { renderTitleBadge, type TitleBadgeSegment } from "../../../presentation/tool-title.ts";

export interface ExpandableMarkdownMessageOptions {
	label: string;
	expandedMarkdown: () => string;
	collapsedSegments?: TitleBadgeSegment[];
	collapsedDetails?: TitleBadgeSegment[];
	separateBody: boolean;
}

/** How a notice draws: its badge label, its expanded body and its collapsed line, read again at every draw. */
export type ExpandableMarkdownMessageSource = () => ExpandableMarkdownMessageOptions;

/** Shared expansion, invalidation, and themed rendering lifecycle for transcript markdown notices. */
export class ExpandableMarkdownMessageComponent extends Box {
	private expanded = false;
	private expandedMarkdown: string | undefined;
	private readonly markdownTheme: MarkdownTheme;
	private readonly options: ExpandableMarkdownMessageSource;

	constructor(options: ExpandableMarkdownMessageSource, markdownTheme: MarkdownTheme) {
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
		const options = this.options();
		this.clear();

		if (!this.expanded && options.collapsedDetails !== undefined) {
			this.addChild(
				new Text(renderTitleBadge(theme, { label: options.label, details: options.collapsedDetails }), 0, 0),
			);
			return;
		}

		this.addChild(new Text(renderTitleBadge(theme, { label: options.label }), 0, 0));
		if (options.separateBody) this.addChild(new Spacer(1));

		if (this.expanded) {
			this.expandedMarkdown ??= options.expandedMarkdown();
			this.addChild(
				new Markdown(this.expandedMarkdown, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
			return;
		}

		if (options.collapsedSegments !== undefined) {
			const text = options.collapsedSegments
				.map((segment) => {
					const raw = String(segment.text ?? "");
					return segment.color === undefined ? raw : theme.fg(segment.color, raw);
				})
				.join("");
			this.addChild(new Text(text, 0, 0));
		}
	}
}
