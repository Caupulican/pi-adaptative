import {
	Box,
	borrowComponentRows,
	type Component,
	Container,
	isImageLine,
	sliceByColumn,
	styleColumnRange,
	type TerminalRows,
	truncateToWidth,
} from "@caupulican/pi-tui";
import { interfaceText } from "../../../core/language/interface-text.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { getActionTranscriptEpoch } from "../action-transcript-epoch.ts";
import { ActionTranscriptComponent } from "./action-transcript.ts";
import { BashExecutionComponent } from "./bash-execution.ts";

/** OSC 133 prompt-zone marks emitted by the inline transcript components. */
const PROMPT_ZONE_MARK = /\x1b\]133;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const MAX_CACHED_ROWS = 2048;

function rowRevision(component: Component): number | undefined {
	const prototype = Object.getPrototypeOf(component);
	return (component instanceof Container || component instanceof Box) &&
		(prototype === Container.prototype || prototype === Box.prototype || !Object.hasOwn(prototype, "renderRevision"))
		? undefined
		: component.renderRevision;
}

function conversationRow(line: string): string {
	const row = line.includes("\x1b]133;") ? line.replace(PROMPT_ZONE_MARK, "") : line;
	return isImageLine(row) ? interfaceText().conversation.imagePlaceholder : row;
}

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

export interface ConversationWindowSnapshot {
	readonly container?: Container;
	readonly entries: readonly Component[];
	readonly indexMap: Map<Component, number>;
	readonly rootOwners?: ReadonlyMap<Component, Component>;
	readonly revision: number;
}

export type ConversationWindowSource = () => readonly Component[] | ConversationWindowSnapshot;

export interface ConversationSnapshotBuilderOptions {
	getRoot: () => Container;
	getActive: () => Container;
	getHeader?: () => Component | undefined;
	getRootSegments?: () => readonly Container[];
}

export class ConversationSnapshotBuilder {
	private readonly options: ConversationSnapshotBuilderOptions;
	private lastActive?: Container;
	private lastContainerRevision?: number;
	private lastHeaderRevision = -1;
	private lastSegments?: readonly Container[];
	private lastEpoch?: number;
	/** Counts rebuilds, not reads: a removed child must still move the revision even when the epoch holds. */
	private snapshotRevision = 0;
	private memoized?: ConversationWindowSnapshot;

	constructor(options: ConversationSnapshotBuilderOptions) {
		this.options = options;
	}

	getSnapshot(): ConversationWindowSnapshot {
		const root = this.options.getRoot();
		const active = this.options.getActive();
		const header = active === root ? this.options.getHeader?.() : undefined;
		const segments = active === root ? this.options.getRootSegments?.() : undefined;
		const containerRevision = active.renderRevision;
		const headerRevision = header?.renderRevision ?? -1;
		const epoch = getActionTranscriptEpoch();

		// O(1) on a keystroke: the four things that can change a transcript without re-walking children.
		if (
			this.memoized &&
			this.lastActive === active &&
			this.lastSegments === segments &&
			this.lastContainerRevision === containerRevision &&
			this.lastHeaderRevision === headerRevision &&
			this.lastEpoch === epoch
		) {
			return this.memoized;
		}

		const entries: Component[] = [];
		const rootOwners = new Map<Component, Component>();
		if (header) entries.push(header);
		for (const segment of segments ?? [active]) {
			for (const child of segment.children) {
				if (child instanceof ActionTranscriptComponent) {
					for (const conversation of child.conversationComponents()) {
						entries.push(conversation);
						rootOwners.set(conversation, child);
					}
				} else if (!(child instanceof BashExecutionComponent)) {
					entries.push(child);
				}
			}
		}

		const indexMap = new Map<Component, number>();
		for (let index = 0; index < entries.length; index++) indexMap.set(entries[index], index);

		this.lastActive = active;
		this.lastSegments = segments;
		this.lastContainerRevision = containerRevision;
		this.lastHeaderRevision = headerRevision;
		this.lastEpoch = epoch;
		this.memoized = { container: active, entries, indexMap, rootOwners, revision: ++this.snapshotRevision };
		return this.memoized;
	}
}

export interface ConversationHistoryNavigation {
	move(direction: -1 | 1, residual: number): boolean;
	follow(): void;
	scrolling(delta: number): void;
	cancel(): void;
	prepareOlder(): void;
}

export interface RootConversationHistoryNavigation extends ConversationHistoryNavigation {
	segments(): readonly Container[];
	showHeader(): boolean;
}

export function createRootConversationWindow(
	{
		conversation,
		activeConversation,
		header,
		history,
	}: {
		conversation: Container;
		activeConversation?: () => Container;
		header?: Component;
		history?: RootConversationHistoryNavigation;
	},
	selectionStyle: () => string,
): ConversationWindow {
	const snapshot = new ConversationSnapshotBuilder({
		getRoot: () => conversation,
		getActive: activeConversation ?? (() => conversation),
		getHeader: () => (history && !history.showHeader() ? undefined : header),
		getRootSegments: history && (() => history.segments()),
	});
	return new ConversationWindow(() => snapshot.getSnapshot(), undefined, selectionStyle, history);
}

/** Lazy, identity-anchored viewport. Never renders the transcript merely to count its rows. */
export class ConversationWindow {
	private readonly entries: ConversationWindowSource;
	private readonly byteLimit: number;
	private readonly selectionStyle: () => string;
	private readonly history?: ConversationHistoryNavigation;
	private readonly cache = new Map<Component, CachedRows>();
	private readonly scrollStates = new WeakMap<object, { tail: boolean; anchor?: Anchor }>();
	private readonly containerEntries = new WeakMap<object, { revision: number; entries: readonly Component[] }>();
	private currentContainer?: object;
	private lastEntriesRevision?: number;
	private anchor?: Anchor;
	private width = 1;
	private height = 1;
	private visible: string[] = [];
	private readonly visibleRoots = new Set<Component>();
	private anchorRoot?: Component;
	private frozen?: string[];
	private frozenWidth = 1;
	private selection?: { start: ConversationPoint; end: ConversationPoint };
	private tail = true;
	private bytes = 0;
	private cachedRows = 0;
	private frame?: {
		snapshot: ConversationWindowSnapshot;
		width: number;
		height: number;
		revisions: Map<Component, number | undefined>;
	};
	private frameRevisions?: Map<Component, number | undefined>;

	/**
	 * `selectionStyle` returns the SGR sequence asserted over selected cells (read on every paint so a theme
	 * change applies at once). The default is reverse video, which keeps each cell's own colors.
	 */
	constructor(
		entries: ConversationWindowSource,
		byteLimit = 2 * 1024 * 1024,
		selectionStyle: () => string = () => "\x1b[7m",
		history?: ConversationHistoryNavigation,
	) {
		this.entries = entries;
		this.byteLimit = byteLimit;
		this.selectionStyle = selectionStyle;
		this.history = history;
	}

	get following(): boolean {
		return this.tail;
	}
	get cachedBytes(): number {
		return this.bytes;
	}

	/** The root transcript components backing the current reading window and its next anchor. */
	*retainedComponents(container: Container): IterableIterator<Component> {
		if (this.tail || this.currentContainer !== container) return;
		yield* this.visibleRoots;
		if (this.anchorRoot && !this.visibleRoots.has(this.anchorRoot)) yield this.anchorRoot;
	}

	invalidate(component?: Component): void {
		this.frame = undefined;
		if (component) {
			const cached = this.cache.get(component);
			this.bytes -= cached?.bytes ?? 0;
			this.cachedRows -= cached?.lines.length ?? 0;
			this.cache.delete(component);
		} else {
			this.cache.clear();
			this.bytes = 0;
			this.cachedRows = 0;
		}
	}

	reset(): void {
		this.latest();
		this.invalidate();
		this.anchor = undefined;
		this.visible = [];
		this.visibleRoots.clear();
		this.anchorRoot = undefined;
		this.currentContainer = undefined;
	}

	/** Forgets one container's scroll position and row keys, so a rebuilt transcript starts at its tail. */
	resetContainerScroll(container: object): void {
		this.frame = undefined;
		this.scrollStates.delete(container);
		for (const component of this.containerEntries.get(container)?.entries ?? []) this.invalidate(component);
		this.containerEntries.delete(container);
		if (this.currentContainer !== container) return;
		this.currentContainer = undefined;
		this.tail = true;
		this.anchor = undefined;
		this.anchorRoot = undefined;
		this.visibleRoots.clear();
		this.frozen = undefined;
		this.selection = undefined;
	}

	latest(): void {
		this.frame = undefined;
		this.history?.follow();
		this.tail = true;
		this.frozen = undefined;
		this.selection = undefined;
	}

	readEarlier(): void {
		const first = this.getSnapshot().entries[0];
		this.anchor = first ? { component: first, row: 0 } : undefined;
		this.scroll(-Math.max(1, this.height - 1));
	}

	private rows(component: Component): TerminalRows {
		const rows = this.componentRows(component);
		this.frameRevisions?.set(component, rowRevision(component));
		return rows;
	}

	private componentRows(component: Component): TerminalRows {
		const revision = rowRevision(component);
		const cached = this.cache.get(component);
		if (cached && revision !== undefined && cached.revision === revision && cached.width === this.width) {
			return cached.lines;
		}
		this.invalidate(component);
		// Framed history only normalizes the rows it reads. Inline prompt marks and image
		// protocol blocks cannot be emitted inside the Workbench's split panes.
		const borrowed = borrowComponentRows(component, this.width);
		if (borrowed) {
			return {
				length: borrowed.length,
				at(index) {
					const line = borrowed.at(index);
					return line === undefined ? undefined : conversationRow(line);
				},
			};
		}
		const lines = component.render(this.width).map(conversationRow);
		const bytes = lines.reduce((sum, line) => sum + line.length * 2, 0);
		if (revision !== undefined && lines.length > 0 && lines.length <= MAX_CACHED_ROWS && bytes <= this.byteLimit) {
			while (this.bytes + bytes > this.byteLimit || this.cachedRows + lines.length > MAX_CACHED_ROWS) {
				const oldest = this.cache.keys().next().value;
				if (!oldest) break;
				this.invalidate(oldest);
			}
			this.cache.set(component, { width: this.width, revision: component.renderRevision ?? revision, lines, bytes });
			this.bytes += bytes;
			this.cachedRows += lines.length;
		}
		return lines;
	}

	private getSnapshot(): ConversationWindowSnapshot {
		const raw = this.entries();
		let snapshot: ConversationWindowSnapshot;
		if (raw && typeof raw === "object" && "entries" in raw && "indexMap" in raw) {
			snapshot = raw as ConversationWindowSnapshot;
		} else {
			const entries = (raw ?? []) as readonly Component[];
			const indexMap = new Map<Component, number>();
			for (let i = 0; i < entries.length; i++) indexMap.set(entries[i], i);
			snapshot = { entries, indexMap, revision: 0 };
		}
		if (snapshot.container && snapshot.container !== this.currentContainer) {
			if (this.currentContainer) {
				this.scrollStates.set(this.currentContainer, { tail: this.tail, anchor: this.anchor });
			}
			this.currentContainer = snapshot.container;
			this.visibleRoots.clear();
			this.anchorRoot = undefined;
			this.frozen = undefined;
			this.selection = undefined;
			const saved = this.scrollStates.get(snapshot.container);
			if (saved) {
				this.tail = saved.tail;
				this.anchor = saved.anchor;
			} else {
				this.tail = true;
				this.anchor = undefined;
			}
		}
		this.recoverAnchor(snapshot);
		return snapshot;
	}

	private recoverAnchor(snapshot: ConversationWindowSnapshot): void {
		const { container, entries, indexMap } = snapshot;
		if (this.tail || !this.anchor || indexMap.has(this.anchor.component)) return;
		const previous = container && this.containerEntries.get(container)?.entries;
		const previousIndex = previous?.indexOf(this.anchor.component) ?? -1;
		// When an entry is withdrawn, prefer the next surviving entry at the previous reading position.
		let replacement: Component | undefined;
		if (previous && previousIndex >= 0) {
			for (let index = previousIndex + 1; index < previous.length && !replacement; index++) {
				if (indexMap.has(previous[index]!)) replacement = previous[index];
			}
			for (let index = previousIndex - 1; index >= 0 && !replacement; index--) {
				if (indexMap.has(previous[index]!)) replacement = previous[index];
			}
		}
		replacement ??= entries[0];
		this.anchor = replacement ? { component: replacement, row: 0 } : undefined;
	}

	render(width: number, height: number): string[] {
		this.width = Math.max(1, width);
		this.height = Math.max(0, height);
		const snapshot = this.getSnapshot();
		if (this.frozen) return this.highlight(this.frozen.slice(0, this.height));
		const previous = this.frame;
		if (
			previous?.snapshot === snapshot &&
			previous.width === this.width &&
			previous.height === this.height &&
			[...previous.revisions].every(
				([component, revision]) => revision !== undefined && rowRevision(component) === revision,
			)
		) {
			return this.visible.slice();
		}
		const entries = snapshot.entries;
		const indexMap = snapshot.indexMap;
		// Prune evicted transcript identities only for the container whose transcript changed, and only
		// when its revision moved: cached rows of the chats we are not looking at stay usable.
		const container = snapshot.container;
		if (container) {
			const record = this.containerEntries.get(container);
			if (!record || record.revision !== snapshot.revision) {
				if (record) {
					for (const component of record.entries) {
						if (!indexMap.has(component)) this.invalidate(component);
					}
				}
				this.containerEntries.set(container, { revision: snapshot.revision, entries });
			}
		} else if (this.lastEntriesRevision !== snapshot.revision) {
			this.lastEntriesRevision = snapshot.revision;
			for (const component of this.cache.keys()) {
				if (!indexMap.has(component)) this.invalidate(component);
			}
		}
		const lines: string[] = [];
		this.frameRevisions = new Map();
		this.visibleRoots.clear();
		if (this.tail) {
			for (let index = entries.length - 1; index >= 0 && lines.length < this.height; index--) {
				const component = entries[index]!;
				const rows = this.rows(component);
				if (rows.length) this.visibleRoots.add(snapshot.rootOwners?.get(component) ?? component);
				for (let row = rows.length - 1; row >= 0 && lines.length < this.height; row--) {
					lines.push(rows.at(row) ?? "");
					this.anchor = { component, row };
				}
			}
			lines.reverse();
		} else {
			let index = this.anchor ? (indexMap.get(this.anchor.component) ?? 0) : 0;
			let offset = index >= 0 ? (this.anchor?.row ?? 0) : 0;
			index = Math.max(0, index);
			for (; index < entries.length && lines.length < this.height; index++) {
				const component = entries[index]!;
				const rows = this.rows(component);
				offset = Math.min(offset, Math.max(0, rows.length - 1));
				if (lines.length === 0 && rows.length) this.anchor = { component, row: offset };
				if (offset < rows.length) this.visibleRoots.add(snapshot.rootOwners?.get(component) ?? component);
				for (let row = offset; row < rows.length && lines.length < this.height; row++)
					lines.push(rows.at(row) ?? "");
				offset = 0;
			}
		}
		// A short transcript anchors to the bottom: the latest exchange sits next to the input, and
		// the empty rows stay above it, so a new message never appears at the top of an empty area.
		while (lines.length < this.height) lines.unshift("");
		this.visible = lines;
		this.frame = { snapshot, width: this.width, height: this.height, revisions: this.frameRevisions };
		this.frameRevisions = undefined;
		this.anchorRoot = this.anchor && (snapshot.rootOwners?.get(this.anchor.component) ?? this.anchor.component);
		return lines;
	}

	scroll(delta: number): void {
		this.frame = undefined;
		this.history?.scrolling(delta);
		const snapshot = this.getSnapshot();
		const entries = snapshot.entries;
		const indexMap = snapshot.indexMap;
		this.tail = false;
		this.selection = undefined;
		this.frozen = undefined;
		let index = this.anchor ? (indexMap.get(this.anchor.component) ?? 0) : 0;
		index = Math.max(0, index);
		let row = (this.anchor?.row ?? 0) + delta;
		while (row < 0 && index > 0) row += this.rows(entries[--index]!).length;
		while (index < entries.length - 1) {
			const length = this.rows(entries[index]!).length;
			if (row < length) break;
			row -= length;
			index++;
		}
		let newerResidual = 0;
		if (delta > 0 && entries[index]) {
			let remaining = -row;
			for (let cursor = index; cursor < entries.length && remaining <= this.height; cursor++) {
				remaining += this.rows(entries[cursor]!).length;
			}
			if (remaining <= this.height) {
				newerResidual = Math.max(1, this.height - remaining);
				row -= newerResidual;
				while (row < 0 && index > 0) row += this.rows(entries[--index]!).length;
			}
		}
		const component = entries[index];
		if (component) this.anchor = { component, row: Math.max(0, Math.min(row, this.rows(component).length - 1)) };
		this.anchorRoot = component && (snapshot.rootOwners?.get(component) ?? component);
		if (delta < 0 && row < 0) this.history?.move(-1, row);
		else if (delta < 0 && index <= 3 && row < this.height) this.history?.prepareOlder();
		if (newerResidual && !this.history?.move(1, newerResidual)) this.tail = true;
	}

	select(point: ConversationPoint, start: boolean): void {
		if (start) {
			this.frame = undefined;
			this.history?.cancel();
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
			const start = range ? Math.min(this.width, range[0]) : 0;
			const end = range ? Math.min(this.width, range[1]) : 0;
			if (end <= start) return truncateToWidth(line, this.width, "");
			// The row keeps its own colors, code surface and weight; only the selected cells gain the wash.
			return styleColumnRange(line, start, end, this.selectionStyle(), this.width);
		});
	}
}
