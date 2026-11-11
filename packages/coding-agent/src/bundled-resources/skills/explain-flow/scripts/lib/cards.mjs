/**
 * The `card` station: a boxed station of structured lines that sits in the circuit with ports on every side. It serves
 * three roles without multiplying station kinds: a live input trigger (`cursor: true`), a procedure or code block whose
 * lines light by phase or linked station, and a result collector (`collectFrom`) whose rows appear as a `batch` finds hits.
 */

import { batchHitSchedule, batchPlanFor } from "./batch.mjs";
import { fadeIn, px } from "./geometry.mjs";
import { busyStrength, readWhen, resolveWhenTarget } from "./instruments.mjs";
import { boxPorts, CHIP_RADIUS, LINE_STEP, roundText, SMALL_TEXT_SIZE, STATION_RADIUS, TEXT_SIZE, textWidth } from "./metrics.mjs";
import { isRecord, readNumber, readOneOf, readText, readTextList } from "./read.mjs";
import { alphaOf, lineEl, rectEl, strokeOf, words } from "./svg.mjs";

const CARD_TONES = ["work", "ok", "fail", "info", "text"];
const CARD_PAD_X = 1.6;
const CARD_PAD_Y = 1.2;
const CARD_HEADER_H = 2.6;
const CARD_SEP_GAP = 1.0;
const MAX_CARD_LINES = 8;
const MAX_CARD_TEXT = 96;

/** Preserves leading indentation (turning tabs into two spaces) so code and structured clauses keep their alignment. */
function readPreservedLine(value, path, problems) {
	if (typeof value !== "string" || value.trim() === "" || value.length > MAX_CARD_TEXT) {
		problems.push(`${path}: must be text of 1 to ${MAX_CARD_TEXT} characters`);
		return undefined;
	}
	return value.replace(/\t/g, "  ").replace(/[\r\n]+/g, " ").trimEnd();
}

/** Splits `text` so substrings listed in `emphasis` render bold in `strongFill` while keeping exact monospace advance. */
function cardSpans(text, emphasis, baseFill, strongFill, boldAll) {
	if (!emphasis || emphasis.length === 0) return [{ text, fill: baseFill, bold: boldAll }];
	const parts = [];
	let cursor = 0;
	while (cursor < text.length) {
		let bestAt = -1;
		let bestToken = "";
		for (const token of emphasis) {
			if (!token) continue;
			const found = text.indexOf(token, cursor);
			if (found >= 0 && (bestAt < 0 || found < bestAt || (found === bestAt && token.length > bestToken.length))) {
				bestAt = found;
				bestToken = token;
			}
		}
		if (bestAt < 0) {
			parts.push({ text: text.slice(cursor), fill: baseFill, bold: boldAll });
			break;
		}
		if (bestAt > cursor) parts.push({ text: text.slice(cursor, bestAt), fill: baseFill, bold: boldAll });
		parts.push({ text: bestToken, fill: strongFill, bold: true });
		cursor = bestAt + bestToken.length;
	}
	return parts;
}

/** Reads a `card` station's fields from a spec. */
export function readCard(raw, node, path, problems) {
	node.cardW = raw.w === undefined ? undefined : readNumber(raw.w, `${path}.w`, problems, { min: 8, max: 120 });
	node.cardRows = raw.rows === undefined ? undefined : readNumber(raw.rows, `${path}.rows`, problems, { min: 1, max: MAX_CARD_LINES, integer: true });
	node.header = readText(raw.header, `${path}.header`, problems);
	node.cursor = raw.cursor === true;
	if (raw.cursor !== undefined && typeof raw.cursor !== "boolean") problems.push(`${path}.cursor: must be true or false`);
	node.collectFrom = readText(raw.collectFrom, `${path}.collectFrom`, problems);
	node.unitSingular = readText(raw.unitSingular, `${path}.unitSingular`, problems) ?? "match";
	node.unitPlural = readText(raw.unitPlural, `${path}.unitPlural`, problems) ?? "matches";
	node.lines = [];
	if (raw.lines !== undefined) {
		const list = typeof raw.lines === "string" ? [raw.lines] : raw.lines;
		if (!Array.isArray(list) || list.length > MAX_CARD_LINES) {
			problems.push(`${path}.lines: must be a list of at most ${MAX_CARD_LINES} lines`);
		} else {
			for (const [index, entry] of list.entries()) {
				const atPath = `${path}.lines[${index}]`;
				if (typeof entry === "string") {
					const text = readPreservedLine(entry, atPath, problems);
					if (text !== undefined) node.lines.push({ text, emphasis: [], bold: false, dim: false, sep: false });
					continue;
				}
				if (!isRecord(entry)) {
					problems.push(`${atPath}: must be text or a line object`);
					continue;
				}
				const text = readPreservedLine(entry.text, `${atPath}.text`, problems);
				if (text === undefined) continue;
				let phase;
				if (entry.phase !== undefined) {
					if ((typeof entry.phase === "number" && Number.isInteger(entry.phase) && entry.phase >= 0) || (typeof entry.phase === "string" && entry.phase !== ""))
						phase = entry.phase;
					else problems.push(`${atPath}.phase: must be a phase index (0, 1, ...) or phase name`);
				}
				node.lines.push({
					text,
					emphasis: readTextList(entry.emphasis, `${atPath}.emphasis`, problems, 6),
					bold: entry.bold === true,
					dim: entry.dim === true,
					sep: entry.sep === true,
					phase,
					when: readWhen(entry.when, `${atPath}.when`, problems),
					tone: readOneOf(entry.tone, CARD_TONES, `${atPath}.tone`, problems, "work"),
				});
			}
		}
	}
	if (!node.collectFrom && node.lines.length === 0)
		problems.push(`${path}.lines: a card without "collectFrom" needs at least one line`);
}

/** Resolves `collectFrom` before station shapes are built, so a collector card can size itself to its batch's outputs. */
export function resolveCards(scene, problems) {
	for (const [index, node] of scene.nodes.entries()) {
		if (node.kind !== "card" || !node.collectFrom) continue;
		const target = scene.nodes.find((other) => other.id === node.collectFrom);
		if (target?.kind !== "batch") problems.push(`nodes[${index}].collectFrom: "${node.collectFrom}" names no batch station`);
		else node.sourceBatch = target;
	}
}

/** Resolves `when` links on card lines after all stations are placed. */
export function resolveCardLinks(scene, problems) {
	for (const [index, node] of scene.nodes.entries()) {
		if (node.kind !== "card") continue;
		for (const [lineIndex, line] of node.lines.entries())
			line.whenTarget = resolveWhenTarget(line.when, `nodes[${index}].lines[${lineIndex}].when`, scene, problems);
	}
}

/** The box, line baselines, divider positions and ports of a `card`, in pixels. */
export function shapeCard(node, x, y, u, rounds, vars) {
	const headerPx = node.header ? CARD_HEADER_H * u : 0;
	let maxCollected = 0;
	const sampleTexts = [node.header ?? ""];
	if (node.sourceBatch) {
		for (let round = 0; round < rounds; round++) {
			const plan = batchPlanFor(node.sourceBatch, round);
			maxCollected = Math.max(maxCollected, plan.hits.length);
			for (const hit of plan.hits) sampleTexts.push(plan.outputs[hit] ?? hit);
		}
	}
	for (const line of node.lines) sampleTexts.push(line.text);
	const widest = Math.max(
		node.header ? textWidth(node.header, SMALL_TEXT_SIZE * u, rounds, vars) : 0,
		...sampleTexts.slice(1).map((text) => textWidth(text, (node.sourceBatch ? SMALL_TEXT_SIZE : TEXT_SIZE) * u, rounds, vars)),
	);
	const w = node.cardW !== undefined ? node.cardW * u : Math.ceil((widest + 2 * CARD_PAD_X * u + u) / u) * u;
	const lineOffsets = [];
	const rules = [];
	let cursorY = CARD_PAD_Y * u + headerPx;
	const slotCount = Math.max(node.cardRows ?? 0, node.lines.length, maxCollected, 1);
	for (let index = 0; index < slotCount; index++) {
		const line = node.lines[index];
		if (line?.sep) {
			rules.push(y + cursorY + 0.2 * u);
			cursorY += CARD_SEP_GAP * u;
		}
		lineOffsets.push(y + cursorY + 1.8 * u);
		cursorY += LINE_STEP * u;
	}
	const h = cursorY + CARD_PAD_Y * u - 0.3 * u;
	const box = { x, y, w, h };
	return {
		box,
		bench: { x: x + w / 2, y: y + h / 2 },
		headerRule: node.header ? y + CARD_PAD_Y * u + CARD_HEADER_H * u - 0.55 * u : undefined,
		lineOffsets,
		rules,
		ports: boxPorts(box, u),
	};
}

/** Whether a card's words change or light during the loop, so they belong to the live layer. */
export function isDynamicCard(scene, node) {
	if (scene.rounds > 1 || node.cursor || Boolean(node.collectFrom)) return true;
	if (node.lines.some((line) => line.phase !== undefined || line.whenTarget !== undefined)) return true;
	return scene.runs.some((run) => run.segments.some((segment) => segment.kind === "work" && segment.node === node));
}

function cardHeaderWords(scene, node, round) {
	if (!node.header) return "";
	const u = scene.unit;
	const { box } = node.shape;
	return words(scene, box.x + CARD_PAD_X * u, box.y + CARD_PAD_Y * u + 1.45 * u, SMALL_TEXT_SIZE * u, [
		{ text: roundText(node.header, round, scene.vars), fill: scene.theme.dim },
	]);
}

function drawCardLinesStatic(scene, node, round) {
	const u = scene.unit;
	const { theme } = scene;
	const { box, lineOffsets } = node.shape;
	let out = cardHeaderWords(scene, node, round);
	for (const [index, line] of node.lines.entries()) {
		const shown = roundText(line.text, round, scene.vars);
		const baseFill = line.dim ? theme.dim : theme.text;
		out += words(scene, box.x + CARD_PAD_X * u, lineOffsets[index], TEXT_SIZE * u, cardSpans(shown, line.emphasis, baseFill, theme.text, line.bold));
	}
	return out;
}

/** Still layer of a `card`: its outline, internal divider hairlines, and its words when the card never changes. */
export function cardBody(scene, node, stroke, faint, round) {
	const u = scene.unit;
	const { shape } = node;
	let out = rectEl(shape.box, STATION_RADIUS * u, stroke);
	if (shape.headerRule !== undefined)
		out += lineEl(shape.box.x + u, shape.headerRule, shape.box.x + shape.box.w - u, shape.headerRule, faint);
	for (const ruleY of shape.rules)
		out += lineEl(shape.box.x + CARD_PAD_X * u, ruleY, shape.box.x + shape.box.w - CARD_PAD_X * u, ruleY, faint);
	if (round !== undefined && !isDynamicCard(scene, node)) out += drawCardLinesStatic(scene, node, round);
	return out;
}

function linePhaseStrength(node, line, index, stay, state) {
	let strength = line.whenTarget ? busyStrength(state, line.whenTarget) : 0;
	if (!stay) return strength;
	const anyPhaseTagged = node.lines.some((entry) => entry.phase !== undefined);
	const matched = anyPhaseTagged
		? line.phase !== undefined && (line.phase === stay.phaseIndex || line.phase === stay.phase)
		: !node.cursor && index === 0;
	if (matched) strength = Math.max(strength, Math.min(1, stay.blend, stay.left / 0.22));
	return strength;
}

function collectorLive(scene, node, state) {
	const u = scene.unit;
	const { theme } = scene;
	const { box, lineOffsets } = node.shape;
	let out = cardHeaderWords(scene, node, state.round);
	if (!node.sourceBatch) return out;
	const { stays, hits } = batchHitSchedule(scene, node.sourceBatch, state.round);
	const visible = hits.filter((hit) => hit.arrivesAt <= state.now);
	for (const [index, hit] of visible.entries()) {
		if (index >= lineOffsets.length) break;
		const appear = fadeIn(state.now - hit.arrivesAt, 0.18);
		const shown = roundText(hit.output, state.round, scene.vars);
		const split = /^(\S+)(\s+.*)$/.exec(shown);
		const spans = split
			? [
					{ text: split[1], fill: theme.ok, bold: true },
					{ text: split[2], fill: theme.text },
				]
			: [{ text: shown, fill: theme.ok, bold: true }];
		out += words(scene, box.x + CARD_PAD_X * u, lineOffsets[index], SMALL_TEXT_SIZE * u, spans, "start", appear);
	}
	const settled = stays.some((window) => window.end <= state.now);
	if (settled || visible.length > 0) {
		const count = settled ? hits.length : visible.length;
		const unit = count === 1 ? node.unitSingular : node.unitPlural;
		out += words(
			scene,
			box.x + box.w,
			box.y + box.h + 2.3 * u,
			SMALL_TEXT_SIZE * u,
			[{ text: `${count} ${roundText(unit, state.round, scene.vars)}`, fill: theme.dim }],
			"end",
			settled ? 0.95 : 0.7,
		);
	}
	return out;
}

/** Live layer of a `card`: active phase bars, trigger caret, or progressive collector lines. */
export function cardLive(scene, node, stay, state, heldBoxFn, litPinsFn) {
	if (!isDynamicCard(scene, node)) return "";
	const u = scene.unit;
	const { theme } = scene;
	const { box, lineOffsets } = node.shape;
	let out = "";
	const pulse = state.pulses.get(`${node.id}:0`);
	if (stay) {
		const colour = theme[stay.tone] ?? theme.work;
		out += heldBoxFn(scene, box, colour, Math.min(1, stay.since / 0.25), stay.failed);
		out += litPinsFn(scene, stay);
	} else if (pulse) {
		const colour = theme[pulse.tone] ?? theme.work;
		out += rectEl(box, STATION_RADIUS * u, `${strokeOf(colour, u * 0.4)} opacity="${alphaOf(pulse.strength * 0.3)}" filter="url(#flow-glow)"`);
		out += rectEl(box, STATION_RADIUS * u, `${strokeOf(colour, u * 0.17)} opacity="${alphaOf(pulse.strength * 0.85)}"`);
	}
	if (node.collectFrom) return out + collectorLive(scene, node, state);
	out += cardHeaderWords(scene, node, state.round);
	for (const [index, line] of node.lines.entries()) {
		const shown = roundText(line.text, state.round, scene.vars);
		const strength = linePhaseStrength(node, line, index, stay, state);
		const barColour = stay?.failed ? theme.fail : (theme[line.tone] ?? theme[stay?.tone] ?? theme.work);
		const baseline = lineOffsets[index];
		if (strength > 0.02) {
			out += rectEl(
				{ x: box.x + 0.55 * u, y: baseline - 1.45 * u, w: 0.28 * u, h: 1.85 * u },
				0.14 * u,
				`fill="${barColour}" opacity="${alphaOf(strength)}"`,
			);
			out += rectEl(
				{ x: box.x + 1.1 * u, y: baseline - 1.55 * u, w: box.w - 2 * u, h: 2.05 * u },
				CHIP_RADIUS * u,
				`fill="${barColour}" opacity="${alphaOf(0.09 * strength)}"`,
			);
		}
		const baseFill = line.dim && strength < 0.5 ? theme.dim : theme.text;
		out += words(scene, box.x + CARD_PAD_X * u, baseline, TEXT_SIZE * u, cardSpans(shown, line.emphasis, baseFill, theme.text, line.bold));
		if (node.cursor && index === 0) {
			const caretX = box.x + CARD_PAD_X * u + textWidth(shown, TEXT_SIZE * u) + 0.25 * u;
			const caretAlpha = pulse ? Math.max(0.65, pulse.strength) : 0.45 + 0.35 * Math.cos(state.now * Math.PI);
			out += rectEl(
				{ x: caretX, y: baseline - 1.45 * u, w: 0.22 * u, h: 1.8 * u },
				0.1 * u,
				`fill="${theme.work}" opacity="${alphaOf(Math.max(0.2, caretAlpha))}"`,
			);
		}
	}
	return out;
}
