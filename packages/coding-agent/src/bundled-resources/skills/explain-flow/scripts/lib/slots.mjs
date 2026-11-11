/**
 * The `slots` station: a horizontal bank of memory, cache or state cells that allocate on demand, update in place, or
 * exchange positions (`swap`) across rounds. Any instant is computed by replaying the station's short timeline from the
 * start of the period up to that instant, so every frame stands on its own with no mutable state.
 */

import { easeInOut, fadeIn, px } from "./geometry.mjs";
import { boxPorts, CHIP_RADIUS, roundText, SMALL_TEXT_SIZE, STATION_RADIUS, TEXT_SIZE } from "./metrics.mjs";
import { isRecord, readNumber, readOneOf, readPeriodMoment, readText } from "./read.mjs";
import { alphaOf, lineEl, rectEl, strokeOf, words } from "./svg.mjs";

const SLOTS_TONES = ["dim", "text", "work", "ok", "fail", "info"];
const SLOTS_GAP = 3;
const SLOTS_CELL_H = 4.4;
const SLOTS_HOUSING_PAD = 0.55;
const SLOTS_MAX_CELLS = 6;
const SLOTS_MAX_CHANGES = 24;
const SLOTS_PULSE_SECONDS = 0.45;

function readSlotCard(raw, path, problems) {
	if (raw === null || raw === undefined) return null;
	if (!isRecord(raw)) {
		problems.push(`${path}: must be an object or null`);
		return null;
	}
	return {
		tag: readText(raw.tag, `${path}.tag`, problems),
		text: readText(raw.text, `${path}.text`, problems, true) ?? "",
		sub: readText(raw.sub, `${path}.sub`, problems),
		status: readText(raw.status, `${path}.status`, problems),
		tone: readOneOf(raw.tone, SLOTS_TONES, `${path}.tone`, problems, "dim"),
	};
}

/** Reads a `slots` station from a spec. */
export function readSlots(raw, node, path, problems, rounds, loop) {
	node.cells = readNumber(raw.cells, `${path}.cells`, problems, { min: 1, max: SLOTS_MAX_CELLS, fallback: 2, integer: true });
	node.cellW = readNumber(raw.cellW, `${path}.cellW`, problems, { min: 10, max: 32, fallback: 16 });
	node.framed = raw.framed === true;
	if (raw.framed !== undefined && typeof raw.framed !== "boolean") problems.push(`${path}.framed: must be true or false`);
	node.captions = [];
	if (raw.captions !== undefined) {
		if (!Array.isArray(raw.captions) || raw.captions.length !== node.cells)
			problems.push(`${path}.captions: must hold ${node.cells} label(s), one per cell`);
		else
			node.captions = raw.captions.map((entry, index) => readText(entry, `${path}.captions[${index}]`, problems, true) ?? "");
	}
	node.initial = Array.from({ length: node.cells }, () => null);
	if (raw.initial !== undefined) {
		if (!Array.isArray(raw.initial) || raw.initial.length !== node.cells)
			problems.push(`${path}.initial: must hold ${node.cells} item(s), each a card object or null`);
		else node.initial = raw.initial.map((entry, index) => readSlotCard(entry, `${path}.initial[${index}]`, problems));
	}
	node.changes = [];
	if (raw.changes !== undefined) {
		if (!Array.isArray(raw.changes) || raw.changes.length > SLOTS_MAX_CHANGES)
			problems.push(`${path}.changes: must be a list of at most ${SLOTS_MAX_CHANGES} state changes`);
		else {
			for (const [index, entry] of raw.changes.entries()) {
				const atPath = `${path}.changes[${index}]`;
				if (!isRecord(entry)) {
					problems.push(`${atPath}: must be an object`);
					continue;
				}
				const moment = readPeriodMoment(entry, atPath, problems, rounds, loop);
				const op = readOneOf(entry.op, ["write", "swap"], `${atPath}.op`, problems, "write");
				if (op === "write") {
					const cell = readNumber(entry.cell, `${atPath}.cell`, problems, { min: 0, max: node.cells - 1, integer: true });
					const card = readSlotCard(entry, atPath, problems);
					if (card) node.changes.push({ op: "write", ...moment, cell, card });
				} else {
					const pair = Array.isArray(entry.cells) && entry.cells.length === 2 ? entry.cells : undefined;
					if (!pair) {
						problems.push(`${atPath}.cells: swap needs [firstCell, secondCell]`);
						continue;
					}
					const a = readNumber(pair[0], `${atPath}.cells[0]`, problems, { min: 0, max: node.cells - 1, integer: true });
					const b = readNumber(pair[1], `${atPath}.cells[1]`, problems, { min: 0, max: node.cells - 1, integer: true });
					if (a === b) problems.push(`${atPath}.cells: swap must name two distinct cells`);
					const duration = readNumber(entry.duration, `${atPath}.duration`, problems, { min: 0.15, max: 3, fallback: 0.55 });
					node.changes.push({ op: "swap", ...moment, cells: [a, b], duration });
				}
			}
		}
	}
	node.changes.sort((left, right) => left.time - right.time);
	node.hasCaptions =
		node.captions.length > 0 ||
		node.initial.some((card) => card?.status) ||
		node.changes.some((change) => change.op === "write" && change.card.status);
}

/** The box, cell frames and ports of a `slots` station, in pixels. */
export function shapeSlots(node, x, y, u) {
	const cellW = node.cellW * u;
	const cellH = SLOTS_CELL_H * u;
	const gap = SLOTS_GAP * u;
	const w = node.cells * cellW + (node.cells - 1) * gap;
	const cells = Array.from({ length: node.cells }, (_, index) => ({
		x: x + index * (cellW + gap),
		y,
		w: cellW,
		h: cellH,
	}));
	const cellPorts = cells.map((cell) => {
		const ports = boxPorts(cell, u);
		const midX = cell.x + cell.w / 2;
		return {
			...ports,
			top: { x: midX, y: cell.y, side: "top" },
			bottom: { x: midX, y: cell.y + cell.h, side: "bottom" },
		};
	});
	const box = { x, y, w, h: cellH };
	return { box, cells, cellPorts, gap, ports: boxPorts(box, u) };
}

/**
 * Replays the `slots` timeline from the start of the period to `periodNow`, returning the cards in each cell and any
 * in-flight swap interpolation.
 */
export function slotsAt(scene, node, round, now) {
	const periodNow = round * scene.loop + now;
	const cards = node.initial.map((card) => (card ? { ...card, writtenAt: -99 } : null));
	let swap;
	for (const change of node.changes) {
		if (periodNow < change.time) break;
		if (change.op === "write") {
			cards[change.cell] = { ...change.card, writtenAt: change.time };
		} else {
			const [a, b] = change.cells;
			if (periodNow < change.time + change.duration) {
				swap = { a, b, part: easeInOut((periodNow - change.time) / change.duration) };
			} else {
				const held = cards[a];
				cards[a] = cards[b];
				cards[b] = held;
			}
		}
	}
	return { round, periodNow, cards, swap };
}

/** Still layer of a `slots` station: connecting hairlines, persistent housings when `framed`, and fixed cell captions. */
export function slotsBody(scene, node, stroke) {
	const u = scene.unit;
	const { theme } = scene;
	const { cells } = node.shape;
	const pad = SLOTS_HOUSING_PAD * u;
	let out = "";
	for (let index = 0; index < cells.length - 1; index++) {
		const left = cells[index];
		const right = cells[index + 1];
		const midY = left.y + left.h / 2;
		out += lineEl(left.x + left.w + (node.framed ? pad : 0), midY, right.x - (node.framed ? pad : 0), midY, `${stroke} opacity="0.5"`);
	}
	if (node.framed) {
		const dashed = strokeOf(theme.line, u * 0.12, `stroke-dasharray="${px(0.45 * u)} ${px(0.4 * u)}"`);
		for (const cell of cells)
			out += rectEl(
				{ x: cell.x - pad, y: cell.y - pad, w: cell.w + 2 * pad, h: cell.h + 2 * pad },
				(STATION_RADIUS + 0.2) * u,
				`${dashed} opacity="0.55"`,
			);
	}
	if (scene.rounds === 1) {
		for (const [index, text] of node.captions.entries())
			if (text)
				out += words(scene, cells[index].x + cells[index].w / 2, cells[index].y + cells[index].h + 2.4 * u, SMALL_TEXT_SIZE * u, [{ text, fill: theme.dim }], "middle");
	}
	return out;
}

function slotToneColour(scene, tone) {
	if (tone === "dim") return scene.theme.line;
	if (tone === "text") return scene.theme.text;
	return scene.theme[tone] ?? scene.theme.work;
}

function drawSlotCardAt(scene, rect, card, round, periodNow) {
	const u = scene.unit;
	const { theme } = scene;
	const age = periodNow - card.writtenAt;
	const fresh = age >= 0 && age < SLOTS_PULSE_SECONDS ? 1 - age / SLOTS_PULSE_SECONDS : 0;
	const appear = card.writtenAt >= 0 ? fadeIn(age, 0.18) : 1;
	const border = slotToneColour(scene, card.tone);
	const quiet = card.tone === "dim";
	let out = `<g opacity="${alphaOf(appear)}">`;
	if (fresh > 0.02)
		out += rectEl(rect, CHIP_RADIUS * u, `${strokeOf(border, u * 0.42)} opacity="${alphaOf(fresh * 0.38)}" filter="url(#flow-glow)"`);
	out += rectEl(
		rect,
		CHIP_RADIUS * u,
		`fill="${theme.bg}" stroke="${border}" stroke-width="${px(u * (quiet ? 0.14 : 0.18))}" opacity="${alphaOf(quiet ? 0.65 : 0.95)}"`,
	);
	let textLeft = rect.x + 1.2 * u;
	if (card.tag) {
		const badge = { x: rect.x + 0.9 * u, y: rect.y + 0.95 * u, w: 2.3 * u, h: 2.5 * u };
		const badgeFill = quiet ? theme.line : theme.text;
		out += rectEl(badge, 0.35 * u, `fill="${badgeFill}" opacity="${quiet ? 0.28 : 0.9}"`);
		out += words(
			scene,
			badge.x + badge.w / 2,
			badge.y + 1.75 * u,
			SMALL_TEXT_SIZE * u,
			[{ text: roundText(card.tag, round, scene.vars), fill: quiet ? theme.text : theme.bg, bold: true }],
			"middle",
		);
		textLeft = badge.x + badge.w + 1.0 * u;
	}
	const hasSub = Boolean(card.sub);
	const mainY = rect.y + (hasSub ? 1.95 : 2.75) * u;
	const mainInk = quiet ? theme.dim : theme.text;
	out += words(scene, textLeft, mainY, TEXT_SIZE * u, [
		{ text: roundText(card.text, round, scene.vars), fill: mainInk, bold: !quiet },
	]);
	if (card.sub)
		out += words(scene, textLeft, rect.y + 3.65 * u, SMALL_TEXT_SIZE * u, [
			{ text: roundText(card.sub, round, scene.vars), fill: theme.dim },
		]);
	out += "</g>";
	return out;
}

/** Live layer of a `slots` station: empty placeholders, settled or freshly written cards, swapping cards, and captions. */
export function slotsLive(scene, node, view, state) {
	if (!view) return "";
	const u = scene.unit;
	const { theme } = scene;
	const { cells } = node.shape;
	let out = "";
	if (scene.rounds > 1) {
		for (const [index, text] of node.captions.entries())
			if (text)
				out += words(
					scene,
					cells[index].x + cells[index].w / 2,
					cells[index].y + cells[index].h + 2.4 * u,
					SMALL_TEXT_SIZE * u,
					[{ text: roundText(text, view.round, scene.vars), fill: theme.dim }],
					"middle",
				);
	}
	const dashedEmpty = strokeOf(theme.line, u * 0.13, `stroke-dasharray="${px(0.5 * u)} ${px(0.45 * u)}"`);
	for (const [index, cell] of cells.entries()) {
		const pulse = state?.pulses.get(`${node.id}:${index}`);
		if (pulse) {
			const pulseTone = theme[pulse.tone] ?? theme.work;
			out += rectEl(cell, CHIP_RADIUS * u, `${strokeOf(pulseTone, u * 0.36)} opacity="${alphaOf(pulse.strength * 0.32)}" filter="url(#flow-glow)"`);
		}
		const swapping = view.swap && (index === view.swap.a || index === view.swap.b);
		const card = view.cards[index];
		if (!card && !swapping && !node.framed) {
			out += rectEl(cell, CHIP_RADIUS * u, `${dashedEmpty} opacity="0.38"`);
			continue;
		}
		if (card && !swapping) {
			out += drawSlotCardAt(scene, cell, card, view.round, view.periodNow);
			if (card.status && !node.captions[index])
				out += words(
					scene,
					cell.x + cell.w / 2,
					cell.y + cell.h + 2.4 * u,
					SMALL_TEXT_SIZE * u,
					[{ text: roundText(card.status, view.round, scene.vars), fill: card.tone === "dim" ? theme.dim : theme.text }],
					"middle",
					card.tone === "dim" ? 0.72 : 0.92,
				);
		}
	}
	if (view.swap) {
		const { a, b, part } = view.swap;
		const lift = Math.sin(part * Math.PI) * 0.55 * u;
		const placeBetween = (from, to, dy) => ({
			x: from.x + (to.x - from.x) * part,
			y: from.y + (to.y - from.y) * part + dy,
			w: from.w,
			h: from.h,
		});
		if (view.cards[a]) out += drawSlotCardAt(scene, placeBetween(cells[a], cells[b], -lift), view.cards[a], view.round, view.periodNow);
		if (view.cards[b]) out += drawSlotCardAt(scene, placeBetween(cells[b], cells[a], lift), view.cards[b], view.round, view.periodNow);
	}
	return out;
}
