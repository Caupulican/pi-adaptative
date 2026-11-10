/**
 * Draws a scene as SVG text in two layers: the static layer (stations, wires, names: the same in every frame) and the
 * live layer (items, mechanisms, progress, rails, the loop bar: one instant). A frame is both layers in one document.
 * At rest the picture is line and text only; a state colour appears only where something is happening, and one family
 * of two corner radii shapes everything.
 */

import { pieceOf, px } from "./geometry.mjs";
import { isLinked, lanesBody, lanesLive, noteLines, seriesBody, seriesLive, tableBody, tableRows, tallyRounds } from "./instruments.mjs";
import { activityMarks, drawMechanism } from "./mechanisms.mjs";
import {
	CHIP_RADIUS,
	HOP_SECONDS,
	MARGIN,
	roundText,
	SMALL_TEXT_SIZE,
	STATION_RADIUS,
	SUB_STEP,
	TEXT_SIZE,
} from "./metrics.mjs";
import { captionRows, wordsLeft } from "./scene.mjs";
import { stateAt } from "./state.mjs";
import { alphaOf, circleEl, lineEl, pathEl, rectEl, strokeOf, words } from "./svg.mjs";
import { mixHex } from "./theme.mjs";
import { trialBody, trialLive } from "./trial.mjs";

/** The lengths of the two ruled lines on a source's cards, in grid units: no two neighbours look alike. */
const CARD_LINES = [
	[3.2, 2],
	[2.4, 3],
	[3.2, 1.4],
	[1.8, 2.6],
];

/** How the lines and words of a tier are drawn: live work solid, what comes next dashed, what is planned dotted. */
function tierStyle(scene, tier) {
	const u = scene.unit;
	if (tier === "next") return { dash: `${px(0.7 * u)} ${px(0.55 * u)}`, cap: "butt", alpha: 0.72 };
	if (tier === "later") return { dash: `${px(0.12 * u)} ${px(0.5 * u)}`, cap: "round", alpha: 0.46 };
	return { dash: undefined, cap: "butt", alpha: 1 };
}

function tierStroke(scene, tier, colour, width) {
	const style = tierStyle(scene, tier);
	return strokeOf(colour, width ?? scene.unit * 0.15, style.dash ? `stroke-dasharray="${style.dash}" stroke-linecap="${style.cap}"` : "");
}

function toneOf(scene, tone) {
	return scene.theme[tone] ?? scene.theme.work;
}

/** A pin: the dot on a station's edge where a wire meets it. It lights while an item passes through. */
function pin(scene, at, colour) {
	return circleEl(at.x, at.y, 0.42 * scene.unit, `fill="${colour}"`);
}

/** The pins an item is passing through now: the one it came in by, then the one it leaves by. */
function litPins(scene, stay) {
	const colour = toneOf(scene, stay.tone);
	let out = "";
	if (stay.since < HOP_SECONDS * 1.5) out += pin(scene, stay.enter, colour);
	if (stay.exit && stay.left < HOP_SECONDS * 1.5) out += pin(scene, stay.exit, colour);
	return out;
}

/** The y of a station's first static sub line. */
function subTop(node, u) {
	const { y, h } = node.shape.box;
	return y + h + (2.5 + captionRows(node) * SUB_STEP) * u;
}

/** A chain chip's words: dim, inside its chip. */
function chipWords(scene, chip, round) {
	const u = scene.unit;
	return words(scene, chip.x + 1.5 * u, chip.y + 2 * u, SMALL_TEXT_SIZE * u, [{ text: roundText(chip.text, round), fill: scene.theme.dim }]);
}

/** A tally's words: its count, after its boxes. */
function tallyWords(scene, node, round) {
	const u = scene.unit;
	const { words: place } = node.shape;
	return words(scene, place.x, place.y, SMALL_TEXT_SIZE * u, [{ text: roundText(node.text, round), fill: scene.theme.dim }]);
}

/**
 * The words a station writes inside its body, for the live layer of a film whose rounds change them. The body writes
 * them in its own order, through the same helpers, when it draws a film of one round.
 */
function nodeWords(scene, node, round, state) {
	if (node.kind === "chain") return node.shape.chips.map((chip) => chipWords(scene, chip, round)).join("");
	if (node.kind === "tally") return tallyWords(scene, node, round);
	if (node.kind === "note") return noteLines(scene, node, round, state);
	if (node.kind === "table") return tableRows(scene, node, round, state);
	return "";
}

function nodeLabels(scene, node, round) {
	const u = scene.unit;
	const { theme } = scene;
	const size = TEXT_SIZE * u;
	const { x: left, y } = node.shape.box;
	const alpha = tierStyle(scene, node.tier).alpha;
	if (node.kind === "chain" && node.lead !== undefined) {
		// A list row: tag and name at the left on the chips' line, the rest under the name.
		let out = words(scene, left, y + 2 * u, size, [{ text: roundText(node.tag ? `${node.tag} ` : "", round), fill: theme.text, bold: true }, { text: roundText(node.label, round), fill: theme.dim }], "start", alpha);
		for (const [index, text] of [node.note, ...node.sub].filter(Boolean).entries())
			out += words(scene, left, y + 2 * u + (index + 1) * SUB_STEP * u, size, [{ text: roundText(text, round), fill: theme.dim }], "start", alpha * 0.75);
		return out;
	}
	const x = wordsLeft(node, "top", u);
	let out = "";
	// A rail writes its own name beside its line, with what it shows now.
	if (node.kind !== "rail" && (node.label || node.note))
		out += words(
			scene,
			x,
			y - (node.value ? 4 : 1.5) * u,
			size,
			[
				{ text: roundText(node.label, round), fill: theme.text, bold: true },
				{ text: node.label && node.note ? " · " : "", fill: theme.dim },
				{ text: roundText(node.note, round), fill: theme.dim },
			],
			"start",
			alpha,
		);
	if (node.value) out += words(scene, x, y - 1.5 * u, size, [{ text: roundText(node.value, round), fill: theme.info }], "start", alpha);
	for (const [index, text] of node.sub.entries())
		out += words(scene, wordsLeft(node, "bottom", u), subTop(node, u) + index * SUB_STEP * u, size, [{ text: roundText(text, round), fill: theme.dim }], "start", alpha * 0.9);
	return out;
}

/**
 * A station's body: its outline, and for a film of one round the words inside it. `round` is the round those words take;
 * `undefined` draws the outline alone, which is what the still layer of a film of several rounds holds, because the live
 * layer then writes the words for the round it is in.
 */
function nodeBody(scene, node, round) {
	const u = scene.unit;
	const { theme } = scene;
	const { shape, tier } = node;
	const stroke = tierStroke(scene, tier, theme.line);
	const faint = `${stroke} opacity="0.55"`;
	let out = "";
	switch (node.kind) {
		case "source":
			for (const [index, emitter] of shape.emitters.entries()) {
				out += circleEl(emitter.lamp.x, emitter.lamp.y, 0.65 * u, stroke) + rectEl(emitter.card, CHIP_RADIUS * u, stroke);
				const left = emitter.card.x + 0.9 * u;
				const [first, second] = CARD_LINES[index % CARD_LINES.length];
				out += lineEl(left, emitter.card.y + 1.1 * u, left + first * u, emitter.card.y + 1.1 * u, faint);
				out += lineEl(left, emitter.card.y + 1.9 * u, left + second * u, emitter.card.y + 1.9 * u, faint);
			}
			break;
		case "queue":
			out += rectEl(shape.box, STATION_RADIUS * u, stroke);
			for (const slot of shape.slots) out += rectEl(slot, CHIP_RADIUS * u, faint);
			break;
		case "worker":
			out += rectEl(shape.box, STATION_RADIUS * u, stroke);
			out += lineEl(shape.box.x + 2 * u, shape.box.y + shape.box.h - 1.5 * u, shape.box.x + shape.box.w - 2 * u, shape.box.y + shape.box.h - 1.5 * u, faint);
			break;
		case "trial":
			out += trialBody(scene, node, stroke, faint, STATION_RADIUS * u);
			break;
		case "sweep":
			out += rectEl(shape.box, STATION_RADIUS * u, stroke) + lineEl(shape.track.x1, shape.track.y, shape.track.x2, shape.track.y, faint);
			break;
		case "chain":
			for (const [index, chip] of shape.chips.entries()) {
				out += rectEl(chip, CHIP_RADIUS * u, stroke);
				if (round !== undefined) out += chipWords(scene, chip, round);
				const next = shape.chips[index + 1];
				if (!next) continue;
				const y = chip.y + chip.h / 2;
				const tip = next.x - 0.4 * u;
				out += lineEl(chip.x + chip.w + 0.4 * u, y, tip, y, stroke);
				out += pathEl(`M${px(tip - 0.7 * u)} ${px(y - 0.55 * u)}L${px(tip)} ${px(y)}L${px(tip - 0.7 * u)} ${px(y + 0.55 * u)}`, strokeOf(theme.line, u * 0.15));
			}
			break;
		case "tally":
			for (const [index, cell] of shape.boxes.entries()) {
				out += rectEl(cell, 0.3 * u, stroke);
				if (index >= node.crossed) continue;
				out += lineEl(cell.x + 0.4 * u, cell.y + 0.4 * u, cell.x + cell.w - 0.4 * u, cell.y + cell.h - 0.4 * u, strokeOf(theme.dim, u * 0.15));
				out += lineEl(cell.x + cell.w - 0.4 * u, cell.y + 0.4 * u, cell.x + 0.4 * u, cell.y + cell.h - 0.4 * u, strokeOf(theme.dim, u * 0.15));
			}
			if (round !== undefined) out += tallyWords(scene, node, round);
			break;
		case "note":
			// A note that follows a station lights with it, so its words belong to the live layer.
			if (round !== undefined && !isLinked(node)) out += noteLines(scene, node, round);
			break;
		case "table":
			out += tableBody(scene, node);
			break;
		case "series":
			out += seriesBody(scene, node);
			break;
		case "lanes":
			out += lanesBody(scene, node);
			break;
		default:
			break;
	}
	if (node.kind === "queue" || node.kind === "worker" || node.kind === "trial" || node.kind === "sweep")
		for (const name of node.usedPorts) out += pin(scene, shape.ports[name], theme.line);
	// The structure stays quiet so what moves and what changed carry the picture.
	return `<g opacity="${alphaOf(tierStyle(scene, tier).alpha * 0.8)}">${out}</g>`;
}

/** The longest level run of a wire: where its label sits. */
function labelRun(path) {
	let best;
	for (let index = 1; index < path.points.length; index++) {
		const a = path.points[index - 1];
		const b = path.points[index];
		if (Math.abs(a.y - b.y) > 0.5) continue;
		const length = Math.abs(b.x - a.x);
		if (!best || length > best.length) best = { x: Math.min(a.x, b.x), y: a.y, length };
	}
	return best;
}

function wireEl(scene, wire) {
	const u = scene.unit;
	const style = tierStyle(scene, wire.tier);
	let out = pathEl(wire.path.d, `${tierStroke(scene, wire.tier, scene.theme.line, u * 0.13)} opacity="${alphaOf(style.alpha * 0.48)}"`);
	if (!wire.label) return out;
	// A wire that turns to another row is named where it arrives, so two wires that leave one pin are never named in
	// one place; a level wire and a lane are named under the middle of their longest level run.
	const end = wire.path.points[wire.path.points.length - 1];
	const run = wire.run === "turn" ? undefined : labelRun(wire.path);
	const place = run ? { x: run.x + run.length / 2, y: run.y + 2.25 * u, anchor: "middle" } : { x: end.x - 1.5 * u, y: end.y - 0.9 * u, anchor: "end" };
	return out + words(scene, place.x, place.y, TEXT_SIZE * u, [{ text: wire.label, fill: scene.theme.dim }], place.anchor, style.alpha * 0.9);
}

function bandHeader(scene, band, index) {
	const u = scene.unit;
	const { theme } = scene;
	const left = MARGIN * u;
	let out = "";
	if (index > 0) out += lineEl(left, band.top, scene.width - left, band.top, `${strokeOf(theme.line, u * 0.12)} opacity="0.45"`);
	const title = band.title ? band.title.toUpperCase() : undefined;
	const note = band.note ? band.note.toUpperCase() : undefined;
	out += `<g letter-spacing="${px(u * 0.16)}">${words(scene, left, band.top + 3.25 * u, 1.55 * u, [
		{ text: title, fill: band.tier === "live" ? theme.ok : theme.text, bold: true },
		{ text: title && note ? " · " : "", fill: theme.dim },
		{ text: note, fill: theme.dim },
	])}</g>`;
	return out;
}

/** The loop bar along the foot of the canvas: where in the loop the film is, so a viewer sees that it repeats. */
function loopBar(scene) {
	const u = scene.unit;
	return { left: MARGIN * u, right: scene.width - MARGIN * u, y: scene.height - 1.75 * u };
}

/** The two captions over the loop bar: what one item stands for, and what one round stands for. */
function captions(scene, round) {
	const u = scene.unit;
	const bar = loopBar(scene);
	let out = "";
	if (scene.footer)
		out += words(scene, bar.left, bar.y - 1.5 * u, TEXT_SIZE * u, [{ text: roundText(scene.footer, round), fill: scene.theme.dim }]);
	if (scene.clock)
		out += words(scene, bar.right, bar.y - 1.5 * u, TEXT_SIZE * u, [{ text: roundText(scene.clock, round), fill: scene.theme.dim }], "end");
	return out;
}

/** Everything that is the same in every frame. */
export function drawStatic(scene) {
	const u = scene.unit;
	const { theme } = scene;
	let out = `<rect width="${scene.width}" height="${scene.height}" fill="${theme.bg}"/>`;
	for (const [index, band] of scene.bands.entries()) out += bandHeader(scene, band, index);
	for (const wire of scene.wires) out += wireEl(scene, wire);
	// A station's words belong to the live layer when a round changes them; a film of one round draws them here.
	const wordsRound = scene.rounds === 1 ? 0 : undefined;
	for (const node of scene.nodes)
		out += nodeBody(scene, node, wordsRound) + (wordsRound === undefined ? "" : nodeLabels(scene, node, wordsRound));
	const bar = loopBar(scene);
	const quiet = `${strokeOf(theme.line, u * 0.12)} opacity="0.6"`;
	out += lineEl(bar.left, bar.y, bar.right, bar.y, quiet);
	// The bar is one segment per round, with a tick where each round begins; a film of one round keeps its quarters.
	const segments = scene.rounds === 1 ? 4 : scene.rounds;
	for (let index = 0; index <= segments; index++) {
		const x = bar.left + ((bar.right - bar.left) * index) / segments;
		out += lineEl(x, bar.y - 0.4 * u, x, bar.y + 0.4 * u, quiet);
	}
	if (wordsRound !== undefined) out += captions(scene, wordsRound);
	return out;
}

function sourcePulses(scene, node, state) {
	const u = scene.unit;
	let out = "";
	for (const [index, emitter] of node.shape.emitters.entries()) {
		const pulse = state.pulses.get(`${node.id}:${index}`);
		if (!pulse) continue;
		const colour = toneOf(scene, pulse.tone);
		out += `<g opacity="${alphaOf(pulse.strength)}">`;
		out += rectEl(emitter.card, CHIP_RADIUS * u, `fill="${colour}" opacity="0.3" filter="url(#flow-glow)"`);
		out += rectEl(emitter.card, CHIP_RADIUS * u, `fill="${colour}" fill-opacity="0.2" stroke="${colour}" stroke-width="${px(u * 0.16)}"`);
		out += `${circleEl(emitter.lamp.x, emitter.lamp.y, 0.65 * u, `fill="${colour}"`)}</g>`;
	}
	return out;
}

function queueStays(scene, node, stays) {
	const u = scene.unit;
	let out = "";
	for (const stay of stays) {
		const slot = node.shape.slots[stay.slot];
		const colour = toneOf(scene, stay.tone);
		const y = slot.y + slot.h - 0.5 * u;
		const left = slot.x + 0.9 * u;
		out += rectEl(slot, CHIP_RADIUS * u, `${strokeOf(colour, u * 0.16)} opacity="0.7"`);
		out += lineEl(left, y, left + (slot.w - 1.8 * u) * stay.progress, y, strokeOf(colour, u * 0.3, 'stroke-linecap="round"'));
		out += litPins(scene, stay);
	}
	return out;
}

/** The outline of a station while it holds an item: a soft glow and its edge in the item's colour, settling in. */
function heldOutline(scene, box, colour, settle, failed) {
	const u = scene.unit;
	return (
		rectEl(box, STATION_RADIUS * u, `${strokeOf(colour, u * 0.5)} opacity="${alphaOf(settle * 0.35)}" filter="url(#flow-glow)"`) +
		rectEl(box, STATION_RADIUS * u, `fill="${colour}" fill-opacity="${failed ? 0.14 : 0.05}" stroke="${colour}" stroke-width="${px(u * 0.18)}" opacity="${alphaOf(settle * 0.9)}"`)
	);
}

/** A trial: the frame of a station that holds an item, its rack through `trial.mjs`, and its progress on the rack's line. */
function trialEl(scene, node, stay, view) {
	const u = scene.unit;
	const { shape } = node;
	const caption = { x: wordsLeft(node, "bottom", u), y: shape.box.y + shape.box.h + 2.5 * u };
	if (!stay) return trialLive(scene, node, view, scene.theme.line, caption);
	const colour = toneOf(scene, stay.tone);
	let out = heldOutline(scene, shape.box, colour, Math.min(1, stay.since / 0.25), stay.failed);
	out += trialLive(scene, node, { ...view, phases: stay.phases }, colour, caption);
	const reach = shape.line.x1 + (shape.line.x2 - shape.line.x1) * stay.progress;
	out += lineEl(shape.line.x1, shape.base, reach, shape.base, strokeOf(colour, u * 0.3, 'stroke-linecap="round"'));
	return out + litPins(scene, stay);
}

function workerEl(scene, node, stay, round) {
	const u = scene.unit;
	const { theme } = scene;
	const { box } = node.shape;
	const rail = { left: box.x + 2 * u, right: box.x + box.w - 2 * u, top: box.y + 1.5 * u, base: box.y + box.h - 1.5 * u };
	const parts = { u, box, bench: node.shape.bench, rail, quiet: theme.line };
	// At rest the mechanism waits in the quiet line colour, as faint as its tier.
	if (!stay) return `<g opacity="${tierStyle(scene, node.tier).alpha}">${drawMechanism(node.mechanism, parts)}</g>`;
	const colour = toneOf(scene, stay.tone);
	const settle = Math.min(1, stay.since / 0.25);
	let out = heldOutline(scene, box, colour, settle, stay.failed);
	out += drawMechanism(node.mechanism, { ...parts, colour, since: stay.since, progress: stay.progress, failed: stay.failed });
	if (!stay.failed) out += activityMarks({ u, box, colour, since: stay.since });
	out += lineEl(rail.left, rail.base, rail.left + (rail.right - rail.left) * stay.progress, rail.base, strokeOf(colour, u * 0.3, 'stroke-linecap="round"'));
	out += litPins(scene, stay);
	const size = TEXT_SIZE * u;
	const x = wordsLeft(node, "bottom", u);
	const first = box.y + box.h + 2.5 * u;
	if (stay.lane) out += words(scene, x, first, size, [{ text: roundText(stay.lane, round), fill: toneOf(scene, stay.laneTone) }], "start", settle);
	// One phase rolls out before the next rolls in, so two sets of words never sit on each other.
	const row = first + SUB_STEP * u;
	const leaving = stay.before ? Math.max(0, 1 - stay.blend * 2) : 0;
	const arriving = stay.before ? Math.max(0, stay.blend * 2 - 1) : stay.blend;
	if (leaving > 0) out += words(scene, x, row - (1 - leaving) * 0.6 * u, size, [{ text: roundText(stay.before, round), fill: theme.dim }], "start", leaving);
	if (stay.phase && arriving > 0)
		out += words(scene, x, row + (1 - arriving) * 0.6 * u, size, [{ text: roundText(stay.phase, round), fill: stay.failed ? theme.fail : theme.dim }], "start", arriving);
	return out;
}

function railEl(scene, node, rail, round) {
	const u = scene.unit;
	const { theme } = scene;
	const { shape } = node;
	const result = rail.newest?.result;
	const colour = result === "ok" ? theme.ok : result === "fail" ? theme.fail : theme.line;
	let out = lineEl(shape.line.x1, shape.line.y, shape.line.x2, shape.line.y, `${strokeOf(colour, u * 0.2)} opacity="${result ? 0.85 : 1}"`);
	out += rectEl({ x: shape.line.x2 - 0.25 * u, y: shape.line.y - 1.5 * u, w: 0.5 * u, h: 3 * u }, 0.25 * u, `fill="${theme.line}"`);
	const state = result === "ok" ? node.okText : result === "fail" ? node.failText : undefined;
	out += words(scene, shape.box.x, shape.box.y - 1.5 * u, TEXT_SIZE * u, [
		{ text: roundText(node.label, round), fill: theme.text, bold: true },
		{ text: node.label && (state ?? node.note) ? " · " : "", fill: theme.dim },
		{ text: roundText(state ?? node.note, round), fill: state ? colour : theme.dim },
	]);
	const radius = 0.8 * u;
	const quiet = mixHex(theme.text, theme.bg, 0.25);
	if (rail.dots.length === 0) {
		for (let index = 0; index < node.dots; index++)
			out += circleEl(shape.first.x + index * shape.pitch, shape.first.y, radius, `fill="${theme.bg}" stroke="${theme.line}" stroke-width="${px(u * 0.16)}"`);
		return out;
	}
	for (const [index, dot] of rail.dots.entries()) {
		// Every older dot moves one place along while the newest grows in from the wire's end.
		const place = index === 0 ? -0.5 * (1 - rail.slide) : index - (1 - rail.slide);
		const x = shape.first.x + place * shape.pitch;
		const alpha = index === node.dots ? 1 - rail.slide : 1;
		if (alpha <= 0.01) continue;
		// The newest dot and every failure keep their colour; a success that is no longer news goes quiet.
		const fill = dot.result === "fail" ? theme.fail : dot.result === "ok" && index === 0 ? theme.ok : quiet;
		out += circleEl(x, shape.first.y, index === 0 ? radius * (0.5 + 0.5 * rail.slide) : radius, `fill="${fill}" opacity="${alphaOf(alpha)}"`);
		// A mark stands under its dot, in the row the rail keeps for marks: the rail's name has the row above the line.
		if (dot.mark)
			out += `<g letter-spacing="${px(u * 0.1)}">${words(scene, x, shape.first.y + 2.7 * u, 1.2 * u, [{ text: dot.mark.toUpperCase(), fill }], "middle", alpha)}</g>`;
	}
	if (rail.ring !== undefined) {
		const x = shape.first.x - 0.5 * (1 - rail.slide) * shape.pitch;
		const ring = rail.newest.result === "fail" ? theme.fail : rail.newest.result === "ok" ? theme.ok : theme.text;
		out += circleEl(x, shape.first.y, radius + (0.5 + 1.6 * rail.ring) * u, `${strokeOf(ring, u * 0.16)} opacity="${alphaOf((1 - rail.ring) * 0.9)}"`);
	}
	return out;
}

/** The chips of a chain that are lit now, each with how strongly, and where the pass's cursor is. */
function chainEl(scene, node, pass, round) {
	const u = scene.unit;
	const { theme } = scene;
	const { chips } = node.shape;
	if (!pass) return "";
	const count = chips.length;
	const whole = (pass.step + pass.part) / (count + 1);
	let out = "";
	for (const [index, chip] of chips.entries()) {
		let strength = 0;
		if (node.mode === "together") strength = Math.min(1, whole * 8, (0.6 - whole) * 8);
		else if (pass.step >= count) strength = 0;
		else if (node.mode === "fill") strength = index < pass.step ? 1 : index === pass.step ? Math.min(1, pass.part * 3) : 0;
		else strength = index === pass.step ? Math.min(1, pass.part * 4, (1 - pass.part) * 4) : 0;
		if (strength <= 0.01) continue;
		out += `<g opacity="${alphaOf(strength)}">${rectEl(chip, CHIP_RADIUS * u, `fill="${theme.info}" fill-opacity="0.16" stroke="${theme.info}" stroke-width="${px(u * 0.16)}"`)}`;
		out += `${words(scene, chip.x + 1.5 * u, chip.y + 2 * u, SMALL_TEXT_SIZE * u, [{ text: roundText(chip.text, round), fill: theme.text }])}</g>`;
	}
	if (node.mode !== "together" && pass.step < count) {
		// A cursor rides over the chain from the step in hand to the next one.
		const centre = (chip) => chip.x + chip.w / 2;
		const from = centre(chips[pass.step]);
		const to = centre(chips[Math.min(pass.step + 1, count - 1)]);
		const glide = pass.part < 0.7 ? 0 : ((pass.part - 0.7) / 0.3) ** 2;
		out += lineEl(from + (to - from) * glide - 0.8 * u, chips[0].y - 0.9 * u, from + (to - from) * glide + 0.8 * u, chips[0].y - 0.9 * u, strokeOf(theme.info, u * 0.25, 'stroke-linecap="round"'));
	}
	return out;
}

function itemEl(scene, item, round) {
	const u = scene.unit;
	const { theme } = scene;
	const colour = toneOf(scene, item.tone);
	const w = 2.75 * u;
	const h = 1.75 * u;
	let out = "";
	if (item.wire) out += pathEl(item.wire.path.d, `${strokeOf(colour, u * 0.16)} opacity="${alphaOf(0.3 * item.pace)}"`);
	if (item.trail) {
		const pieces = 5;
		const span = (item.trail.to - item.trail.from) / pieces;
		for (let piece = 0; piece < pieces; piece++)
			out += pathEl(pieceOf(item.trail.path, item.trail.from + piece * span, item.trail.from + (piece + 1) * span), `${strokeOf(colour, h * 0.7)} opacity="${alphaOf(((piece + 1) / pieces) * 0.38)}"`);
	}
	const body = { x: -w / 2, y: -h / 2, w, h };
	// Upright on a level wire and turned with the wire elsewhere; a wire travelled leftwards keeps the item upright too.
	const turn = Math.abs(item.angle) > 90 ? item.angle - Math.sign(item.angle) * 180 : item.angle;
	out += `<g transform="translate(${px(item.x)} ${px(item.y)}) rotate(${px(turn)})">`;
	out += rectEl(body, CHIP_RADIUS * u, `fill="${colour}" opacity="0.5" filter="url(#flow-glow)"`) + rectEl(body, CHIP_RADIUS * u, `fill="${colour}"`);
	out += lineEl(-w / 2 + 0.6 * u, 0, w / 2 - 0.9 * u, 0, `${strokeOf(theme.bg, u * 0.22, 'stroke-linecap="round"')} opacity="0.45"`);
	// An item that passed its last check wears the mark of it.
	if (item.passed) out += circleEl(w / 2 - 0.1 * u, -h / 2 + 0.1 * u, 0.42 * u, `fill="${theme.ok}" stroke="${theme.bg}" stroke-width="${px(u * 0.12)}"`);
	out += "</g>";
	// What an item carries is named only while it is clear of the stations at both ends of its wire.
	if (item.carry && item.carryAlpha > 0.01)
		out += words(scene, item.x, item.y - 1.75 * u, SMALL_TEXT_SIZE * u, [{ text: roundText(item.carry, round), fill: colour }], "middle", item.carryAlpha);
	return `<g opacity="${alphaOf(item.alpha)}">${out}</g>`;
}

/** Everything that depends on the instant. */
export function drawLive(scene, state) {
	const u = scene.unit;
	const { theme } = scene;
	let out = "";
	// A film of several rounds writes its stations' words here, with the tokens of the round it is in; a film of one
	// round writes here only the words that light with the circuit.
	if (scene.rounds > 1)
		out += scene.nodes.map((node) => nodeWords(scene, node, state.round, state) + nodeLabels(scene, node, state.round)).join("");
	else out += scene.nodes.filter(isLinked).map((node) => nodeWords(scene, node, 0, state)).join("");
	for (const node of scene.nodes) {
		const stays = state.stays.get(node.id) ?? [];
		if (node.kind === "source") out += sourcePulses(scene, node, state);
		else if (node.kind === "queue") out += queueStays(scene, node, stays);
		else if (node.kind === "worker") out += workerEl(scene, node, stays[0], state.round);
		else if (node.kind === "trial") out += trialEl(scene, node, stays[0], state.trials.get(node.id));
		else if (node.kind === "series") out += seriesLive(scene, node, state);
		else if (node.kind === "lanes") out += lanesLive(scene, node, state);
		else if (node.kind === "tally" && node.per) out += tallyRounds(scene, node, state);
		else if (node.kind === "rail") out += railEl(scene, node, state.rails.get(node.id), state.round);
		else if (node.kind === "chain") out += chainEl(scene, node, state.chains.get(node.id), state.round);
		else if (node.kind === "sweep") {
			const { track } = node.shape;
			const x = track.x1 + (track.x2 - track.x1) * (state.sweeps.get(node.id) ?? 0);
			out += lineEl(track.x1, track.y, x, track.y, `${strokeOf(theme.info, u * 0.2)} opacity="0.7"`);
			out += circleEl(x, track.y, 0.7 * u, `fill="${theme.info}" opacity="0.5" filter="url(#flow-glow)"`) + circleEl(x, track.y, 0.6 * u, `fill="${theme.info}"`);
		}
	}
	for (const item of state.items) out += itemEl(scene, item, state.round);
	const bar = loopBar(scene);
	if (scene.rounds > 1) out += captions(scene, state.round);
	// The marker travels the whole bar once per period, so one pass of the bar is one film and one segment is one round.
	const at = bar.left + ((bar.right - bar.left) * state.periodNow) / scene.period;
	return out + rectEl({ x: at - 0.9 * u, y: bar.y - 0.3 * u, w: 1.8 * u, h: 0.6 * u }, 0.3 * u, `fill="${theme.text}"`);
}

/** The filters both layers use. */
export function drawDefs(scene) {
	return `<defs><filter id="flow-glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="${px(scene.unit * 0.7)}"/></filter></defs>`;
}

export function svgOpen(scene) {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}">`;
}

/** One whole frame as an SVG document. */
export function frameSvg(scene, time) {
	return `${svgOpen(scene)}${drawDefs(scene)}${drawStatic(scene)}${drawLive(scene, stateAt(scene, time))}</svg>`;
}
