/**
 * Instruments: the views of a film that hold no item and have no port. Each shows the circuit's beat in another
 * notation, so the same moment reads in the circuit and beside it: a line of words or a table's row lights while the
 * station it names is busy. This module holds the one linking rule and, for each instrument, its reading, its shape
 * and its drawing; `scene.mjs` and `draw.mjs` only hand over to it.
 *
 * Words are lit one way everywhere: a soft wash behind them and a brighter ink. Never a solid bar, never colour alone.
 */

import { px } from "./geometry.mjs";
import { CHIP_RADIUS, LINE_STEP, roundText, SMALL_TEXT_SIZE, TEXT_SIZE, textWidth } from "./metrics.mjs";
import { isRecord, readNumber, readText } from "./read.mjs";
import { alphaOf, circleEl, lineEl, pathEl, rectEl, strokeOf, words } from "./svg.mjs";
import { trialKeptAt, trialOutcome } from "./trial.mjs";

/** The text sizes a note may take, in grid units: weight and ink carry the hierarchy, so they stay close. */
export const NOTE_SIZES = { text: TEXT_SIZE, lede: 2.25, title: 3 };
/** The stations a linked line or row can name: the ones that are busy at some time. */
const LINKABLE_KINDS = ["source", "queue", "worker", "trial", "rail"];
/** How long a linked thing takes to light and to go quiet, so nothing snaps. */
const LINK_BLEND_SECONDS = 0.28;
const WASH_OPACITY = 0.14;
/** The room a table keeps between two columns, in grid units. */
const COLUMN_GAP = 3;
const MAX_TABLE_COLUMNS = 4;
const MAX_TABLE_ROWS = 8;
/** How long the newest point of a series keeps its ring, in seconds. */
const NEW_POINT_SECONDS = 1.4;
/** The rows a series keeps over its plot (the measure's name) and under it (the rounds' numbers), in grid units. */
const SERIES_HEAD = 2.4;
const SERIES_FOOT = 2.6;

/**
 * How strongly a station is busy at this instant, from 0 to 1: a queue, a worker or a trial while it holds an item, a
 * source while its emitters pulse, a rail while the ring of a landing shows. Every linked view asks this one question.
 */
export function busyStrength(state, node) {
	if (node.kind === "source") {
		let strength = 0;
		for (const [key, pulse] of state.pulses)
			if (key.startsWith(`${node.id}:`)) strength = Math.max(strength, pulse.strength);
		return strength;
	}
	if (node.kind === "rail") {
		const ring = state.rails.get(node.id)?.ring;
		return ring === undefined ? 0 : 1 - ring;
	}
	let strength = 0;
	for (const stay of state.stays.get(node.id) ?? [])
		strength = Math.max(strength, Math.min(1, stay.since / LINK_BLEND_SECONDS, stay.left / LINK_BLEND_SECONDS));
	return strength;
}

/** The station a `when` names, as written: resolved to a station once every station is read. */
function readWhen(value, path, problems) {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value === "") {
		problems.push(`${path}: must be the id of a station`);
		return undefined;
	}
	return value;
}

/**
 * A note's lines: each a text, or a text with the station it follows (`{ "text", "when" }`). Returns the texts and,
 * beside them, the station ids, so a note with no link is exactly the list of texts it always was.
 */
export function readLinkedLines(raw, path, problems, max) {
	const texts = [];
	const links = [];
	if (raw === undefined) return { texts, links };
	const list = typeof raw === "string" ? [raw] : raw;
	if (!Array.isArray(list) || list.length > max) {
		problems.push(`${path}: must be a list of at most ${max} lines of text`);
		return { texts, links };
	}
	for (const [index, entry] of list.entries()) {
		const at = `${path}[${index}]`;
		const text = readText(isRecord(entry) ? entry.text : entry, isRecord(entry) ? `${at}.text` : at, problems, true);
		if (text === undefined) continue;
		texts.push(text);
		links.push(isRecord(entry) ? readWhen(entry.when, `${at}.when`, problems) : undefined);
	}
	return { texts, links };
}

/** A table's columns and rows from a spec. A row is `{ "cells", "when" }`; `numbered` adds a column of row numbers. */
export function readTable(raw, node, path, problems) {
	const columns = Array.isArray(raw.columns) ? raw.columns : raw.columns === undefined ? [] : undefined;
	if (columns === undefined || columns.length > MAX_TABLE_COLUMNS)
		problems.push(`${path}.columns: must be a list of at most ${MAX_TABLE_COLUMNS} header words`);
	node.columns = (columns ?? [])
		.slice(0, MAX_TABLE_COLUMNS)
		.map((entry, index) => readText(entry, `${path}.columns[${index}]`, problems, true) ?? "");
	node.numbered = raw.numbered === true;
	if (raw.numbered !== undefined && typeof raw.numbered !== "boolean") problems.push(`${path}.numbered: must be true or false`);
	node.rows = [];
	const rows = Array.isArray(raw.rows) ? raw.rows : [];
	if (rows.length === 0 || rows.length > MAX_TABLE_ROWS)
		problems.push(`${path}.rows: a table has 1 to ${MAX_TABLE_ROWS} rows`);
	for (const [index, row] of rows.slice(0, MAX_TABLE_ROWS).entries()) {
		const at = `${path}.rows[${index}]`;
		const cells = isRecord(row) && Array.isArray(row.cells) ? row.cells : undefined;
		const widest = node.columns.length > 0 ? node.columns.length : MAX_TABLE_COLUMNS;
		if (cells === undefined || cells.length === 0 || cells.length > widest) {
			problems.push(`${at}.cells: must be a list of 1 to ${widest} texts${node.columns.length > 0 ? ", one per column at most" : ""}`);
			continue;
		}
		node.rows.push({
			cells: cells.map((cell, column) => readText(cell, `${at}.cells[${column}]`, problems, true) ?? ""),
			when: readWhen(row.when, `${at}.when`, problems),
		});
	}
}

/**
 * Resolves every `when` of the scene's notes and tables to the station it names, once all stations are read. A name
 * that is no station, or a station that is never busy (a sweep, a chain, a tally, a note, a table), is a problem.
 */
export function resolveLinks(scene, problems) {
	const find = (id, path) => {
		if (id === undefined) return undefined;
		const target = scene.nodes.find((node) => node.id === id);
		if (!target) problems.push(`${path}: "${id}" names no station`);
		else if (!LINKABLE_KINDS.includes(target.kind))
			problems.push(`${path}: a ${target.kind} is never busy; name a source, a queue, a worker, a trial or a rail`);
		else return target;
		return undefined;
	};
	for (const [index, node] of scene.nodes.entries()) {
		if (node.kind === "note") node.links = node.links.map((id, line) => find(id, `nodes[${index}].lines[${line}].when`));
		if (node.kind === "table")
			for (const [line, row] of node.rows.entries()) row.when = find(row.when, `nodes[${index}].rows[${line}].when`);
		if (node.kind === "series" && node.of !== undefined) {
			const trial = scene.nodes.find((other) => other.id === node.of);
			if (trial?.kind !== "trial") problems.push(`nodes[${index}].of: "${node.of}" names no trial`);
			node.of = trial?.kind === "trial" ? trial : undefined;
		}
	}
}

/** Whether a note or a table lights with the circuit, so its words belong to the live layer. */
export function isLinked(node) {
	if (node.kind === "note") return node.links.some((link) => link !== undefined);
	return node.kind === "table";
}

/** The soft wash behind lit words: a rounded rectangle in the work colour, as strong as the station is busy. */
function wash(scene, x, y, w, h, strength) {
	if (strength <= 0.01) return "";
	return rectEl({ x, y, w, h }, CHIP_RADIUS * scene.unit, `fill="${scene.theme.work}" opacity="${alphaOf(WASH_OPACITY * strength)}"`);
}

/** The ink of words that can light: the quiet ink at rest, the text ink once the wash is half up. */
function inkOf(scene, strength, rest) {
	return strength > 0.5 ? scene.theme.text : rest;
}

/**
 * A note's lines. A plain note is its words in the quiet ink, exactly as it always was; a `lede` or a `title` is in the
 * text ink at its size; a linked line gets the wash and the text ink while its station is busy. `state` is absent in
 * the still layer, where nothing is lit.
 */
export function noteLines(scene, node, round, state) {
	const u = scene.unit;
	const { box } = node.shape;
	const scale = node.size === "text" ? 1 : NOTE_SIZES[node.size] / TEXT_SIZE;
	const size = TEXT_SIZE * u * scale;
	const step = LINE_STEP * u * scale;
	const rest = node.size === "text" ? scene.theme.dim : scene.theme.text;
	let out = "";
	for (const [index, text] of node.lines.entries()) {
		const link = node.links[index];
		const strength = link && state ? busyStrength(state, link) : 0;
		const shown = roundText(text, round);
		const baseline = box.y + (index + 0.75) * step;
		if (link) out += wash(scene, box.x - 0.5 * u, baseline - step * 0.66, textWidth(shown, size) + u, step - 0.5 * u, strength);
		out += words(scene, box.x, baseline, size, [{ text: shown, fill: inkOf(scene, strength, rest), bold: node.size === "title" }]);
	}
	return out;
}

/** The columns of a table in pixels: each as wide as its widest cell or header, with the gap between them. */
function tableColumns(node, u, rounds) {
	const count = Math.max(node.columns.length, ...node.rows.map((row) => row.cells.length));
	const number = node.numbered ? textWidth(String(node.rows.length), TEXT_SIZE * u) + 1.5 * u : 0;
	const lefts = [];
	let cursor = number;
	for (let column = 0; column < count; column++) {
		lefts.push(cursor);
		const widest = Math.max(
			textWidth(node.columns[column] ?? "", SMALL_TEXT_SIZE * u, rounds),
			...node.rows.map((row) => textWidth(row.cells[column] ?? "", TEXT_SIZE * u, rounds)),
		);
		cursor += widest + COLUMN_GAP * u;
	}
	return { lefts, width: cursor - COLUMN_GAP * u };
}

/** The box and inner geometry of a table: an optional header with its rule, then one line per row. No box, no port. */
export function shapeTable(node, x, y, u, rounds) {
	const { lefts, width } = tableColumns(node, u, rounds);
	const header = node.columns.length > 0 ? 3 * u : 0;
	const step = LINE_STEP * u;
	return {
		box: { x, y, w: width, h: header + node.rows.length * step },
		lefts: lefts.map((left) => x + left),
		header,
		step,
		ports: {},
	};
}

/** A table's still part: its header in the small quiet ink and the one rule under it. */
export function tableBody(scene, node) {
	const u = scene.unit;
	const { shape } = node;
	if (shape.header === 0) return "";
	let out = "";
	for (const [column, text] of node.columns.entries())
		out += words(scene, shape.lefts[column], shape.box.y + 1.6 * u, SMALL_TEXT_SIZE * u, [{ text, fill: scene.theme.dim }]);
	const rule = shape.box.y + shape.header - 0.6 * u;
	return out + lineEl(shape.box.x, rule, shape.box.x + shape.box.w, rule, `${strokeOf(scene.theme.line, u * 0.12)} opacity="0.7"`);
}

/** A table's rows: the first column in the text ink, the rest quiet; a row lights while its station is busy. */
export function tableRows(scene, node, round, state) {
	const u = scene.unit;
	const { shape } = node;
	const size = TEXT_SIZE * u;
	let out = "";
	for (const [index, row] of node.rows.entries()) {
		const strength = row.when && state ? busyStrength(state, row.when) : 0;
		const baseline = shape.box.y + shape.header + (index + 0.75) * shape.step;
		out += wash(scene, shape.box.x - 0.5 * u, baseline - shape.step * 0.66, shape.box.w + u, shape.step - 0.5 * u, strength);
		if (node.numbered) out += words(scene, shape.box.x, baseline, size, [{ text: String(index + 1), fill: inkOf(scene, strength, scene.theme.dim) }]);
		for (const [column, cell] of row.cells.entries())
			out += words(scene, shape.lefts[column], baseline, size, [
				{ text: roundText(cell, round), fill: column === 0 ? scene.theme.text : inkOf(scene, strength, scene.theme.dim) },
			]);
	}
	return out;
}

/**
 * A series from a spec: one measure with one point per round. Its numbers come from a trial (`of`: the kept score of
 * each round, the other candidates as quiet dots, and the best so far as a step line) or from the spec (`values`).
 */
export function readSeries(raw, node, path, problems, rounds) {
	node.of = typeof raw.of === "string" ? raw.of : undefined;
	const values = Array.isArray(raw.values) ? raw.values : undefined;
	if ((node.of === undefined) === (values === undefined) || (raw.of !== undefined && node.of === undefined))
		problems.push(`${path}: a series has one source of numbers: "of" (a trial's id) or "values" (one number per round)`);
	if (values !== undefined && (values.length !== rounds || values.some((value) => typeof value !== "number" || !Number.isFinite(value)))) {
		problems.push(`${path}.values: must hold ${rounds} number(s), one per round`);
		node.values = undefined;
	} else node.values = values;
	node.plotW = readNumber(raw.w, `${path}.w`, problems, { min: 16, max: 80, fallback: 30 });
	node.plotH = readNumber(raw.h, `${path}.h`, problems, { min: 8, max: 30, fallback: 12 });
	node.axis = readText(raw.axis, `${path}.axis`, problems);
	node.base = raw.base === undefined ? undefined : readNumber(raw.base, `${path}.base`, problems, { min: -1e9, max: 1e9 });
	node.baseWords = readText(raw.baseWords, `${path}.baseWords`, problems);
	const known = [...(node.values ?? []), ...(node.base === undefined ? [] : [node.base])];
	const low = node.of !== undefined || known.length === 0 ? 0 : Math.min(...known);
	const high = node.of !== undefined || known.length === 0 ? 1 : Math.max(...known);
	node.floor = raw.floor === undefined ? low : readNumber(raw.floor, `${path}.floor`, problems, { min: -1e9, max: 1e9 });
	node.ceiling = raw.ceiling === undefined ? high : readNumber(raw.ceiling, `${path}.ceiling`, problems, { min: -1e9, max: 1e9 });
	if (!(node.ceiling > node.floor)) {
		if (raw.floor !== undefined || raw.ceiling !== undefined) problems.push(`${path}: "ceiling" must be over "floor"`);
		node.ceiling = node.floor + 1;
	}
}

/** The box and the plot of a series: the measure's name over the plot, the rounds' numbers under it. No port. */
export function shapeSeries(node, x, y, u) {
	const plot = { x, y: y + SERIES_HEAD * u, w: node.plotW * u, h: node.plotH * u };
	return { box: { x, y, w: plot.w, h: plot.h + (SERIES_HEAD + SERIES_FOOT) * u }, plot, ports: {} };
}

/** Where a value and a round stand in a series' plot. */
function seriesPlace(node, rounds) {
	const { plot } = node.shape;
	const column = plot.w / rounds;
	return {
		x: (round) => plot.x + (round + 0.5) * column,
		y: (value) => plot.y + plot.h * (1 - Math.min(1, Math.max(0, (value - node.floor) / (node.ceiling - node.floor)))),
		column,
	};
}

/** A series' still part: its two axes as one hairline each, the measure's name, and the level of `base` with its words. */
export function seriesBody(scene, node) {
	const u = scene.unit;
	const { theme } = scene;
	const { plot } = node.shape;
	const hairline = `${strokeOf(theme.line, u * 0.1)} opacity="0.9"`;
	let out = lineEl(plot.x, plot.y, plot.x, plot.y + plot.h, hairline) + lineEl(plot.x, plot.y + plot.h, plot.x + plot.w, plot.y + plot.h, hairline);
	if (node.axis) out += words(scene, plot.x, plot.y - 0.9 * u, SMALL_TEXT_SIZE * u, [{ text: node.axis, fill: theme.dim }]);
	if (node.base !== undefined) {
		const level = seriesPlace(node, scene.rounds).y(node.base);
		// A solid hairline: in this film a dashed line means "built, not proven".
		out += lineEl(plot.x, level, plot.x + plot.w, level, `${strokeOf(theme.dim, u * 0.1)} opacity="0.7"`);
		if (node.baseWords) out += words(scene, plot.x + plot.w, level - 0.6 * u, SMALL_TEXT_SIZE * u, [{ text: node.baseWords, fill: theme.dim }], "end");
	}
	return out;
}

/** The rounds a series shows at this instant, oldest first: each with its value and how long it has been shown. */
function seriesRounds(scene, node, state) {
	const shownAt = node.of ? trialKeptAt(scene, node.of) : 0;
	if (shownAt === undefined) return [];
	const shown = [];
	for (let round = 0; round <= state.round; round++) {
		const since = (state.round - round) * scene.loop + state.now - shownAt;
		if (since < 0) continue;
		const outcome = node.of ? trialOutcome(scene, node.of, round) : undefined;
		shown.push({ round, since, outcome, value: outcome ? outcome.scores[outcome.kept] : node.values[round] });
	}
	return shown;
}

/**
 * What a series shows now: a point for every round that has reached its number, the quiet dots of the candidates that
 * were not kept, the line (the best so far as steps for a trial, the points joined for given values), the newest
 * point's value beside it, and the rounds' numbers under the plot.
 */
export function seriesLive(scene, node, state) {
	const u = scene.unit;
	const { theme } = scene;
	const { plot } = node.shape;
	const place = seriesPlace(node, scene.rounds);
	const shown = seriesRounds(scene, node, state);
	let out = "";
	for (let round = 0; round < scene.rounds; round++)
		out += words(scene, place.x(round), plot.y + plot.h + 1.9 * u, SMALL_TEXT_SIZE * u, [{ text: String(round + 1), fill: round === state.round ? theme.text : theme.dim }], "middle");
	if (shown.length === 0) return out;
	// The other candidates of each round: quiet dots, spread a little sideways so they do not hide each other.
	for (const entry of shown) {
		if (!entry.outcome) continue;
		const count = entry.outcome.scores.length;
		const spread = Math.min(place.column * 0.5, 3 * u);
		for (const [index, score] of entry.outcome.scores.entries()) {
			if (index === entry.outcome.kept) continue;
			const x = place.x(entry.round) + (index / (count - 1) - 0.5) * spread;
			out += circleEl(x, place.y(score), 0.4 * u, `fill="${theme.dim}" opacity="0.5"`);
		}
	}
	// The line: for a trial the best kept score so far, flat across a round and stepping where a round beat it.
	const better = (a, b) => (node.of?.keep === "lowest" ? a < b : a > b);
	let best;
	let path = "";
	for (const [index, entry] of shown.entries()) {
		const x = place.x(entry.round);
		if (node.of) {
			const level = best === undefined || better(entry.value, best) ? entry.value : best;
			path += index === 0 ? `M${px(x)} ${px(place.y(level))}` : `H${px(x)}V${px(place.y(level))}`;
			best = level;
		} else path += `${index === 0 ? "M" : "L"}${px(x)} ${px(place.y(entry.value))}`;
	}
	out += pathEl(path, strokeOf(theme.text, u * 0.2, 'stroke-linejoin="round" stroke-linecap="round"'));
	const newest = shown[shown.length - 1];
	for (const entry of shown) {
		const isNewest = entry === newest;
		const x = place.x(entry.round);
		const y = place.y(entry.value);
		// A ring in the surface colour keeps a point clear where it meets the line or another point.
		out += circleEl(x, y, 0.5 * u, `fill="${isNewest ? theme.ok : theme.text}" stroke="${theme.bg}" stroke-width="${px(u * 0.2)}"`);
		if (!isNewest) continue;
		if (entry.since < NEW_POINT_SECONDS) {
			const ring = entry.since / NEW_POINT_SECONDS;
			out += circleEl(x, y, (0.9 + 1.6 * ring) * u, `${strokeOf(theme.ok, u * 0.16)} opacity="${alphaOf((1 - ring) * 0.9)}"`);
		}
		// Only the newest point says its value, in the text ink, placed so it stays inside the plot and off the base's words.
		const value = node.of ? entry.value.toFixed(2) : String(entry.value);
		const wide = textWidth(value, SMALL_TEXT_SIZE * u);
		const baseline = y + (y - plot.y < 2 * u ? 1.8 : -0.9) * u;
		const level = node.base === undefined ? undefined : place.y(node.base);
		const baseLeft = plot.x + plot.w - textWidth(node.baseWords ?? "", SMALL_TEXT_SIZE * u) - u;
		const meetsBase = level !== undefined && node.baseWords !== undefined && x + 1.2 * u + wide > baseLeft && Math.abs(baseline - (level - 0.6 * u)) < 2 * u;
		const right = !meetsBase && x + 1.2 * u + wide <= plot.x + plot.w;
		out += words(scene, x + (right ? 1.2 : -1.2) * u, baseline, SMALL_TEXT_SIZE * u, [{ text: value, fill: theme.text }], right ? "start" : "end");
	}
	return out;
}

/** The words a tally by rounds writes under its boxes, one per box, with the widest of them. */
export function tallyMarks(node, rounds) {
	if (node.marks === undefined) return { texts: [], widest: "" };
	const texts = Array.from({ length: rounds }, (_, round) => roundText(node.marks, round));
	return { texts, widest: texts.reduce((widest, text) => (text.length > widest.length ? text : widest), "") };
}

/**
 * A tally by rounds, over its boxes: the rounds that are over are crossed, the round in hand is lit, and each box's
 * words stand under it, the current one in the text ink.
 */
export function tallyRounds(scene, node, state) {
	const u = scene.unit;
	const { theme } = scene;
	const { texts } = tallyMarks(node, scene.rounds);
	let out = "";
	for (const [index, cell] of node.shape.boxes.entries()) {
		if (index < state.round) {
			const cross = strokeOf(theme.dim, u * 0.15);
			out += lineEl(cell.x + 0.4 * u, cell.y + 0.4 * u, cell.x + cell.w - 0.4 * u, cell.y + cell.h - 0.4 * u, cross);
			out += lineEl(cell.x + cell.w - 0.4 * u, cell.y + 0.4 * u, cell.x + 0.4 * u, cell.y + cell.h - 0.4 * u, cross);
		} else if (index === state.round)
			out += rectEl(cell, 0.3 * u, `fill="${theme.work}" fill-opacity="${WASH_OPACITY}" stroke="${theme.work}" stroke-width="${px(u * 0.16)}"`);
		if (texts[index])
			out += words(scene, cell.x + cell.w / 2, cell.y + cell.h + 1.7 * u, 1.2 * u, [{ text: texts[index].toUpperCase(), fill: index === state.round ? theme.text : theme.dim }], "middle");
	}
	return out;
}
