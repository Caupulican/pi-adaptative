/**
 * The sequence layout: the flow trace as a sequence diagram on the terminal cell grid. Lifelines are
 * the actors (you, System One, root, one per worker by name); a message is an arrow between two
 * lifelines; a span on one lifeline is an activation bar; the label of every row sits to the right of
 * the lifeline field so a head or a label never touches a lifeline. Pure: events, width and nowMs in,
 * geometry out (lifeline cells, bar runs, one mark and at most one arrow per row, label text). No
 * timers, no theme, no ANSI, no glyph drawing beyond naming the glyphs: the painter (`flow-lanes-render.ts`)
 * draws the geometry on a cell canvas, which merges lifeline crossings and joins into junction glyphs.
 *
 * Package (what the view carries, fixed before any glyph):
 *   - lifelines: owner, System One, root, each worker lane by name (the least recent fold into one
 *     overflow lifeline when the width cannot hold them);
 *   - message: an event with `to` is an arrow lifeline to lifeline; running = in flight, settled with an
 *     outcome = proven, settled without one = unmarked (the source never said how it ended), a
 *     delegation to a still-queued worker = claimed;
 *   - activation: an event without `to` that spans time is a bar on its own lifeline; the innermost
 *     (latest-started) span covering a row wins;
 *   - evidence: a settled System One judgment carries its result and ledger handle as `label (result) #a1b2`.
 *
 * Input contract: `flow` is ordered by start time (the trace keeps it so); folds, turn absorption and
 * activation-bar ends read it that way, in one pass each. A worker lifeline is the event's `laneKey`,
 * never display text.
 *
 * Constraint code (the geometric language every cell obeys):
 *   - 1 unit = 1 cell; a cell is `cellWidth` terminal columns, the widest glyph of the glyph set, so
 *     the box-drawing and arrow glyphs (East Asian Ambiguous) hold when `PI_AMBIGUOUS_WIDTH=wide`
 *     doubles them; every width goes through `visibleWidth`, never a literal;
 *   - lifeline cells sit on a fixed pitch p (2..14 cells) derived from the width; the lifeline field
 *     takes at most 55% of it and the label column the rest, never less than MIN_LABEL_WIDTH columns:
 *     lifelines merge into the `+N more` lifeline first, and when even the fixed lifelines (plus the
 *     overflow lifeline, if workers exist) cannot fit, the view degrades to labels only: no header, no
 *     field, each row is its kind glyph and its label across the whole width;
 *   - orthogonal only: horizontal arrows, vertical lifelines, square joins; no diagonals, no rounded
 *     corners; one stroke family (box drawing: light for edges and lifelines, heavy for finished
 *     activation);
 *   - one glyph per meaning, never only a hue. Field glyphs (the kind glyphs are in `flow-lanes-render.ts`):
 *       lifeline `│`   running activation `┆`   finished activation `┃`   waiting activation `╎`
 *       edge settled `─`   in flight `┄`   claimed body `·`   head `→` `←`   crossing `┼`   join `├` `┤`
 *     label marks: done report `✓`, failed `✗`, cancelled `⊘`, needs review `!`; fold count `×`;
 *     the carrier `●` appears nowhere else;
 *   - an arrow starts on the origin lifeline cell (the kind glyph), its head sits one cell before the
 *     target lifeline, and the target lifeline cell is the join; a crossing is `┼`.
 */

import { truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import type { FlowActor, FlowEvent, FlowKind, FlowOutcome } from "../../../core/operator-projection/flow-trace.ts";
import { formatCompactDuration } from "../../../core/util/format-duration.ts";
import type { ThemeColor } from "../../../presentation/theme-model.ts";
import { SYSTEM_ONE_TONE } from "./decision-graph-render.ts";
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

/** What a lifeline is doing over a run of rows: working, finished, or waiting. */
export type BarKind = "live" | "done" | "wait";

/** The kind glyph on the origin lifeline cell of a row. */
export interface SequenceMark {
	readonly cell: number;
	readonly glyph: string;
	readonly tone: ThemeColor;
}

export interface SequenceArrow {
	/** Field cell indexes of the two lifelines the arrow joins. */
	readonly from: number;
	readonly to: number;
	readonly state: EdgeState;
	readonly tone: ThemeColor;
}

export interface SequenceRow {
	readonly first: FlowEvent;
	readonly last: FlowEvent;
	readonly count: number;
	/** Absent in the labels-only layout, which has no field. */
	readonly mark?: SequenceMark;
	readonly arrow?: SequenceArrow;
	/** Plain text already fitted to the label column. */
	readonly label: string;
	readonly labelTone: ThemeColor;
}

/** One activation span: rows `fromRow..toRow` (inclusive) of the lifeline at field cell `cell`. */
export interface SequenceBar {
	readonly cell: number;
	readonly fromRow: number;
	readonly toRow: number;
	readonly kind: BarKind;
	readonly tone: ThemeColor;
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
	readonly bars: readonly SequenceBar[];
	readonly header: readonly SequenceHeaderPart[];
	readonly legend: readonly string[];
	readonly rows: readonly SequenceRow[];
}

/** The glyph a bar of each kind is drawn with on its lifeline. */
export const BAR_GLYPH: Readonly<Record<BarKind, string>> = { live: "┆", done: "┃", wait: "╎" };

/** The body of an edge to a worker that has not started: claimed, not proven. */
export const CLAIMED_GLYPH = "·";

/** Glyphs the cell canvas derives itself from lifeline and arrow masks; listed so the cell width counts them. */
const CANVAS_GLYPHS = ["│", "─", "┄", "├", "┤", "┼", "→", "←"];

const MIN_PITCH = 2;
const MAX_PITCH = 14;
/** The lifeline field takes at most this share of the width; the label column gets the rest. */
const FIELD_SHARE = 0.55;
/** The label column is never narrower than this; the lifeline field gives way first. */
const MIN_LABEL_WIDTH = 12;
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
	cancelled: "⊘ ",
	attention: "! ",
};

const OUTCOME_TONE: Readonly<Record<FlowOutcome, ThemeColor>> = {
	ok: "success",
	failed: "error",
	cancelled: "dim",
	attention: "warning",
};

/** An action that ended without an outcome claims none: it is drawn neutral, never as a success. */
function outcomeTone(outcome: FlowOutcome | undefined): ThemeColor {
	return outcome === undefined ? "muted" : OUTCOME_TONE[outcome];
}

function foldable(look: SequenceLook, row: FlowRow, event: FlowEvent): boolean {
	return (
		look[event.kind].folds &&
		row.first.kind === event.kind &&
		row.first.actor === event.actor &&
		row.first.laneKey === event.laneKey &&
		row.first.endedAt !== undefined &&
		event.endedAt !== undefined &&
		(row.outcome ?? "ok") === "ok" &&
		(event.outcome ?? "ok") === "ok"
	);
}

function isNoOpSettledRoute(event: FlowEvent): boolean {
	return (
		event.kind === "route" &&
		event.endedAt !== undefined &&
		(event.outcome ?? "ok") === "ok" &&
		!event.evidence &&
		event.label === "route the turn"
	);
}

function isSettledOkTurn(event: FlowEvent): boolean {
	return event.kind === "turn" && event.endedAt !== undefined && (event.outcome ?? "ok") === "ok";
}

/**
 * The trace as rows, oldest first, and the row each event landed in (`rowOf[i]` for `flow[i]`).
 * Linear: suppression, turn absorption and row ownership are each one pass over precomputed neighbors,
 * which is exact because `flow` is ordered by start (an action after a turn in the list never began
 * before it, an action before it never began after it).
 */
export function foldFlow(
	flow: readonly FlowEvent[],
	look: SequenceLook,
): { readonly rows: FlowRow[]; readonly rowOf: number[] } {
	const count = flow.length;
	// A no-op route is suppressed when any later action is not one: a suffix flag from the back.
	const suppressedRoute = new Array<boolean>(count).fill(false);
	let realLater = false;
	for (let index = count - 1; index >= 0; index--) {
		const noOp = isNoOpSettledRoute(flow[index]!);
		suppressedRoute[index] = noOp && realLater;
		if (!noOp) realLater = true;
	}
	// The nearest action after each index that a turn may absorb: neither a suppressed route nor a turn.
	const absorbableAfter = new Array<number | undefined>(count).fill(undefined);
	let nearestAbsorbable: number | undefined;
	for (let index = count - 1; index >= 0; index--) {
		absorbableAfter[index] = nearestAbsorbable;
		if (!suppressedRoute[index] && flow[index]!.kind !== "turn") nearestAbsorbable = index;
	}
	// A settled ok turn absorbs the first action that began inside it: the nearest absorbable one after it,
	// else the first absorbable one before it that began at the same instant (an earlier start cannot lie inside).
	const turnInnerTarget = new Array<number | undefined>(count).fill(undefined);
	let tieStartedAt: number | undefined;
	let tieFirst: number | undefined;
	for (let index = 0; index < count; index++) {
		const event = flow[index]!;
		if (event.startedAt !== tieStartedAt) {
			tieStartedAt = event.startedAt;
			tieFirst = undefined;
		}
		if (isSettledOkTurn(event)) {
			const endedAt = event.endedAt!;
			const after = absorbableAfter[index];
			if (after !== undefined && flow[after]!.startedAt >= event.startedAt && flow[after]!.startedAt <= endedAt) {
				turnInnerTarget[index] = after;
			} else if (tieFirst !== undefined && event.startedAt <= endedAt) {
				turnInnerTarget[index] = tieFirst;
			}
		}
		if (tieFirst === undefined && !suppressedRoute[index] && event.kind !== "turn" && event.kind !== "prompt") {
			tieFirst = index;
		}
	}
	const rows: FlowRow[] = [];
	const rowOf = Array.from({ length: count }, () => 0);
	for (let index = 0; index < count; index++) {
		if (suppressedRoute[index] || turnInnerTarget[index] !== undefined) continue;
		const event = flow[index]!;
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
			rowOf[index] = rows.length - 1;
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
		rowOf[index] = rows.length - 1;
	}
	// The nearest owner of a row on each side of every index, for the suppressed routes that own none.
	const ownsRow = (index: number): boolean => !suppressedRoute[index] && turnInnerTarget[index] === undefined;
	const ownerAfter = new Array<number | undefined>(count).fill(undefined);
	let nearestOwner: number | undefined;
	for (let index = count - 1; index >= 0; index--) {
		ownerAfter[index] = nearestOwner;
		if (ownsRow(index)) nearestOwner = index;
	}
	let ownerBefore: number | undefined;
	for (let index = 0; index < count; index++) {
		const target = turnInnerTarget[index];
		if (target !== undefined) {
			rowOf[index] = rowOf[target]!;
		} else if (suppressedRoute[index]) {
			const owner = ownerAfter[index] ?? ownerBefore;
			// A suppressed route exists only because a later event is not one, and that event (or, for an
			// absorbed turn, the event it absorbed) always owns a row, so a row is always found.
			if (owner === undefined)
				throw new Error(`flow event ${flow[index]!.id} is suppressed but no event owns a row`);
			rowOf[index] = rowOf[owner]!;
		}
		if (ownsRow(index)) ownerBefore = index;
	}
	return { rows, rowOf };
}

/** Columns of one cell: the widest glyph of the glyph set, so a doubled ambiguous width keeps the grid. */
export function sequenceCellWidth(look: SequenceLook): number {
	const glyphs = [
		CARRIER_GLYPH,
		CLAIMED_GLYPH,
		...Object.values(BAR_GLYPH),
		...CANVAS_GLYPHS,
		...Object.values(look).map((entry) => entry.glyph),
	];
	return Math.max(1, ...glyphs.map((glyph) => visibleWidth(glyph)));
}

function liveTone(actor: FlowActor): ThemeColor {
	return actor === "system_one" ? SYSTEM_ONE_TONE : "accent";
}

function edgeTone(row: FlowRow, state: EdgeState): ThemeColor {
	if (state === "flight") return liveTone(row.first.actor);
	if (state === "claimed") return "dim";
	return outcomeTone(row.outcome);
}

function labelTone(row: FlowRow): ThemeColor {
	const event = row.first;
	if (event.endedAt === undefined) return liveTone(event.actor);
	if (row.outcome && row.outcome !== "ok") return OUTCOME_TONE[row.outcome];
	return event.actor === "system_one" ? SYSTEM_ONE_TONE : event.actor === "owner" ? "text" : "muted";
}

/**
 * The evidence a settled judgment carries, kept whole as the label's suffix: the result it reached,
 * then the short ledger handle of the row behind it (`label (result) #a1b2`).
 */
function evidenceSuffix(event: FlowEvent): string {
	const handle = event.evidence ? ` ${event.evidence}` : "";
	if (event.kind !== "judgment" || event.result === undefined || event.endedAt === undefined) return handle;
	return ` (${event.result})${handle}`;
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

function rowLabel(row: FlowRow, look: SequenceLook, nowMs: number, width: number, lifelineHasTag = false): string {
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
			`${mark}${kind.plural} ×${row.count} · avg ${formatCompactDuration(row.totalMs / row.count)} (${names})`,
			"",
			width,
		);
	}
	// A worker row's label is its lane name, which its lifeline already shows; a report names the lane
	// only when its lifeline title is not in view (tagged, folded into overflow, or no field at all).
	const text =
		event.kind === "worker"
			? event.endedAt === undefined
				? "running"
				: "work"
			: event.kind === "report" && !lifelineHasTag && event.result !== undefined
				? event.result
				: event.label;
	const evidence = evidenceSuffix(event);
	const lane = event.actor === "worker" && event.lane && event.kind !== "worker" && event.kind !== "report";
	const timed =
		event.endedAt === undefined
			? `  ${formatCompactDuration(nowMs - event.startedAt)}`
			: row.totalMs >= 1000
				? `  ${formatCompactDuration(row.totalMs)}`
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

/**
 * The degraded form for a width that cannot hold the lifelines at the minimum pitch beside a readable
 * label: no header, no field, no legend. Each row is its kind glyph and its label across the width,
 * with the lane named in the label because no lifeline shows it.
 */
function buildLabelsOnlyLayout(
	folded: readonly FlowRow[],
	options: { readonly width: number; readonly nowMs: number; readonly look: SequenceLook; readonly cellWidth: number },
): SequenceLayout {
	const { width, nowMs, look, cellWidth } = options;
	const rows = folded.map((row): SequenceRow => {
		const lead = `${look[row.first.kind].glyph} `;
		const label = `${lead}${rowLabel(row, look, nowMs, Math.max(0, width - visibleWidth(lead)), true)}`;
		return { first: row.first, last: row.last, count: row.count, label, labelTone: labelTone(row) };
	});
	return {
		cellWidth,
		pitch: 0,
		fieldCells: 0,
		labelCol: 0,
		labelWidth: width,
		lifelines: [],
		bars: [],
		header: [],
		legend: [],
		rows,
	};
}

export function buildSequenceLayout(
	flow: readonly FlowEvent[],
	options: { readonly width: number; readonly nowMs: number; readonly look: SequenceLook },
): SequenceLayout {
	const { width, nowMs, look } = options;
	const cellWidth = sequenceCellWidth(look);
	const { rows: folded, rowOf } = foldFlow(flow, look);

	// A worker lifeline is the event's lane key, the identity the trace recorded; the display name is
	// only what the lifeline's title shows.
	const workerKey = (event: FlowEvent): string => {
		if (event.laneKey === undefined)
			throw new Error(`flow event ${event.id} (${event.kind}) addresses a worker lane but carries no laneKey`);
		return `worker:${event.laneKey}`;
	};
	const sourceKey = (event: FlowEvent): string => (event.actor === "worker" ? workerKey(event) : event.actor);
	const targetKey = (event: FlowEvent): string | undefined =>
		event.to === undefined ? undefined : event.to === "worker" ? workerKey(event) : event.to;

	const lastSeen = new Map<string, number>();
	const workerKeys: string[] = [];
	const workerTitle = new Map<string, string>();
	flow.forEach((event, index) => {
		for (const key of [sourceKey(event), targetKey(event)]) {
			if (key === undefined || !key.startsWith("worker:")) continue;
			if (!lastSeen.has(key)) workerKeys.push(key);
			lastSeen.set(key, index);
			if (!workerTitle.has(key)) workerTitle.set(key, event.lane ?? event.laneKey!);
		}
	});

	// The label column never gets less than MIN_LABEL_WIDTH: the field shrinks first (workers merge into
	// the overflow lifeline), and when the fixed lifelines (plus the overflow lifeline, if there are
	// workers) do not fit at the minimum pitch there is no field at all.
	const fieldColumns = Math.min(Math.floor(width * FIELD_SHARE), width - LABEL_GAP - MIN_LABEL_WIDTH);
	const capCells = Math.floor(fieldColumns / cellWidth);
	const maxLifelines = Math.floor((capCells - 1) / MIN_PITCH) + 1;
	const fieldless = maxLifelines < FIXED_LIFELINES + (workerKeys.length > 0 ? 1 : 0);
	if (fieldless) return buildLabelsOnlyLayout(folded, { width, nowMs, look, cellWidth });
	const workerSlots = maxLifelines - FIXED_LIFELINES;
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
	const hiddenKeys = new Set(workerKeys.filter((key) => !visibleWorkers.has(key)));
	const hiddenCount = hiddenKeys.size;

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
						? workerTitle.get(key)!
						: FIXED_TITLE[key as Exclude<FlowActor, "worker">];
			const busy = key === "overflow" ? [...busyKeys].some((busyKey) => hiddenKeys.has(busyKey)) : busyKeys.has(key);
			const fits = visibleWidth(title) <= available;
			return { key, title, ...(fits ? {} : { tag: TAGS[index] ?? "*" }), cell: index * pitch, busy };
		});
		const indexByKey = new Map(list.map((lifeline, index) => [lifeline.key, index]));
		return {
			list,
			// Every key comes from a flow event: a shown lifeline, or a hidden worker that the overflow
			// lifeline stands for. Any other key is a broken invariant, not a lifeline to guess.
			indexOf: (key) => {
				const index = indexByKey.get(key) ?? (hiddenKeys.has(key) ? indexByKey.get("overflow") : undefined);
				if (index === undefined) throw new Error(`flow key ${key} has no lifeline`);
				return index;
			},
			pitch,
			fieldCells: (count - 1) * pitch + 1,
		};
	})();
	const { list: lifelines, pitch, fieldCells, indexOf } = lifelineModel;
	const labelCol = fieldCells * cellWidth + LABEL_GAP;
	const labelWidth = Math.max(0, width - labelCol);

	// Activation bars: a span of an action without a target covers the rows its lifeline stays busy.
	interface Bar {
		readonly kind: BarKind;
		readonly tone: ThemeColor;
		readonly order: number;
	}
	// Rows are ordered by start, so the last row an action's span reaches is a binary search.
	const rowStartedAt = folded.map((row) => row.first.startedAt);
	const lastRowStartedBy = (time: number): number => {
		let low = 0;
		let high = rowStartedAt.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if (rowStartedAt[middle]! <= time) low = middle + 1;
			else high = middle;
		}
		return low - 1;
	};
	const barRows: (Map<number, Bar> | undefined)[] = lifelines.map(() => undefined);
	flow.forEach((event, index) => {
		const target = targetKey(event);
		if (target !== undefined && target !== sourceKey(event)) return;
		const running = event.endedAt === undefined;
		const start = rowOf[index]!;
		const suppressed = folded[start]?.first.kind !== event.kind;
		if (suppressed && event.kind !== "turn") return;
		if (!running && !suppressed && (event.endedAt ?? 0) <= event.startedAt) return;
		if (!running && suppressed && (event.endedAt ?? 0) < event.startedAt) return;
		const end = running ? folded.length - 1 : Math.max(start, lastRowStartedBy(event.endedAt ?? 0));
		const firstRow = suppressed ? start : start + 1;
		if (end < firstRow) return;
		const lifeline = indexOf(sourceKey(event));
		// Waiting is claimed time, not work: its own bar kind whether or not it is still open.
		const bar: Bar =
			event.kind === "wait"
				? { kind: "wait", tone: "dim", order: start }
				: running
					? { kind: "live", tone: liveTone(event.actor), order: start }
					: { kind: "done", tone: outcomeTone(event.outcome), order: start };
		const column = barRows[lifeline] ?? new Map<number, Bar>();
		barRows[lifeline] = column;
		for (let row = firstRow; row <= end; row++) {
			const existing = column.get(row);
			if (!existing || existing.order <= start) column.set(row, bar);
		}
	});
	// Consecutive rows won by the same span become one run.
	const bars: SequenceBar[] = [];
	barRows.forEach((column, lifeline) => {
		if (!column) return;
		const covered = [...column.keys()].sort((x, y) => x - y);
		for (let at = 0; at < covered.length; ) {
			const fromRow = covered[at]!;
			const bar = column.get(fromRow)!;
			let toRow = fromRow;
			at++;
			while (at < covered.length && covered[at] === toRow + 1 && column.get(covered[at]!) === bar) {
				toRow++;
				at++;
			}
			bars.push({ cell: lifelines[lifeline]!.cell, fromRow, toRow, kind: bar.kind, tone: bar.tone });
		}
	});

	// A delegation to a worker still waiting for a slot is claimed, not proven.
	const queued = new Set(
		flow
			.filter((event) => event.kind === "wait" && event.laneKey !== undefined && event.endedAt === undefined)
			.map((event) => workerKey(event)),
	);

	const rows = folded.map((row): SequenceRow => {
		const event = row.first;
		const originLifeline = lifelines[indexOf(sourceKey(event))]!;
		const from = originLifeline.cell;
		const target = targetKey(event);
		const to = target === undefined ? from : lifelines[indexOf(target)]!.cell;
		const glyph = look[event.kind].glyph;
		const lifelineHasTag = originLifeline.tag !== undefined || originLifeline.key === "overflow";
		const label = rowLabel(row, look, nowMs, labelWidth, lifelineHasTag);
		if (to === from) {
			const tone = edgeTone(row, event.endedAt === undefined ? "flight" : "settled");
			return {
				first: event,
				last: row.last,
				count: row.count,
				mark: { cell: from, glyph, tone },
				label,
				labelTone: labelTone(row),
			};
		}
		const state: EdgeState =
			event.endedAt === undefined ? "flight" : queued.has(target ?? "") ? "claimed" : "settled";
		const tone = edgeTone(row, state);
		return {
			first: event,
			last: row.last,
			count: row.count,
			mark: { cell: from, glyph, tone },
			arrow: { from, to, state, tone },
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

	return { cellWidth, pitch, fieldCells, labelCol, labelWidth, lifelines, bars, header, legend, rows };
}
