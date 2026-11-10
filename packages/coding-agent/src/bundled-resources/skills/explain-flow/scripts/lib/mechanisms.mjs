/**
 * What a worker station does to the item on its bench, drawn as a small mechanism. Each one is shaped by a kind of
 * work and has two states: at rest (quiet line colour) and working (the item's colour, moving with the time the item
 * has been there). A film picks the mechanism that matches what its station really does:
 *
 * - `scan`: a carriage passes back and forth over a ruler. Reading, measuring, checking against a rule.
 * - `stamp`: a head comes down on the item again and again. Signing, approving, sealing.
 * - `turn`: a ring of segments turns around the item and fills as the work advances. Building, transforming.
 * - `braid`: two strands come in and leave as one. Merging, joining, combining results.
 * - `focus`: four corner marks close on the item and open again. Reviewing, inspecting, judging.
 */

import { px } from "./geometry.mjs";
import { alphaOf, circleEl, lineEl, pathEl, rectEl, strokeOf } from "./svg.mjs";

export const MECHANISMS = ["scan", "stamp", "turn", "braid", "focus"];

/** A value that swings 0, 1, 0 once every `period` seconds, slow at both ends. */
function swing(seconds, period) {
	return 0.5 - 0.5 * Math.cos((seconds / period) * Math.PI * 2);
}

function scan({ u, rail, colour, quiet, since, failed }) {
	const thin = strokeOf(colour, u * 0.16);
	const ruler = `${strokeOf(quiet, u * 0.16)} opacity="0.55"`;
	let out = lineEl(rail.left, rail.top, rail.right, rail.top, ruler);
	for (let x = rail.left; x <= rail.right + 0.5; x += u) out += lineEl(x, rail.top, x, rail.top + 0.5 * u, ruler);
	const x = since === undefined ? rail.left : rail.left + (rail.right - rail.left) * (failed ? 0.5 : swing(since, 1.15));
	out += rectEl({ x: x - 0.7 * u, y: rail.top - 0.4 * u, w: 1.4 * u, h: 0.8 * u }, 0.2 * u, `fill="${colour}"`);
	return out + lineEl(x, rail.top + 0.4 * u, x, rail.base - 0.6 * u, thin);
}

function stamp({ u, bench, rail, colour, since, failed }) {
	const thin = strokeOf(colour, u * 0.16);
	// The head falls fast and rises slowly; a failure leaves it down on the item.
	const beat = since === undefined ? 0 : failed ? 1 : swing(since, 0.9) ** 3;
	const top = rail.top + 0.2 * u;
	const head = top + beat * (bench.y - 1.5 * u - top);
	let out = lineEl(bench.x, rail.top, bench.x, head, thin);
	out += rectEl({ x: bench.x - 2 * u, y: head, w: 4 * u, h: 0.7 * u }, 0.2 * u, `fill="${colour}"`);
	if (beat > 0.85)
		out += rectEl({ x: bench.x - 2.3 * u, y: bench.y - 1.5 * u, w: 4.6 * u, h: 3 * u }, 0.5 * u, `${thin} opacity="${alphaOf((beat - 0.85) * 6)}"`);
	return out;
}

function turn({ u, bench, colour, quiet, since, progress }) {
	const segments = 10;
	const radius = 2.5 * u;
	const lit = since === undefined ? 0 : Math.round(progress * segments);
	const spin = since === undefined ? 0 : since * 1.9;
	let out = "";
	for (let index = 0; index < segments; index++) {
		const from = spin + (index / segments) * Math.PI * 2;
		const to = from + (Math.PI * 2) / segments - 0.2;
		const d = `M${px(bench.x + Math.cos(from) * radius)} ${px(bench.y + Math.sin(from) * radius)}A${px(radius)} ${px(radius)} 0 0 1 ${px(bench.x + Math.cos(to) * radius)} ${px(bench.y + Math.sin(to) * radius)}`;
		out += pathEl(d, `${strokeOf(index < lit ? colour : quiet, u * 0.22, 'stroke-linecap="round"')} opacity="${index < lit ? 1 : 0.6}"`);
	}
	return out;
}

function braid({ u, bench, rail, colour, quiet, since, progress }) {
	const spread = 1.3 * u;
	const strand = (side) =>
		`M${px(rail.left)} ${px(bench.y + side * spread)}C${px(bench.x - 1.5 * u)} ${px(bench.y + side * spread)} ${px(bench.x - 1.5 * u)} ${px(bench.y)} ${px(bench.x)} ${px(bench.y)}`;
	let out = pathEl(strand(-1), `${strokeOf(quiet, u * 0.16)} opacity="0.7"`) + pathEl(strand(1), `${strokeOf(quiet, u * 0.16)} opacity="0.7"`);
	out += lineEl(bench.x, bench.y, rail.right, bench.y, `${strokeOf(quiet, u * 0.16)} opacity="0.7"`);
	if (since === undefined) return out;
	// A bead runs down each strand to the joint; the single strand out lights as far as the work has come.
	for (const side of [-1, 1]) {
		const t = (since / 0.8 + (side > 0 ? 0.5 : 0)) % 1;
		const eased = t * t * (3 - 2 * t);
		const x = rail.left + (bench.x - rail.left) * t;
		out += circleEl(x, bench.y + side * spread * (1 - eased), 0.35 * u, `fill="${colour}"`);
	}
	return out + lineEl(bench.x, bench.y, bench.x + (rail.right - bench.x) * progress, bench.y, strokeOf(colour, u * 0.22, 'stroke-linecap="round"'));
}

function focus({ u, bench, colour, since, failed }) {
	// Four corner marks: wide at rest, closing on the item while it is looked at, shut on a failure.
	const close = since === undefined ? 0 : failed ? 1 : swing(since, 1.3);
	const halfW = (3.6 - 1.4 * close) * u;
	const halfH = (2.4 - 1.0 * close) * u;
	const arm = 0.9 * u;
	const thin = strokeOf(colour, u * 0.18, 'stroke-linecap="round"');
	let out = "";
	for (const sx of [-1, 1])
		for (const sy of [-1, 1]) {
			const x = bench.x + sx * halfW;
			const y = bench.y + sy * halfH;
			out += pathEl(`M${px(x - sx * arm)} ${px(y)}L${px(x)} ${px(y)}L${px(x)} ${px(y - sy * arm)}`, thin);
		}
	return out;
}

const DRAW = { scan, stamp, turn, braid, focus };

/**
 * The mechanism of a worker: `since` is how long its item has been there (undefined at rest), `progress` how far its
 * work has come, `colour` the item's colour and `quiet` the line colour.
 */
export function drawMechanism(kind, parts) {
	return DRAW[kind](parts.since === undefined ? { ...parts, colour: parts.quiet } : parts);
}

/** Short marks beside a working station that flicker in turn: the sign that work is going on inside. */
export function activityMarks({ u, box, colour, since }) {
	let out = "";
	for (const [index, offset] of [-1.2, 0, 1.2].entries()) {
		const beat = (since * 3 + index * 0.33) % 1;
		const alpha = alphaOf(0.25 + 0.65 * (beat < 0.5 ? beat * 2 : 2 - beat * 2));
		const y = box.y + box.h / 2 + offset * u;
		out += lineEl(box.x - 1.6 * u, y, box.x - 0.8 * u, y, `${strokeOf(colour, u * 0.16, 'stroke-linecap="round"')} opacity="${alpha}"`);
		out += lineEl(box.x + box.w + 0.8 * u, y, box.x + box.w + 1.6 * u, y, `${strokeOf(colour, u * 0.16, 'stroke-linecap="round"')} opacity="${alpha}"`);
	}
	return out;
}
