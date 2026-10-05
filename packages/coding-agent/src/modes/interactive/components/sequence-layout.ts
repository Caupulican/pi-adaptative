/**
 * The sequence layout: the flow trace as a sequence diagram on the terminal cell grid. Lifelines are
 * the actors (you, System One, root, one per worker by name); a message is an arrow between two
 * lifelines; a span on one lifeline is an activation bar; the label of every row sits to the right of
 * the lifeline field so a head or a label never touches a lifeline. Pure: events, width and nowMs in,
 * rows of cells out. No timers, no theme, no ANSI: tones are theme tokens the painter resolves.
 *
 * Package (what the view carries, fixed before any glyph):
 *   - lifelines: owner, System One, root, each worker lane by name (the least recent fold into one
 *     overflow lifeline when the width cannot hold them);
 *   - message: an event with `to` is an arrow lifeline to lifeline; running = in flight, settled with an
 *     outcome = proven, a delegation to a still-queued worker = claimed;
 *   - activation: an event without `to` that spans time is a bar on its own lifeline; the innermost
 *     (latest-started) span covering a row wins;
 *   - evidence: a settled System One judgment or route carries its result and ledger handle as `label (result) #a1b2`.
 *
 * Constraint code (the geometric language every cell obeys):
 *   - 1 unit = 1 cell; a cell is `cellWidth` terminal columns, the widest glyph of the glyph set, so
 *     the box-drawing and arrow glyphs (East Asian Ambiguous) hold when `PI_AMBIGUOUS_WIDTH=wide`
 *     doubles them; every width goes through `visibleWidth`, never a literal;
 *   - lifeline cells sit on a fixed pitch p (2..14 cells) derived from the width; the lifeline field
 *     takes at most 55% of it and the label column the rest;
 *   - orthogonal only: horizontal arrows, vertical lifelines, square joins; no diagonals, no rounded
 *     corners; one stroke family (box drawing: light for edges and lifelines, heavy for activation);
 *   - edge state is a glyph, never only a hue: settled `─`, in flight `┄`, claimed `·`; the lifeline
 *     is `│`, a running activation `┆`, a finished one `┃`, a claimed one `·`; heads are `▶` `◀`;
 *   - an arrow starts on the origin lifeline cell (the kind glyph), its head sits one cell before the
 *     target lifeline, and the target lifeline cell is the join `┤` `├`; a crossing is `┼`.
 */

import { truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import type { FlowActor, FlowEvent, FlowKind, FlowOutcome } from "../../../core/operator-projection/flow-trace.ts";
import type { ThemeColor } from "../../../presentation/theme-model.ts";
import { formatGraphDuration, SYSTEM_ONE_TONE } from "./decision-graph-render.ts";
import { CARRIER_GLYPH } from "./flow-carrier.ts";

export interface SequenceKindLook {
	readonly glyph: string;
	/** A run of finished actions of this kind folds into one counted row. */
	readonly folds: boolean;
	/** The folded row's noun ("tools ×6"). */
	readonly plural: string;
}

export type SequenceLook = Readonly<Record<FlowKind, SequenceKindLook>>;

/** A row: one action, or a run of finished same-kind actions of one actor folded together. */
export interface FlowRow {
	readonly first: FlowEvent;
	/** The newest action folded into the row; equals `first` for a single action. */
	readonly last: FlowEvent;
	readonly count: number;
	readonly totalMs: number;
	readonly labels: readonly string[];
	readonly outcome?: FlowOutcome;
}

export type EdgeState = "settled" | "flight" | "claimed";

export interface SequenceCell {
	/** One grapheme, padded to `cellWidth` columns when painted. */
	readonly glyph: string;
	readonly tone: ThemeColor | undefined;
}

export interface SequenceArrow {
	/** Field cell indexes of the two lifelines the arrow joins. */
	readonly from: number;
	readonly to: number;
	readonly state: EdgeState;
}

export interface SequenceRow {
	readonly first: FlowEvent;
	readonly last: FlowEvent;
	readonly count: number;
	readonly cells: readonly SequenceCell[];
	readonly arrow?: SequenceArrow;
	/** Plain text already fitted to the label column. */
	readonly label: string;
	readonly labelTone: ThemeColor;
}

export interface SequenceLifeline {
	readonly key: string;
	readonly title: string;
	/** Shown in the header when the title does not fit in the pitch; the legend names it. */
	readonly tag?: string;
	readonly cell: number;
	readonly busy: boolean;
}

export interface SequenceHeaderPart {
	/** Terminal column the text starts at. */
	readonly col: number;
	readonly text: string;
	readonly tone: ThemeColor;
	readonly bold: boolean;
}

export interface SequenceLayout {
	readonly cellWidth: number;
	readonly pitch: number;
	readonly fieldCells: number;
	/** Terminal column where the label column starts. */
	readonly labelCol: number;
	readonly labelWidth: number;
	readonly lifelines: readonly SequenceLifeline[];
	readonly header: readonly SequenceHeaderPart[];
	readonly legend: readonly string[];
	readonly rows: readonly SequenceRow[];
}

/** The glyph set of the field: one stroke family, one glyph per meaning. */
export const SEQUENCE_GLYPH = {
	blank: " ",
	lifeline: "│",
	active: "┃",
	activeLive: "┆",
	dotted: "·",
	settled: "─",
	flight: "┄",
	cross: "┼",
	joinLeft: "├",
	joinRight: "┤",
	headRight: "▶",
	headLeft: "◀",
} as const;

const MIN_PITCH = 2;
const MAX_PITCH = 14;
/** The lifeline field takes at most this share of the width; the label column gets the rest. */
const FIELD_SHARE = 0.55;
/** Columns between the lifeline field and the label column. */
const LABEL_GAP = 2;
const FIXED_LIFELINES = 3;
const TAGS = "123456789abcdefghijklmnopqrstuvwxyz";

const FIXED_TITLE: Readonly<Record<Exclude<FlowActor, "worker">, string>> = {
	owner: "you",
	system_one: "System One",
	root: "root",
};
const FIXED_KEYS: readonly Exclude<FlowActor, "worker">[] = ["owner", "system_one", "root"];

const OUTCOME_MARK: Readonly<Record<FlowOutcome, string>> = {
	ok: "",
	failed: "✗ ",
	cancelled: "× ",
	attention: "! ",
};

const OUTCOME_TONE: Readonly<Record<FlowOutcome, ThemeColor>> = {
	ok: "success",
	failed: "error",
	cancelled: "dim",
	attention: "warning",
};

function foldable(look: SequenceLook, row: FlowRow, event: FlowEvent): boolean {
	return (
		look[event.kind].folds &&
		row.first.kind === event.kind &&
		row.first.actor === event.actor &&
		row.first.lane === event.lane &&
		row.first.endedAt !== undefined &&
		event.endedAt !== undefined &&
		(row.outcome ?? "ok") === "ok" &&
		(event.outcome ?? "ok") === "ok"
	);
}

/** The trace as rows, oldest first, and the row each event landed in (`rowOf[i]` for `flow[i]`). */
export function foldFlow(
	flow: readonly FlowEvent[],
	look: SequenceLook,
): { readonly rows: FlowRow[]; readonly rowOf: number[] } {
	const rows: FlowRow[] = [];
	const rowOf: number[] = [];
	for (const event of flow) {
		const duration = event.endedAt !== undefined ? Math.max(0, event.endedAt - event.startedAt) : 0;
		const previous = rows.at(-1);
		if (previous && foldable(look, previous, event)) {
			rows[rows.length - 1] = {
				...previous,
				last: event,
				count: previous.count + 1,
				totalMs: previous.totalMs + duration,
				labels: previous.labels.includes(event.label) ? previous.labels : [...previous.labels, event.label],
			};
			rowOf.push(rows.length - 1);
			continue;
		}
		rows.push({
			first: event,
			last: event,
			count: 1,
			totalMs: duration,
			labels: [event.label],
			...(event.outcome ? { outcome: event.outcome } : {}),
		});
		rowOf.push(rows.length - 1);
	}
	return { rows, rowOf };
}

/** Columns of one cell: the widest glyph of the glyph set, so a doubled ambiguous width keeps the grid. */
export function sequenceCellWidth(look: SequenceLook): number {
	const glyphs = [...Object.values(SEQUENCE_GLYPH), CARRIER_GLYPH, ...Object.values(look).map((entry) => entry.glyph)];
	return Math.max(1, ...glyphs.map((glyph) => visibleWidth(glyph)));
}

function liveTone(actor: FlowActor): ThemeColor {
	return actor === "system_one" ? SYSTEM_ONE_TONE : "accent";
}

function edgeTone(row: FlowRow, state: EdgeState): ThemeColor {
	if (state === "flight") return liveTone(row.first.actor);
	if (state === "claimed") return "dim";
	return OUTCOME_TONE[row.outcome ?? "ok"];
}

function labelTone(row: FlowRow): ThemeColor {
	const event = row.first;
	if (event.endedAt === undefined) return liveTone(event.actor);
	if (row.outcome && row.outcome !== "ok") return OUTCOME_TONE[row.outcome];
	return event.actor === "system_one" ? SYSTEM_ONE_TONE : event.actor === "owner" ? "text" : "muted";
}

/**
 * The evidence a settled action carries, kept whole as the label's suffix: the result a System One
 * judgment or route reached, then the short ledger handle of the row behind it (`label (result) #a1b2`).
 */
function splitEvidence(event: FlowEvent): { text: string; evidence: string } {
	const handle = event.evidence ? ` ${event.evidence}` : "";
	const split = event.label.indexOf(" → ");
	if ((event.actor !== "system_one" && event.kind !== "route") || split === -1 || event.endedAt === undefined)
		return { text: event.label, evidence: handle };
	return { text: event.label.slice(0, split), evidence: ` (${event.label.slice(split + 3)})${handle}` };
}

function fitLabel(text: string, suffix: string, width: number): string {
	if (width <= 0) return "";
	const whole = `${text}${suffix}`;
	if (visibleWidth(whole) <= width) return whole;
	const room = width - visibleWidth(suffix);
	// The suffix (evidence and clock) survives while the text shortens; when nothing of the text would
	// remain readable the whole label shortens instead.
	if (room >= 4) return `${truncateToWidth(text, room, "…")}${suffix}`;
	return truncateToWidth(whole, width, "…");
}

function rowLabel(row: FlowRow, look: SequenceLook, nowMs: number, width: number): string {
	const event = row.first;
	const kind = look[event.kind];
	const mark =
		event.endedAt === undefined
			? ""
			: event.kind === "report" && row.outcome === "ok"
				? "✓ "
				: OUTCOME_MARK[row.outcome ?? "ok"];
	if (row.count > 1) {
		const names = row.labels.slice(0, 3).join(", ");
		return fitLabel(
			`${mark}${kind.plural} ×${row.count} · avg ${formatGraphDuration(row.totalMs / row.count)} (${names})`,
			"",
			width,
		);
	}
	const { text, evidence } = splitEvidence(event);
	const lane = event.actor === "worker" && event.lane && event.kind !== "worker" && event.kind !== "report";
	const timed =
		event.endedAt === undefined
			? `  ${formatGraphDuration(nowMs - event.startedAt)}`
			: row.totalMs >= 1000
				? `  ${formatGraphDuration(row.totalMs)}`
				: "";
	return fitLabel(`${mark}${lane ? `${event.lane}: ` : ""}${text}`, `${evidence}${timed}`, width);
}

interface LifelineModel {
	readonly list: SequenceLifeline[];
	/** Lifeline index per lifeline key; every hidden worker maps to the overflow lifeline. */
	readonly indexOf: (key: string) => number;
	readonly pitch: number;
	readonly fieldCells: number;
}

export function buildSequenceLayout(
	flow: readonly FlowEvent[],
	options: { readonly width: number; readonly nowMs: number; readonly look: SequenceLook },
): SequenceLayout {
	const { width, nowMs, look } = options;
	const cellWidth = sequenceCellWidth(look);
	const { rows: folded, rowOf } = foldFlow(flow, look);

	// Worker lifelines are named by lane; a delegation names its lane in the label.
	const knownLanes = new Set(flow.flatMap((event) => (event.lane !== undefined ? [event.lane] : [])));
	const resolveLane = (label: string): string => {
		if (knownLanes.has(label)) return label;
		if (label.endsWith("…")) {
			const stem = label.slice(0, -1);
			for (const name of knownLanes) if (name.startsWith(stem)) return name;
		}
		return label;
	};
	const sourceKey = (event: FlowEvent): string =>
		event.actor === "worker" ? `worker:${event.lane ?? event.label}` : event.actor;
	const targetKey = (event: FlowEvent): string | undefined =>
		event.to === undefined
			? undefined
			: event.to === "worker"
				? `worker:${event.lane ?? resolveLane(event.label)}`
				: event.to;

	const lastSeen = new Map<string, number>();
	const workerKeys: string[] = [];
	flow.forEach((event, index) => {
		for (const key of [sourceKey(event), targetKey(event)]) {
			if (key === undefined || !key.startsWith("worker:")) continue;
			if (!lastSeen.has(key)) workerKeys.push(key);
			lastSeen.set(key, index);
		}
	});

	const fieldColumns = Math.floor(width * FIELD_SHARE);
	const capCells = Math.max(1, Math.floor(fieldColumns / cellWidth));
	const maxLifelines = Math.floor((capCells - 1) / MIN_PITCH) + 1;
	const workerSlots = Math.max(1, maxLifelines - FIXED_LIFELINES);
	const overflowing = workerKeys.length > workerSlots;
	// The most recently active workers keep their own lifeline, shown in the order they first appeared.
	const visibleWorkers = overflowing
		? new Set(
				[...workerKeys]
					.sort((a, b) => (lastSeen.get(b) ?? 0) - (lastSeen.get(a) ?? 0))
					.slice(0, Math.max(0, workerSlots - 1)),
			)
		: new Set(workerKeys);
	const shownWorkers = workerKeys.filter((key) => visibleWorkers.has(key));
	const hiddenCount = workerKeys.length - shownWorkers.length;

	const lifelineModel = ((): LifelineModel => {
		const keys = [...FIXED_KEYS, ...shownWorkers, ...(hiddenCount > 0 ? ["overflow"] : [])];
		const count = keys.length;
		const pitch =
			count <= 1 ? MIN_PITCH : Math.max(MIN_PITCH, Math.min(MAX_PITCH, Math.floor((capCells - 1) / (count - 1))));
		const busyKeys = new Set(flow.filter((event) => event.endedAt === undefined).map((event) => sourceKey(event)));
		const available = pitch * cellWidth - 1;
		const list = keys.map((key, index): SequenceLifeline => {
			const title =
				key === "overflow"
					? `+${hiddenCount} more`
					: key.startsWith("worker:")
						? key.slice("worker:".length)
						: FIXED_TITLE[key as Exclude<FlowActor, "worker">];
			const busy =
				key === "overflow"
					? [...busyKeys].some((busyKey) => !visibleWorkers.has(busyKey) && busyKey.startsWith("worker:"))
					: busyKeys.has(key);
			const fits = visibleWidth(title) <= available;
			return { key, title, ...(fits ? {} : { tag: TAGS[index] ?? "*" }), cell: index * pitch, busy };
		});
		const indexByKey = new Map(list.map((lifeline, index) => [lifeline.key, index]));
		return {
			list,
			indexOf: (key) => indexByKey.get(key) ?? indexByKey.get("overflow") ?? 0,
			pitch,
			fieldCells: (count - 1) * pitch + 1,
		};
	})();
	const { list: lifelines, pitch, fieldCells, indexOf } = lifelineModel;
	const labelCol = fieldCells * cellWidth + LABEL_GAP;
	const labelWidth = Math.max(0, width - labelCol);

	// Activation bars: a span of an action without a target covers the rows its lifeline stays busy.
	interface Bar {
		readonly glyph: string;
		readonly tone: ThemeColor;
		readonly order: number;
	}
	const bars: (Map<number, Bar> | undefined)[] = lifelines.map(() => undefined);
	flow.forEach((event, index) => {
		const target = targetKey(event);
		if (target !== undefined && target !== sourceKey(event)) return;
		const running = event.endedAt === undefined;
		if (!running && (event.endedAt ?? 0) <= event.startedAt) return;
		const start = rowOf[index]!;
		let end = start;
		if (running) end = folded.length - 1;
		else
			for (let row = start + 1; row < folded.length; row++)
				if (folded[row]!.first.startedAt <= (event.endedAt ?? 0)) end = row;
		if (end <= start) return;
		const lifeline = indexOf(sourceKey(event));
		// Waiting is claimed time, not work: dotted whether or not it is still open.
		const bar: Bar =
			event.kind === "wait"
				? { glyph: SEQUENCE_GLYPH.dotted, tone: "dim", order: start }
				: running
					? { glyph: SEQUENCE_GLYPH.activeLive, tone: liveTone(event.actor), order: start }
					: { glyph: SEQUENCE_GLYPH.active, tone: OUTCOME_TONE[event.outcome ?? "ok"], order: start };
		const column = bars[lifeline] ?? new Map<number, Bar>();
		bars[lifeline] = column;
		for (let row = start + 1; row <= end; row++) {
			const existing = column.get(row);
			if (!existing || existing.order <= start) column.set(row, bar);
		}
	});

	// A delegation to a worker still waiting for a slot is claimed, not proven.
	const queued = new Set(
		flow
			.filter((event) => event.kind === "wait" && event.lane !== undefined && event.endedAt === undefined)
			.map((event) => `worker:${event.lane}`),
	);

	const idle: SequenceCell = { glyph: SEQUENCE_GLYPH.lifeline, tone: "dim" };
	const blank: SequenceCell = { glyph: SEQUENCE_GLYPH.blank, tone: undefined };
	const lifelineCells = new Set(lifelines.map((lifeline) => lifeline.cell));

	const rows = folded.map((row, rowIndex): SequenceRow => {
		const cells: SequenceCell[] = Array.from({ length: fieldCells }, () => blank);
		lifelines.forEach((lifeline, index) => {
			const bar = bars[index]?.get(rowIndex);
			cells[lifeline.cell] = bar ? { glyph: bar.glyph, tone: bar.tone } : idle;
		});
		const event = row.first;
		const from = lifelines[indexOf(sourceKey(event))]!.cell;
		const target = targetKey(event);
		const to = target === undefined ? from : lifelines[indexOf(target)]!.cell;
		const glyph = look[event.kind].glyph;
		const label = rowLabel(row, look, nowMs, labelWidth);
		if (to === from) {
			cells[from] = { glyph, tone: edgeTone(row, event.endedAt === undefined ? "flight" : "settled") };
			return { first: event, last: row.last, count: row.count, cells, label, labelTone: labelTone(row) };
		}
		const state: EdgeState =
			event.endedAt === undefined ? "flight" : queued.has(target ?? "") ? "claimed" : "settled";
		const tone = edgeTone(row, state);
		const direction = to > from ? 1 : -1;
		const body =
			state === "flight"
				? SEQUENCE_GLYPH.flight
				: state === "claimed"
					? SEQUENCE_GLYPH.dotted
					: SEQUENCE_GLYPH.settled;
		for (let cell = from + direction; cell !== to; cell += direction)
			cells[cell] = { glyph: lifelineCells.has(cell) ? SEQUENCE_GLYPH.cross : body, tone };
		cells[to - direction] = { glyph: direction > 0 ? SEQUENCE_GLYPH.headRight : SEQUENCE_GLYPH.headLeft, tone };
		cells[to] = { glyph: direction > 0 ? SEQUENCE_GLYPH.joinRight : SEQUENCE_GLYPH.joinLeft, tone };
		cells[from] = { glyph, tone };
		return {
			first: event,
			last: row.last,
			count: row.count,
			cells,
			arrow: { from, to, state },
			label,
			labelTone: labelTone(row),
		};
	});

	const header = lifelines.map(
		(lifeline): SequenceHeaderPart => ({
			col: lifeline.cell * cellWidth,
			text: lifeline.tag ?? lifeline.title,
			tone: lifeline.busy ? "accent" : "muted",
			bold: lifeline.busy,
		}),
	);
	const legend: string[] = [];
	let line = "";
	for (const lifeline of lifelines) {
		if (lifeline.tag === undefined) continue;
		const entry = truncateToWidth(`${lifeline.tag} ${lifeline.title}`, Math.max(1, width), "…");
		if (line && visibleWidth(line) + 2 + visibleWidth(entry) > width) {
			legend.push(line);
			line = entry;
		} else line = line ? `${line}  ${entry}` : entry;
	}
	if (line) legend.push(line);

	return { cellWidth, pitch, fieldCells, labelCol, labelWidth, lifelines, header, legend, rows };
}
