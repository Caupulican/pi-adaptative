import { type Component, Container, truncateToWidth } from "@caupulican/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { interfaceText } from "../../../core/language/interface-text.ts";
import { formatKeyText } from "../../../presentation/keybinding-hints.ts";
import { theme } from "../../../presentation/theme-model.ts";

export interface TranscriptPagerOptions {
	source: Component;
	viewportRows: () => number;
	keybindings: KeybindingsManager;
	onClose: () => void;
}

/** A container's own aggregate revision moves during render, so only an explicit override can key a cache. */
function revisionOf(component: Component): number | undefined {
	if (!(component instanceof Container)) return component.renderRevision;
	const prototype = Object.getPrototypeOf(component);
	if (prototype === Container.prototype || !Object.hasOwn(prototype, "renderRevision")) return undefined;
	return component.renderRevision;
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
	private width = 1;
	/** Where a non-tail viewport starts: a child identity plus a row inside it, so a prepended prefix never moves it. */
	private anchor?: { child: Component; row: number };
	private readonly childCache = new Map<Component, { width: number; revision: number | undefined; lines: string[] }>();

	constructor(options: TranscriptPagerOptions) {
		this.source = options.source;
		this.viewportRows = options.viewportRows;
		this.keybindings = options.keybindings;
		this.onClose = options.onClose;
	}

	render(width: number): string[] {
		this.width = Math.max(1, width);
		const rows = Math.max(3, this.viewportRows());
		const contentRows = rows - 2;
		const sourceLines = this.getLines(width);
		const maxScroll = Math.max(0, sourceLines.length - contentRows);
		this.lastPageRows = contentRows;
		this.lastMaxScroll = maxScroll;
		// A scrolled-away viewport holds the row it was reading, not the line number: history prepended
		// above the view must not shift what the operator is looking at.
		if (!this.followTail && this.anchor) {
			const start = this.offsetOf(this.anchor.child, width);
			if (start >= 0) this.scrollTop = Math.max(0, Math.min(maxScroll, start + this.anchor.row));
		}
		this.scrollTop = this.followTail ? maxScroll : Math.min(this.scrollTop, maxScroll);

		const text = interfaceText().conversation;
		const status = this.followTail
			? text.liveTail
			: `${Math.round((this.scrollTop / Math.max(1, maxScroll)) * 100)}%`;
		const header = this.surfaceLine(
			`${theme.bold(theme.fg("text", ` ${text.transcriptTitle}`))}${theme.fg("muted", `  ${status}`)}`,
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
		const footerText = text.pagerFooter(
			`${key("app.transcript.scrollUp")}/${key("app.transcript.scrollDown")}`,
			`${key("app.transcript.pageUp")}/${key("app.transcript.pageDown")}`,
			`${key("app.transcript.top")}/${key("app.transcript.bottom")}`,
			key("app.transcript.close"),
		);
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
			this.captureAnchor(this.width);
			return;
		}
		if (this.keybindings.matches(data, "app.transcript.bottom")) {
			this.followTail = true;
			this.anchor = undefined;
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

	invalidate(): void {
		this.childCache.clear();
	}

	private getLines(width: number): string[] {
		if (this.source instanceof Container) {
			const children = this.source.children;
			const lines: string[] = [];
			for (const child of children) {
				const rev = revisionOf(child);
				const cached = this.childCache.get(child);
				let childLines: string[];
				if (cached && rev !== undefined && cached.width === width && cached.revision === rev) {
					childLines = cached.lines;
				} else {
					childLines = child.render(width);
					if (rev !== undefined) this.childCache.set(child, { width, revision: rev, lines: childLines });
				}
				for (const line of childLines) lines.push(line);
			}
			if (this.childCache.size > children.length * 2) {
				const current = new Set(children);
				for (const key of this.childCache.keys()) {
					if (!current.has(key)) this.childCache.delete(key);
				}
			}
			return lines;
		}
		return this.source.render(width);
	}

	/** Line offset of a child in the current layout, or -1 when it is no longer part of the source. */
	private offsetOf(child: Component, width: number): number {
		if (!(this.source instanceof Container)) return -1;
		let offset = 0;
		for (const candidate of this.source.children) {
			if (candidate === child) return offset;
			offset += this.cachedRows(candidate, width);
		}
		return -1;
	}

	private cachedRows(child: Component, width: number): number {
		const cached = this.childCache.get(child);
		return cached && cached.width === width ? cached.lines.length : 0;
	}

	/** Remembers the row being read whenever the viewport leaves the tail. */
	private captureAnchor(width: number): void {
		if (!(this.source instanceof Container)) return;
		let offset = 0;
		for (const child of this.source.children) {
			const rows = this.cachedRows(child, width);
			if (rows > 0 && this.scrollTop < offset + rows) {
				this.anchor = { child, row: this.scrollTop - offset };
				return;
			}
			offset += rows;
		}
		this.anchor = undefined;
	}

	private scrollBy(delta: number): void {
		if (delta < 0 && this.followTail) {
			this.scrollTop = this.lastMaxScroll;
			this.followTail = false;
		}
		this.scrollTop = Math.max(0, Math.min(this.lastMaxScroll, this.scrollTop + delta));
		if (delta > 0 && this.scrollTop === this.lastMaxScroll) this.followTail = true;
		if (this.followTail) this.anchor = undefined;
		else this.captureAnchor(this.width);
	}

	private surfaceLine(text: string, width: number): string {
		return theme.bg("customMessageBg", truncateToWidth(text, width, "", true));
	}
}
