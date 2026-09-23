/**
 * The Lanes view: the flow trace drawn as swimlanes, one column per actor (you, System One, root,
 * workers), time flowing down, one row per action. An action that hands something to another actor
 * draws an arrow across the lanes between them.
 *
 * Everything here is generic over the trace: one exhaustive table says how each kind of action
 * looks, and one rule folds a run of finished same-kind actions of one actor into a counted row with
 * the average time. A new kind of action fails the table's type until it is given a look; nothing
 * else in the view knows any specific behavior.
 */

import { truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import {
	FLOW_ACTORS,
	type FlowActor,
	type FlowEvent,
	type FlowKind,
	type FlowOutcome,
} from "../../../core/operator-projection/flow-trace.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { type DecisionGraphRows, formatGraphDuration, SYSTEM_ONE_TONE } from "./decision-graph-render.ts";

const LANE_TITLE: Readonly<Record<FlowActor, string>> = {
	owner: "you",
	system_one: "System One",
	root: "root",
	worker: "workers",
};

interface KindLook {
	readonly glyph: string;
	/** A run of finished actions of this kind folds into one counted row. */
	readonly folds: boolean;
	/** The folded row's noun ("tools ×6"). */
	readonly plural: string;
}

/** How each kind of action looks. Exhaustive: a new kind does not compile until it has a look. */
const KIND_LOOK: Readonly<Record<FlowKind, KindLook>> = {
	prompt: { glyph: "›", folds: false, plural: "prompts" },
	turn: { glyph: "●", folds: false, plural: "turns" },
	reply: { glyph: "·", folds: false, plural: "replies" },
	tool: { glyph: "▸", folds: true, plural: "tools" },
	background: { glyph: "▸", folds: false, plural: "background tools" },
	route: { glyph: "◇", folds: true, plural: "routes" },
	judgment: { glyph: "◆", folds: true, plural: "judgments" },
	delegate: { glyph: "›", folds: false, plural: "delegations" },
	worker: { glyph: "●", folds: false, plural: "workers" },
	report: { glyph: "‹", folds: false, plural: "reports" },
	question: { glyph: "?", folds: false, plural: "questions" },
	answer: { glyph: "›", folds: false, plural: "answers" },
	notice: { glyph: "·", folds: true, plural: "notices" },
	compaction: { glyph: "↺", folds: false, plural: "compactions" },
	retry: { glyph: "↺", folds: true, plural: "retries" },
	wait: { glyph: "○", folds: false, plural: "waits" },
};

/** Hue is state: live is accent, a failure red, a result needing review amber, the rest recedes. */
const OUTCOME_TONE: Readonly<Record<FlowOutcome, ThemeColor>> = {
	ok: "muted",
	failed: "error",
	cancelled: "dim",
	attention: "warning",
};

/** A row: one action, or a run of finished same-kind actions of one actor folded together. */
interface FlowRow {
	readonly first: FlowEvent;
	readonly count: number;
	readonly totalMs: number;
	readonly labels: readonly string[];
	readonly outcome?: FlowOutcome;
}

function foldable(row: FlowRow, event: FlowEvent): boolean {
	const look = KIND_LOOK[event.kind];
	return (
		look.folds &&
		row.first.kind === event.kind &&
		row.first.actor === event.actor &&
		row.first.lane === event.lane &&
		row.first.endedAt !== undefined &&
		event.endedAt !== undefined &&
		(row.outcome ?? "ok") === "ok" &&
		(event.outcome ?? "ok") === "ok"
	);
}

/** The trace as rows, oldest first: consecutive finished same-kind actions of one actor fold. */
export function flowRows(flow: readonly FlowEvent[]): FlowRow[] {
	const rows: FlowRow[] = [];
	for (const event of flow) {
		const duration = event.endedAt !== undefined ? Math.max(0, event.endedAt - event.startedAt) : 0;
		const previous = rows.at(-1);
		if (previous && foldable(previous, event)) {
			rows[rows.length - 1] = {
				...previous,
				count: previous.count + 1,
				totalMs: previous.totalMs + duration,
				labels: previous.labels.includes(event.label) ? previous.labels : [...previous.labels, event.label],
			};
			continue;
		}
		rows.push({
			first: event,
			count: 1,
			totalMs: duration,
			labels: [event.label],
			...(event.outcome ? { outcome: event.outcome } : {}),
		});
	}
	return rows;
}

function rowText(row: FlowRow, nowMs: number): string {
	const look = KIND_LOOK[row.first.kind];
	const glyph = row.first.kind === "report" ? reportGlyph(row.outcome) : look.glyph;
	const lane = row.first.lane && row.first.actor === "worker" ? `${row.first.lane}: ` : "";
	if (row.count > 1) {
		const names = row.labels.slice(0, 3).join(", ");
		return `${glyph} ${look.plural} ×${row.count} · avg ${formatGraphDuration(row.totalMs / row.count)} (${names})`;
	}
	const running = row.first.endedAt === undefined;
	const timed = running
		? `  ${formatGraphDuration(nowMs - row.first.startedAt)}`
		: row.totalMs >= 1000
			? `  ${formatGraphDuration(row.totalMs)}`
			: "";
	const label = row.first.kind === "worker" ? row.first.label : `${lane}${row.first.label}`;
	return `${glyph} ${label}${timed}`;
}

function reportGlyph(outcome: FlowOutcome | undefined): string {
	return outcome === "ok" ? "✓" : outcome === "attention" ? "?" : "✗";
}

function rowTone(row: FlowRow): ThemeColor | undefined {
	if (row.first.endedAt === undefined) return row.first.actor === "system_one" ? SYSTEM_ONE_TONE : "accent";
	if (row.outcome && row.outcome !== "ok") return OUTCOME_TONE[row.outcome];
	return row.first.actor === "system_one" ? SYSTEM_ONE_TONE : row.first.actor === "owner" ? "text" : "muted";
}

/** Column bounds for the lanes at `width`: equal lanes, one-column rules between them. */
function laneColumns(width: number): { start: number; width: number }[] {
	const lanes = FLOW_ACTORS.length;
	const usable = Math.max(lanes, width - (lanes - 1));
	const base = Math.floor(usable / lanes);
	const columns: { start: number; width: number }[] = [];
	let start = 0;
	for (let index = 0; index < lanes; index++) {
		const size = index === lanes - 1 ? usable - base * (lanes - 1) : base;
		columns.push({ start, width: size });
		start += size + 1;
	}
	return columns;
}

function cell(text: string, size: number): string {
	const fitted = truncateToWidth(text, Math.max(0, size), "…");
	return fitted + " ".repeat(Math.max(0, size - visibleWidth(fitted)));
}

export function renderFlowLanes(flow: readonly FlowEvent[], width: number, nowMs: number): DecisionGraphRows {
	const columns = laneColumns(width);
	const laneIndex = (actor: FlowActor) => FLOW_ACTORS.indexOf(actor);
	const rule = theme.fg("dim", "│");
	const busy = new Set(flow.filter((event) => event.endedAt === undefined).map((event) => event.actor));
	const header = FLOW_ACTORS.map((actor, index) => {
		const title = cell(LANE_TITLE[actor], columns[index]!.width);
		return busy.has(actor) ? theme.bold(theme.fg("accent", title)) : theme.fg("muted", title);
	}).join(rule);
	const divider = theme.fg("dim", columns.map((column) => "─".repeat(column.width)).join("┼"));
	const rows = [header, divider];
	const composed = flowRows(flow);
	if (composed.length === 0) {
		rows.push(theme.fg("dim", cell("no activity yet · the lanes fill as work happens", width)));
		return { rows, stageAt: rows.map(() => undefined), currentRow: 0, focusKey: "flow:empty" };
	}
	for (const row of composed) {
		const from = laneIndex(row.first.actor);
		const to = row.first.to !== undefined ? laneIndex(row.first.to) : undefined;
		const tone = rowTone(row);
		const cells = columns.map((column) => " ".repeat(column.width));
		cells[from] = cell(rowText(row, nowMs), columns[from]!.width);
		// An arrow crosses the lanes between the actor and the one it hands over to.
		if (to !== undefined && to !== from) {
			const [low, high] = to > from ? [from + 1, to] : [to, from - 1];
			for (let index = low; index <= high; index++) {
				const size = columns[index]!.width;
				if (index === to) cells[index] = to > from ? `▶${" ".repeat(size - 1)}` : `${"─".repeat(size - 1)}◀`;
				else cells[index] = "─".repeat(size);
			}
		}
		const painted = cells.map((text, index) => {
			if (index === from) return tone ? theme.fg(tone, text) : text;
			return theme.fg("dim", text);
		});
		rows.push(painted.join(rule));
	}
	const last = composed.at(-1)!;
	return {
		rows,
		stageAt: rows.map(() => undefined),
		currentRow: rows.length - 1,
		focusKey: `flow:${last.first.id}:${last.count}`,
	};
}
