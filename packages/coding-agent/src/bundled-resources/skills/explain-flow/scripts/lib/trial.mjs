/**
 * The `trial` station: several candidates are made, each is scored, one is kept. This module holds what only a trial
 * knows: its shape (a gate where the item waits and a rack with one foot and one bar per candidate), the outcome of a
 * round (the scores and the kept candidate), what it shows at one instant, and its drawing. Reading its fields from a
 * spec stays with the other stations in `scene.mjs`.
 *
 * Any single frame is right on its own: what a trial shows is computed from the journeys' times and the instant, never
 * from an earlier frame. At rest it is line and text; a state colour appears only while candidates are tried, and the
 * last outcome stays in a quiet tone until the next item arrives.
 */

import { easeInOut, px } from "./geometry.mjs";
import { boxPorts, CHIP_RADIUS, TEXT_SIZE } from "./metrics.mjs";
import { alphaOf, lineEl, rectEl, strokeOf, words } from "./svg.mjs";

/** The three phases of a stay, with the share of the stay each takes. */
export const TRIAL_PHASES = ["propose", "score", "keep"];
const TRIAL_PHASE_SHARES = [0.3, 0.45, 0.25];
export const TRIAL_KEEPS = ["highest", "lowest"];
/** The token a journey's words may hold after a stay at a trial: the kept candidate's name. */
const TRIAL_KEPT_TOKEN = /\{kept\}/g;

/** Rack geometry, in grid units. */
const TRIAL_GATE = 4.5;
const TRIAL_FOOT = { w: 2.5, h: 2, gap: 0.75 };
const TRIAL_BAR = { w: 1.25, max: 5 };
const TRIAL_PAD = 1;
/** The size of a candidate's name inside its foot: the small label size the rail's marks use. */
const TRIAL_NAME_SIZE = 1.2;

export function candidateName(node, index) {
	return `${node.stem}${index + 1}`;
}

/** The box, gate, rack and ports of a trial, in pixels. `x`, `y` are the top left of its body. */
export function shapeTrial(node, x, y, u) {
	const rackLeft = x + TRIAL_GATE * u;
	const w = (TRIAL_GATE + node.count * TRIAL_FOOT.w + (node.count - 1) * TRIAL_FOOT.gap + TRIAL_PAD) * u;
	const h = (TRIAL_PAD + TRIAL_BAR.max + 0.5 + TRIAL_FOOT.h + TRIAL_PAD) * u;
	const base = y + (TRIAL_PAD + TRIAL_BAR.max) * u;
	const cells = Array.from({ length: node.count }, (_, index) => {
		const left = rackLeft + index * (TRIAL_FOOT.w + TRIAL_FOOT.gap) * u;
		return {
			foot: { x: left, y: base + 0.5 * u, w: TRIAL_FOOT.w * u, h: TRIAL_FOOT.h * u },
			bar: { x: left + ((TRIAL_FOOT.w - TRIAL_BAR.w) / 2) * u, w: TRIAL_BAR.w * u },
		};
	});
	const box = { x, y, w, h };
	return {
		box,
		// The item waits at the gate while its candidates are tried.
		bench: { x: x + (TRIAL_GATE / 2) * u, y: y + h / 2 },
		base,
		line: { x1: rackLeft - 0.5 * u, x2: x + w - 0.5 * u },
		cells,
		ports: boxPorts(box, u),
	};
}

/** A small whole-number hash of a text, the same on every machine. */
function textHash(text) {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

/**
 * The scores of a trial's candidates in one round and the index of the kept one. A spec's own `scores` are used as
 * given; without them the scores are a fixed function of the station, the round and the candidate, so the same frame is
 * always drawn the same: from 0.15 to 0.95, a little higher with each round. A tie keeps the candidate with the lower index.
 */
export function trialOutcome(scene, node, round) {
	const scores =
		node.scores?.[round] ??
		Array.from({ length: node.count }, (_, index) => {
			const share = (textHash(`${node.id}/${round}/${index}`) % 10000) / 10000;
			const lift = (0.25 * round) / Math.max(1, scene.rounds - 1);
			return Math.round((0.15 + 0.55 * share + lift) * 100) / 100;
		});
	let kept = 0;
	for (let index = 1; index < scores.length; index++)
		if (node.keep === "lowest" ? scores[index] < scores[kept] : scores[index] > scores[kept]) kept = index;
	return { scores, kept };
}

/** `text` with the kept candidate's name of `trial` in `round` in place of every `{kept}`. */
export function keptText(text, scene, trial, round) {
	if (text === undefined || trial === undefined) return text;
	return text.replace(TRIAL_KEPT_TOKEN, () => candidateName(trial, trialOutcome(scene, trial, round).kept));
}

/** The stays of every journey at this trial, as times inside one round. */
function trialStays(scene, node) {
	const stays = [];
	for (const run of scene.runs)
		for (const segment of run.segments)
			if (segment.kind === "work" && segment.node === node)
				stays.push({ start: run.start + segment.from, end: run.start + segment.to });
	return stays;
}

/**
 * The time inside a round at which this trial's kept candidate is known: the start of the keep phase of its last stay.
 * Undefined when no journey stays here. What the rounds add up to (a series) grows at this moment.
 */
export function trialKeptAt(scene, node) {
	const stays = trialStays(scene, node);
	if (stays.length === 0) return undefined;
	const last = stays.reduce((latest, stay) => (stay.end > latest.end ? stay : latest));
	return last.start + (TRIAL_PHASE_SHARES[0] + TRIAL_PHASE_SHARES[1]) * (last.end - last.start);
}

/**
 * What a trial shows at one instant: the stay in hand (its round, and how far it is), or the outcome that the last
 * finished stay left, or nothing before the first stay of the period. A film of one round has always been running, so
 * its trial shows the outcome of the loop before.
 */
export function trialAt(scene, node, now, round, stay) {
	if (stay) return { live: true, round, progress: stay.progress, failed: stay.failed };
	const stays = trialStays(scene, node);
	if (stays.length === 0) return undefined;
	if (stays.some((window) => window.end <= now)) return { live: false, round };
	if (scene.rounds === 1) return { live: false, round: 0 };
	return round > 0 ? { live: false, round: round - 1 } : undefined;
}

/** Which phase a stay is in, and how far through it, from its progress. */
function trialPhaseOf(progress) {
	let from = 0;
	for (const [index, share] of TRIAL_PHASE_SHARES.entries()) {
		if (progress < from + share || index === TRIAL_PHASE_SHARES.length - 1)
			return { index, part: Math.min(1, Math.max(0, (progress - from) / share)) };
		from += share;
	}
	return { index: 0, part: 0 };
}

/** How far a thing that takes its turn among `count` has come at `part` of a phase, each turn overlapping the next. */
function trialTurnOf(part, index, count, overlap) {
	return Math.min(1, Math.max(0, (part * (count + overlap - 1) - index) / overlap));
}

/** A trial's body: its outline, the line the bars stand on, and one foot per candidate with its name. */
export function trialBody(scene, node, stroke, faint, radius) {
	const u = scene.unit;
	const { shape } = node;
	let out = rectEl(shape.box, radius, stroke) + lineEl(shape.line.x1, shape.base, shape.line.x2, shape.base, faint);
	for (const [index, cell] of shape.cells.entries()) {
		out += rectEl(cell.foot, CHIP_RADIUS * u, faint);
		out += trialFootName(scene, node, cell, index, scene.theme.dim, 0.8);
	}
	return out;
}

function trialFootName(scene, node, cell, index, fill, alpha) {
	const u = scene.unit;
	const name = candidateName(node, index).toUpperCase();
	return `<g letter-spacing="${px(u * 0.08)}">${words(scene, cell.foot.x + cell.foot.w / 2, cell.foot.y + cell.foot.h / 2 + 0.42 * u, TRIAL_NAME_SIZE * u, [{ text: name, fill }], "middle", alpha)}</g>`;
}

/** A bar standing on the rack's line: square at the line, rounded at its data end. */
function trialBarEl(scene, shape, cell, score, attrs) {
	const u = scene.unit;
	const height = Math.max(0, score) * TRIAL_BAR.max * u;
	if (height < 0.5) return "";
	const round = Math.min(0.4 * u, height / 2, cell.bar.w / 2);
	const { x, w } = cell.bar;
	const top = shape.base - height;
	return `<path d="M${px(x)} ${px(shape.base)}V${px(top + round)}Q${px(x)} ${px(top)} ${px(x + round)} ${px(top)}H${px(x + w - round)}Q${px(x + w)} ${px(top)} ${px(x + w)} ${px(top + round)}V${px(shape.base)}Z" ${attrs}/>`;
}

/**
 * What a trial shows now, over its body: the feet and bars of the stay in hand, or the quiet outcome of the last one,
 * and under the body the phase or the kept candidate with its score. `caption` is where that line starts.
 */
export function trialLive(scene, node, view, colour, caption) {
	if (view === undefined) return "";
	const u = scene.unit;
	const { theme } = scene;
	const { shape } = node;
	const { scores, kept } = trialOutcome(scene, node, view.round);
	const outcome = `${candidateName(node, kept)} · ${scores[kept].toFixed(2)}`;
	const size = TEXT_SIZE * u;
	let out = "";
	if (!view.live) {
		// The last outcome stays, quiet, until the next item arrives.
		for (const [index, cell] of shape.cells.entries()) {
			const isKept = index === kept;
			out += trialBarEl(scene, shape, cell, scores[index], `fill="${isKept ? theme.ok : theme.dim}" opacity="${isKept ? 0.5 : 0.3}"`);
			if (isKept) out += rectEl(cell.foot, CHIP_RADIUS * u, `${strokeOf(theme.ok, u * 0.16)} opacity="0.5"`);
		}
		return out + words(scene, caption.x, caption.y, size, [{ text: outcome, fill: theme.dim }]);
	}
	const phase = trialPhaseOf(view.progress);
	const count = shape.cells.length;
	for (const [index, cell] of shape.cells.entries()) {
		const isKept = index === kept;
		// Propose: the feet light one after another. Score: each bar rises in its turn. Keep: one stays, the rest go quiet.
		const lit = phase.index === 0 ? trialTurnOf(phase.part, index, count, 2) : 1;
		const risen = phase.index === 0 ? 0 : phase.index === 1 ? easeInOut(trialTurnOf(phase.part, index, count, 3)) : 1;
		const settled = phase.index === 2 ? easeInOut(Math.min(1, phase.part * 2.5)) : 0;
		const footColour = settled > 0 && isKept ? theme.ok : colour;
		const footAlpha = isKept ? lit : lit * (1 - settled);
		if (footAlpha > 0.01) {
			out += rectEl(cell.foot, CHIP_RADIUS * u, `fill="${footColour}" fill-opacity="${alphaOf(0.14 * footAlpha)}" stroke="${footColour}" stroke-width="${px(u * 0.16)}" opacity="${alphaOf(footAlpha)}"`);
			out += trialFootName(scene, node, cell, index, theme.text, footAlpha);
		}
		if (risen <= 0.01) continue;
		const barColour = settled === 0 ? colour : isKept ? theme.ok : theme.dim;
		const barAlpha = isKept || settled === 0 ? 1 : 1 - 0.7 * settled;
		out += trialBarEl(scene, shape, cell, scores[index] * risen, `fill="${barColour}" opacity="${alphaOf(barAlpha)}"`);
	}
	const said = phase.index === 2 ? outcome : (view.phases?.[phase.index] ?? TRIAL_PHASES[phase.index]);
	const enter = Math.min(1, phase.part * 6);
	return out + words(scene, caption.x, caption.y + (1 - enter) * 0.6 * u, size, [{ text: said, fill: phase.index === 2 ? theme.text : theme.dim }], "start", enter);
}

/** The widest thing a trial says under its body, in characters: a phase name or a kept candidate with its score. */
export function trialCaptionLength(node, phases) {
	const outcome = `${candidateName(node, node.count - 1)} · 0.00`.length;
	return Math.max(outcome, ...phases.map((phase) => phase.length));
}
