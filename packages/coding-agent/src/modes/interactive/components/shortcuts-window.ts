import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import { theme } from "../../../presentation/theme-model.ts";

export interface ShortcutRow {
	/** The key as the operator types it, already in display form. */
	readonly keys: string;
	readonly action: string;
}

export interface ShortcutSection {
	readonly title: string;
	readonly rows: readonly ShortcutRow[];
}

export interface ShortcutsWindowOptions {
	sections: readonly ShortcutSection[];
	/** Terminal rows; the window takes at most four fifths of them. */
	viewportRows: () => number;
	/** The key that opened the window also closes it: how to name it, and whether an input is it. */
	closeLabel: string;
	isCloseKey: (data: string) => boolean;
	requestRender: () => void;
	onClose: () => void;
}

const KEY_COLUMN_MAX = 30;

/**
 * A floating window of every shortcut: a rounded frame with its title in the top edge and its scroll position
 * and close key in the bottom edge, on a raised surface over whatever is behind it. It draws its own rows from
 * the sections it was given and owns only its scroll offset.
 */
export class ShortcutsWindow implements Component {
	private readonly options: ShortcutsWindowOptions;
	private offset = 0;
	private bodyRows = 1;
	private totalRows = 0;

	constructor(options: ShortcutsWindowOptions) {
		this.options = options;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const keys = getKeybindings();
		const maxOffset = Math.max(0, this.totalRows - this.bodyRows);
		const scroll = (delta: number) => {
			this.offset = Math.max(0, Math.min(maxOffset, this.offset + delta));
			this.options.requestRender();
		};
		if (keys.matches(data, "tui.select.up")) scroll(-1);
		else if (keys.matches(data, "tui.select.down")) scroll(1);
		else if (keys.matches(data, "tui.select.pageUp")) scroll(-this.bodyRows);
		else if (keys.matches(data, "tui.select.pageDown")) scroll(this.bodyRows);
		else if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.select.confirm"))
			this.options.onClose();
		else if (this.options.isCloseKey(data)) this.options.onClose();
	}

	private contentRows(inner: number): string[] {
		const keyColumn = Math.min(
			KEY_COLUMN_MAX,
			Math.max(...this.options.sections.flatMap((section) => section.rows.map((row) => visibleWidth(row.keys))), 4),
		);
		const rows: string[] = [];
		for (const section of this.options.sections) {
			if (!section.rows.length) continue;
			if (rows.length) rows.push("");
			rows.push(theme.bold(theme.fg("text", section.title)));
			for (const row of section.rows) {
				const keys = truncateToWidth(row.keys, keyColumn, "…", true);
				rows.push(`${theme.fg("accent", keys)}  ${theme.fg("muted", row.action)}`);
			}
		}
		return rows.map((row) => truncateToWidth(row, inner, "…"));
	}

	render(width: number): string[] {
		const surface = (text: string) => theme.bg("customMessageBg", text);
		const border = (text: string) => surface(theme.fg("borderMuted", text));
		const inner = Math.max(1, width - 4);
		const content = this.contentRows(inner);
		this.totalRows = content.length;
		const budget = Math.max(6, Math.floor(this.options.viewportRows() * 0.8));
		this.bodyRows = Math.max(3, Math.min(content.length, budget - 2));
		this.offset = Math.min(this.offset, Math.max(0, content.length - this.bodyRows));

		const title = ` ${theme.bold(theme.fg("text", "Shortcuts"))} `;
		const titleWidth = visibleWidth(" Shortcuts ");
		const top = `${border("╭─")}${surface(title)}${border(`${"─".repeat(Math.max(0, width - 3 - titleWidth))}╮`)}`;

		const more = content.length > this.bodyRows;
		const position = more ? `${this.offset + 1}-${this.offset + this.bodyRows}/${content.length} · ↑↓ · ` : "";
		const footer = ` ${position}${this.options.closeLabel} close `;
		const footerWidth = visibleWidth(footer);
		const bottom = `${border(`╰${"─".repeat(Math.max(0, width - 3 - footerWidth))}`)}${surface(theme.fg("dim", footer))}${border("─╯")}`;

		const body = content.slice(this.offset, this.offset + this.bodyRows).map((row) => {
			const pad = " ".repeat(Math.max(0, inner - visibleWidth(row)));
			return `${border("│")}${surface(` ${row}${pad} `)}${border("│")}`;
		});
		return [top, ...body, bottom];
	}
}
