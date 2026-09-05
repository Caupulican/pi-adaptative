import { type Component, Container, sliceByColumn, truncateToWidth } from "@caupulican/pi-tui";
import { stripAnsi } from "../../../utils/ansi.ts";

interface Anchor {
	component: Component;
	row: number;
}
export interface ConversationPoint {
	row: number;
	column: number;
}
interface CachedRows {
	width: number;
	revision: number;
	lines: string[];
	bytes: number;
}

/** Lazy, identity-anchored viewport. Never renders the transcript merely to count its rows. */
export class ConversationWindow {
	private readonly entries: () => readonly Component[];
	private readonly byteLimit: number;
	private readonly cache = new Map<Component, CachedRows>();
	private anchor?: Anchor;
	private width = 1;
	private height = 1;
	private visible: string[] = [];
	private frozen?: string[];
	private frozenWidth = 1;
	private selection?: { start: ConversationPoint; end: ConversationPoint };
	private tail = true;
	private bytes = 0;

	constructor(entries: () => readonly Component[], byteLimit = 2 * 1024 * 1024) {
		this.entries = entries;
		this.byteLimit = byteLimit;
	}

	get following(): boolean {
		return this.tail;
	}
	get cachedBytes(): number {
		return this.bytes;
	}

	invalidate(component?: Component): void {
		if (component) {
			this.bytes -= this.cache.get(component)?.bytes ?? 0;
			this.cache.delete(component);
		} else {
			this.cache.clear();
			this.bytes = 0;
		}
	}

	reset(): void {
		this.latest();
		this.invalidate();
		this.anchor = undefined;
		this.visible = [];
	}

	latest(): void {
		this.tail = true;
		this.frozen = undefined;
		this.selection = undefined;
	}

	private rows(component: Component): string[] {
		// Container's aggregate revision is discovered during render; only an explicit leaf/override
		// revision can safely skip rendering (streaming assistant supplies that contract).
		const prototype = Object.getPrototypeOf(component);
		const revision =
			component instanceof Container &&
			(prototype === Container.prototype || !Object.hasOwn(prototype, "renderRevision"))
				? undefined
				: component.renderRevision;
		const cached = this.cache.get(component);
		if (cached && revision !== undefined && cached.revision === revision && cached.width === this.width) {
			return cached.lines;
		}
		this.invalidate(component);
		// Image protocol blocks cannot be split into terminal rows. Full transcript owns image display.
		const lines = component
			.render(this.width)
			.map((line) =>
				line.includes("\x1b_G") || line.includes("\x1b]1337;File=") ? "[Image — open transcript to view]" : line,
			);
		const bytes = lines.reduce((sum, line) => sum + line.length * 2, 0);
		if (revision !== undefined && bytes <= this.byteLimit) {
			while (this.bytes + bytes > this.byteLimit) {
				const oldest = this.cache.keys().next().value;
				if (!oldest) break;
				this.invalidate(oldest);
			}
			this.cache.set(component, { width: this.width, revision: component.renderRevision ?? revision, lines, bytes });
			this.bytes += bytes;
		}
		return lines;
	}

	render(width: number, height: number): string[] {
		this.width = Math.max(1, width);
		this.height = Math.max(0, height);
		if (this.frozen) return this.highlight(this.frozen.slice(0, this.height));
		const entries = this.entries();
		// Prune evicted transcript identities; cache capacity is byte-based as well.
		const retained = new Set(entries);
		for (const component of this.cache.keys()) if (!retained.has(component)) this.invalidate(component);
		const lines: string[] = [];
		if (this.tail) {
			for (let index = entries.length - 1; index >= 0 && lines.length < this.height; index--) {
				const component = entries[index]!;
				const rows = this.rows(component);
				for (let row = rows.length - 1; row >= 0 && lines.length < this.height; row--) {
					lines.push(rows[row]!);
					this.anchor = { component, row };
				}
			}
			lines.reverse();
		} else {
			let index = this.anchor ? entries.indexOf(this.anchor.component) : 0;
			let offset = index >= 0 ? (this.anchor?.row ?? 0) : 0;
			index = Math.max(0, index);
			for (; index < entries.length && lines.length < this.height; index++) {
				const component = entries[index]!;
				const rows = this.rows(component);
				offset = Math.min(offset, Math.max(0, rows.length - 1));
				if (lines.length === 0 && rows.length) this.anchor = { component, row: offset };
				for (let row = offset; row < rows.length && lines.length < this.height; row++) lines.push(rows[row]!);
				offset = 0;
			}
		}
		this.visible = lines;
		return lines;
	}

	scroll(delta: number): void {
		this.tail = false;
		this.selection = undefined;
		this.frozen = undefined;
		const entries = this.entries();
		let index = this.anchor ? entries.indexOf(this.anchor.component) : 0;
		index = Math.max(0, index);
		let row = (this.anchor?.row ?? 0) + delta;
		while (row < 0 && index > 0) row += this.rows(entries[--index]!).length;
		while (index < entries.length - 1) {
			const length = this.rows(entries[index]!).length;
			if (row < length) break;
			row -= length;
			index++;
		}
		const component = entries[index];
		if (component) this.anchor = { component, row: Math.max(0, Math.min(row, this.rows(component).length - 1)) };
		if (delta > 0 && this.anchor) {
			let remaining = -this.anchor.row;
			for (let cursor = index; cursor < entries.length && remaining <= this.height; cursor++) {
				remaining += this.rows(entries[cursor]!).length;
			}
			if (remaining <= this.height) this.latest();
		}
	}

	select(point: ConversationPoint, start: boolean): void {
		if (start) {
			this.tail = false;
			this.frozen = [...this.visible];
			this.frozenWidth = this.width;
			this.selection = { start: point, end: point };
		} else if (this.selection) this.selection.end = point;
	}

	private selectedRange(row: number): [number, number] | undefined {
		if (!this.selection) return undefined;
		let { start, end } = this.selection;
		if (start.row > end.row || (start.row === end.row && start.column > end.column)) [start, end] = [end, start];
		if (row < start.row || row > end.row) return undefined;
		return [row === start.row ? start.column : 0, row === end.row ? end.column : this.frozenWidth];
	}

	selectionText(): string | undefined {
		if (!this.selection || !this.frozen) return undefined;
		const lines: string[] = [];
		for (let row = 0; row < this.frozen.length; row++) {
			const range = this.selectedRange(row);
			if (range) lines.push(stripAnsi(sliceByColumn(this.frozen[row]!, range[0], range[1] - range[0])).trimEnd());
		}
		return lines.join("\n") || undefined;
	}

	private highlight(lines: string[]): string[] {
		return lines.map((line, row) => {
			const range = this.selectedRange(row);
			if (!range) return truncateToWidth(line, this.width, "");
			const start = Math.min(this.width, range[0]);
			const end = Math.min(this.width, range[1]);
			const plain = stripAnsi(line);
			return (
				sliceByColumn(plain, 0, start) +
				"\x1b[7m" +
				sliceByColumn(plain, start, end - start) +
				"\x1b[27m" +
				sliceByColumn(plain, end, this.width - end)
			);
		});
	}
}
