import { type Component, truncateToWidth } from "@caupulican/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { theme } from "../theme/theme.ts";
import { formatKeyText } from "./keybinding-hints.ts";

export interface TranscriptPagerOptions {
	source: Component;
	viewportRows: () => number;
	keybindings: KeybindingsManager;
	onClose: () => void;
}

/** A live transcript viewport that stops following output as soon as the user scrolls away. */
export class TranscriptPager implements Component {
	private readonly source: Component;
	private readonly viewportRows: () => number;
	private readonly keybindings: KeybindingsManager;
	private readonly onClose: () => void;
	private scrollTop = 0;
	private followTail = true;
	private lastPageRows = 1;
	private lastMaxScroll = 0;

	constructor(options: TranscriptPagerOptions) {
		this.source = options.source;
		this.viewportRows = options.viewportRows;
		this.keybindings = options.keybindings;
		this.onClose = options.onClose;
	}

	render(width: number): string[] {
		const rows = Math.max(3, this.viewportRows());
		const contentRows = rows - 2;
		const sourceLines = this.source.render(width);
		const maxScroll = Math.max(0, sourceLines.length - contentRows);
		this.lastPageRows = contentRows;
		this.lastMaxScroll = maxScroll;
		this.scrollTop = this.followTail ? maxScroll : Math.min(this.scrollTop, maxScroll);

		const status = this.followTail ? "live tail" : `${Math.round((this.scrollTop / Math.max(1, maxScroll)) * 100)}%`;
		const header = this.surfaceLine(
			`${theme.bold(theme.fg("text", " Transcript"))}${theme.fg("muted", `  ${status}`)}`,
			width,
		);
		const content = sourceLines
			.slice(this.scrollTop, this.scrollTop + contentRows)
			.map((line) => truncateToWidth(line, width, "", true));
		while (content.length < contentRows) {
			content.push(theme.fg("dim", truncateToWidth("~", width, "", true)));
		}

		const key = (action: Parameters<KeybindingsManager["getKeys"]>[0]) =>
			formatKeyText(this.keybindings.getKeys(action).join("/"), { capitalize: true });
		const footerText = ` ${key("app.transcript.scrollUp")}/${key("app.transcript.scrollDown")} scroll  ·  ${key("app.transcript.pageUp")}/${key("app.transcript.pageDown")} page  ·  ${key("app.transcript.top")}/${key("app.transcript.bottom")} jump  ·  ${key("app.transcript.close")} close`;
		return [header, ...content, this.surfaceLine(theme.fg("muted", footerText), width)];
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "app.transcript.close")) {
			this.onClose();
			return;
		}
		if (this.keybindings.matches(data, "app.transcript.top")) {
			this.followTail = false;
			this.scrollTop = 0;
			return;
		}
		if (this.keybindings.matches(data, "app.transcript.bottom")) {
			this.followTail = true;
			this.scrollTop = this.lastMaxScroll;
			return;
		}
		if (this.keybindings.matches(data, "app.transcript.scrollUp")) {
			this.scrollBy(-1);
			return;
		}
		if (this.keybindings.matches(data, "app.transcript.scrollDown")) {
			this.scrollBy(1);
			return;
		}
		if (this.keybindings.matches(data, "app.transcript.pageUp")) {
			this.scrollBy(-this.lastPageRows);
			return;
		}
		if (this.keybindings.matches(data, "app.transcript.pageDown")) {
			this.scrollBy(this.lastPageRows);
		}
	}

	invalidate(): void {}

	private scrollBy(delta: number): void {
		if (delta < 0 && this.followTail) {
			this.scrollTop = this.lastMaxScroll;
			this.followTail = false;
		}
		this.scrollTop = Math.max(0, Math.min(this.lastMaxScroll, this.scrollTop + delta));
		if (delta > 0 && this.scrollTop === this.lastMaxScroll) this.followTail = true;
	}

	private surfaceLine(text: string, width: number): string {
		return theme.bg("customMessageBg", truncateToWidth(text, width, "", true));
	}
}
