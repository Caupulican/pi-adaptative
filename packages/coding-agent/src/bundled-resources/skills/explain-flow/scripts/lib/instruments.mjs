/**
 * Instruments: the views of a film that hold no item and have no port. Each shows the circuit's beat in another
 * notation, so the same moment reads in the circuit and beside it: a line of words or a table's row lights while the
 * station it names is busy. This module holds the one linking rule and, for each instrument, its reading, its shape
 * and its drawing; `scene.mjs` and `draw.mjs` only hand over to it.
 *
 * Words are lit one way everywhere: a soft wash behind them and a brighter ink. Never a solid bar, never colour alone.
 */

import { CHIP_RADIUS, LINE_STEP, roundText, SMALL_TEXT_SIZE, TEXT_SIZE, textWidth } from "./metrics.mjs";
import { isRecord, readText } from "./read.mjs";
import { alphaOf, lineEl, rectEl, strokeOf, words } from "./svg.mjs";

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
