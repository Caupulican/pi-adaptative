/**
 * The state of a scene at one instant: where every item is, what every station is doing and what every rail shows. It
 * is a pure function of the scene and the time, read modulo the loop, so any frame can be drawn alone, the film plays
 * the same every time, and its last frame meets its first.
 */

import { batchAt, batchHitSchedule } from "./batch.mjs";
import { cornerPath, easeInOut, easeSpeed, pointAt } from "./geometry.mjs";
import { HOP_SECONDS, roundText } from "./metrics.mjs";
import { slotsAt } from "./slots.mjs";
import { runInRound } from "./stays.mjs";
import { keptText, trialAt } from "./trial.mjs";

/** How long the motion blur behind a moving item covers, in seconds of its travel. */
const TRAIL_SECONDS = 0.07;
const APPEAR_SECONDS = 0.18;
const EMIT_PULSE_SECONDS = 0.7;
const ARRIVE_PULSE_SECONDS = 1.8;
/** How long a rail's dots take to make room for a new one. */
export const RAIL_SLIDE_SECONDS = 0.5;
export const RAIL_RING_SECONDS = 1.4;
const PHASE_BLEND_SECONDS = 0.28;

function wrap(value, loop) {
	return ((value % loop) + loop) % loop;
}

function between(a, b, amount) {
	return { x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount };
}

/** Where an item rests inside the station of a stay. */
function restingPlace(segment) {
	const { node } = segment;
	if (node.kind === "queue") {
		const slot = node.shape.slots[segment.slot ?? 0];
		return { x: slot.x + slot.w / 2, y: slot.y + slot.h / 2 - 2 };
	}
	return node.shape.bench;
}

function itemOnWire(segment, local, first) {
	const span = segment.to - segment.from;
	const part = (local - segment.from) / span;
	const along = segment.wire.path.length * easeInOut(part);
	const at = pointAt(segment.wire.path, along);
	const trail = Math.min(along, (segment.wire.path.length / span) * easeSpeed(part) * TRAIL_SECONDS);
	return {
		x: at.x,
		y: at.y,
		angle: at.angle,
		tone: segment.tone,
		alpha: first ? Math.min(1, (local - segment.from) / APPEAR_SECONDS) : 1,
		trail: trail > 1 ? { path: segment.wire.path, from: along - trail, to: along } : undefined,
		carry: segment.carry,
		trial: segment.trial,
		carryAlpha: Math.min(1, Math.max(0, (Math.min(along, segment.wire.path.length - along) - 28) / 20)),
		passed: segment.passed,
		wire: segment.wire,
		pace: easeSpeed(part) / 3,
	};
}

function itemInStation(segment, local) {
	const since = local - segment.from;
	const left = segment.to - local;
	const rest = restingPlace(segment);
	let place = rest;
	let alpha = 1;
	if (since < HOP_SECONDS) place = between(segment.enter, rest, easeInOut(since / HOP_SECONDS));
	else if (left < HOP_SECONDS) {
		if (segment.exit) place = between(rest, segment.exit, easeInOut(1 - left / HOP_SECONDS));
		else alpha = left / HOP_SECONDS;
	}
	const failed = segment.result === "fail" && since / (segment.to - segment.from) > 0.8;
	return { x: place.x, y: place.y, angle: 0, tone: failed ? "fail" : segment.tone, alpha, trail: undefined };
}

/** What a station shows for the item it holds: its progress, and the phase it is in with the blend from the last. */
function stayOf(segment, local) {
	const since = local - segment.from;
	const progress = since / (segment.to - segment.from);
	const count = segment.phases.length;
	const index = count === 0 ? -1 : Math.min(count - 1, Math.floor(progress * count));
	const phaseStart = count === 0 ? 0 : (index / count) * (segment.to - segment.from);
	const failed = segment.result === "fail" && progress > 0.8;
	return {
		slot: segment.slot ?? 0,
		progress,
		since,
		left: segment.to - local,
		enter: segment.enter,
		exit: segment.exit,
		tone: failed ? "fail" : segment.tone,
		lane: segment.lane,
		laneTone: segment.laneTone,
		phases: segment.phases,
		phaseIndex: index,
		phase: failed ? (segment.text ?? "failed") : index >= 0 ? segment.phases[index] : undefined,
		before: !failed && index > 0 ? segment.phases[index - 1] : undefined,
		blend: failed ? 1 : Math.min(1, (since - phaseStart) / PHASE_BLEND_SECONDS),
		failed,
	};
}

/**
 * The dots a rail shows, newest first, with one more that is leaving while the rest make room. A film of one round shows
 * the record of a film that has always been running; a film of several shows only what landed since the period began,
 * so its first round starts empty and the record grows. A dot's mark takes the round it landed in.
 */
function railAt(scene, node, now, periodNow) {
	const landings = [];
	for (const run of scene.runs)
		for (const landing of run.landings)
			if (landing.node === node) {
				const at = run.start + landing.at;
				landings.push({ run, at, age: wrap(now - at, scene.loop), result: landing.result, mark: landing.mark, trial: landing.trial });
			}
	if (landings.length === 0) return { dots: [], slide: 1, newest: undefined, ring: undefined };
	landings.sort((a, b) => a.age - b.age);
	const dots = [];
	for (let cycle = 0; dots.length <= node.dots; cycle++) {
		let shown = 0;
		for (const landing of landings) {
			if (dots.length > node.dots) break;
			// The round the landing is from: the rounds that passed since it landed, less the ones already shown.
			const landed = Math.floor((periodNow - landing.at) / scene.loop) - cycle;
			if (scene.rounds > 1 && landed < 0) continue;
			const landedRound = scene.rounds > 1 ? landed : 0;
			if (!runInRound(landing.run, landedRound)) continue;
			dots.push({
				age: landing.age + cycle * scene.loop,
				result: landing.result,
				mark: roundText(keptText(landing.mark, scene, landing.trial, landedRound), landedRound, scene.vars),
			});
			shown++;
		}
		if (shown === 0) break;
	}
	if (dots.length === 0) return { dots: [], slide: 1, newest: undefined, ring: undefined };
	const newest = dots[0];
	return {
		dots,
		slide: easeInOut(Math.min(1, newest.age / RAIL_SLIDE_SECONDS)),
		newest,
		ring: newest.age < RAIL_RING_SECONDS ? newest.age / RAIL_RING_SECONDS : undefined,
	};
}

/** Match beads travelling from a `batch` station to a collector `card` at `now` inside `round`. */
function collectorBeads(scene, round, now) {
	const beads = [];
	for (const node of scene.nodes) {
		if (node.kind !== "card" || !node.sourceBatch) continue;
		const { hits } = batchHitSchedule(scene, node.sourceBatch, round);
		if (hits.length === 0) continue;
		const wire = scene.wires.find((entry) => entry.from.node === node.sourceBatch && entry.to.node === node);
		for (const hit of hits) {
			if (now < hit.emittedAt || now >= hit.arrivesAt) continue;
			const part = easeInOut((now - hit.emittedAt) / Math.max(0.05, hit.arrivesAt - hit.emittedAt));
			if (wire) {
				const startPt = wire.path.points[0];
				const endPt = wire.path.points[wire.path.points.length - 1];
				const activePath =
					wire.run === "level" && hit.fromX < startPt.x - 1
						? cornerPath([{ x: hit.fromX, y: startPt.y }, { x: endPt.x, y: endPt.y }], 0)
						: wire.path;
				const along = activePath.length * part;
				const at = pointAt(activePath, along);
				const trailLen = Math.min(along, activePath.length * 0.24 * Math.sin(part * Math.PI));
				beads.push({
					x: at.x,
					y: at.y,
					trail: trailLen > 1 ? { path: activePath, from: along - trailLen, to: along } : undefined,
				});
			} else {
				const start = { x: hit.fromX, y: node.sourceBatch.shape.ports.out.y };
				const end = node.shape.ports.in;
				const place = between(start, end, part);
				beads.push({ x: place.x, y: place.y, trail: undefined });
			}
		}
	}
	return beads;
}

/** How many times a repeating motion of about `period` seconds fits the loop, as a whole number so the loop closes. */
function cyclesIn(scene, period) {
	return Math.max(1, Math.round(scene.loop / period));
}

export function stateAt(scene, time) {
	const loop = scene.loop;
	// The time inside the round drives the journeys, the sweeps and the chains; the period is what the film repeats over.
	const now = wrap(time, loop);
	const periodNow = wrap(time, scene.period);
	const round = Math.floor(periodNow / loop);
	const items = [];
	const stays = new Map();
	const pulses = new Map();
	const pulse = (node, emitter, strength, tone) => {
		const key = `${node.id}:${emitter}`;
		if ((pulses.get(key)?.strength ?? 0) < strength) pulses.set(key, { strength, tone });
	};
	for (const run of scene.runs) {
		if (!runInRound(run, round)) continue;
		const local = wrap(now - run.start, loop);
		const originKind = run.from.node.kind;
		if ((originKind === "source" || originKind === "card" || originKind === "slots") && local < EMIT_PULSE_SECONDS)
			pulse(run.from.node, run.from.emitter ?? 0, 1 - local / EMIT_PULSE_SECONDS, run.segments[0]?.tone ?? "work");
		for (const arrival of run.arrivals) {
			const since = local - arrival.at;
			if (since >= 0 && since < ARRIVE_PULSE_SECONDS)
				pulse(arrival.node, arrival.emitter, 1 - since / ARRIVE_PULSE_SECONDS, run.segments.at(-1)?.tone ?? "work");
		}
		const index = run.segments.findIndex((segment) => local >= segment.from && local < segment.to);
		if (index < 0) continue;
		const segment = run.segments[index];
		if (segment.kind === "travel") {
			const item = itemOnWire(segment, local, index === 0);
			// What it carries may name the candidate its last trial kept in this round.
			items.push({ run, ...item, carry: keptText(item.carry, scene, item.trial, round) });
		} else {
			if (segment.node.kind !== "card" && segment.node.kind !== "batch")
				items.push({ run, ...itemInStation(segment, local) });
			const held = stays.get(segment.node.id) ?? [];
			held.push(stayOf(segment, local));
			stays.set(segment.node.id, held);
		}
	}
	const rails = new Map();
	const sweeps = new Map();
	const chains = new Map();
	const trials = new Map();
	const batches = new Map();
	const slots = new Map();
	for (const node of scene.nodes) {
		if (node.kind === "rail") rails.set(node.id, railAt(scene, node, now, periodNow));
		else if (node.kind === "trial") trials.set(node.id, trialAt(scene, node, now, round, stays.get(node.id)?.[0]));
		else if (node.kind === "batch") batches.set(node.id, batchAt(scene, node, now, round, stays.get(node.id)?.[0]));
		else if (node.kind === "slots") slots.set(node.id, slotsAt(scene, node, round, now));
		else if (node.kind === "sweep") {
			const turn = wrap((now * cyclesIn(scene, node.period)) / loop, 1);
			sweeps.set(node.id, 0.5 - 0.5 * Math.cos(2 * Math.PI * turn));
		} else if (node.kind === "chain" && node.pulse !== undefined) {
			// One pass lights the steps in turn and then rests for one beat, so a viewer sees where a pass ends.
			const turn = wrap((now * cyclesIn(scene, node.pulse)) / loop, 1) * (node.items.length + 1);
			chains.set(node.id, { step: Math.floor(turn), part: turn % 1 });
		}
	}
	const beads = collectorBeads(scene, round, now);
	return { now, periodNow, round, items, stays, pulses, rails, sweeps, chains, trials, batches, slots, beads };
}
