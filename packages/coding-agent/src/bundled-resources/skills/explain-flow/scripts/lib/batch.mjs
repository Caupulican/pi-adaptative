/**
 * The `batch` station: an ordered set of discrete items scanned or filtered during a stay, with per-round pruning of
 * skipped items, a caliper that steps across the active set, and match beads that travel to a collector card as hits
 * are found. Every instant is a pure function of the scene and the time inside the round.
 */

import { px } from "./geometry.mjs";
import { boxPorts, CHAR_ADVANCE, CHIP_RADIUS, roundText, SMALL_TEXT_SIZE, TEXT_SIZE } from "./metrics.mjs";
import { isRecord, readText, readTextList } from "./read.mjs";
import { staysAt } from "./stays.mjs";
import { alphaOf, circleEl, lineEl, rectEl, strokeOf, words } from "./svg.mjs";

const BATCH_SCAN_SHARE = 0.86;
const BATCH_BEAD_TRAVEL = 0.28;
const BATCH_TILE_H = 2.8;
const BATCH_TILE_GAP = 0.8;
const MAX_BATCH_ITEMS = 12;

function defaultBatchItems(count) {
	return Array.from({ length: count }, (_, index) => String(index + 1).padStart(2, "0"));
}

function readBatchPlanEntry(raw, items, path, problems) {
	if (!isRecord(raw)) {
		problems.push(`${path}: must be an object`);
		return { active: items, hits: [], outputs: {} };
	}
	const known = new Set(items);
	const active = raw.active === undefined ? items : readTextList(raw.active, `${path}.active`, problems, items.length);
	for (const tag of active) if (!known.has(tag)) problems.push(`${path}.active: "${tag}" is not in items`);
	const activeSet = new Set(active);
	const hits = raw.hits === undefined ? [] : readTextList(raw.hits, `${path}.hits`, problems, items.length);
	for (const tag of hits) if (!activeSet.has(tag)) problems.push(`${path}.hits: "${tag}" is not in active items`);
	const outputs = {};
	if (raw.outputs !== undefined) {
		if (!isRecord(raw.outputs)) problems.push(`${path}.outputs: must be an object mapping hit items to lines`);
		else
			for (const [key, value] of Object.entries(raw.outputs)) {
				if (!known.has(key)) problems.push(`${path}.outputs.${key}: "${key}" is not in items`);
				const line = readText(value, `${path}.outputs.${key}`, problems, true);
				if (line !== undefined) outputs[key] = line;
			}
	}
	return { active: active.length > 0 ? active : items, hits, outputs };
}

/** Reads a `batch` station's fields from a spec. */
export function readBatch(raw, node, path, problems, rounds) {
	if (raw.items !== undefined) {
		node.items = readTextList(raw.items, `${path}.items`, problems, MAX_BATCH_ITEMS);
		if (node.items.length < 2) problems.push(`${path}.items: a batch needs 2 to ${MAX_BATCH_ITEMS} items`);
		if (node.items.some((item) => item.length > 6)) problems.push(`${path}.items: each item tag must be at most 6 characters`);
	} else {
		const count = typeof raw.count === "number" && Number.isInteger(raw.count) ? raw.count : raw.count === undefined ? 8 : -1;
		if (count < 2 || count > MAX_BATCH_ITEMS) problems.push(`${path}.count: must be a whole number from 2 to ${MAX_BATCH_ITEMS}`);
		node.items = defaultBatchItems(Math.min(MAX_BATCH_ITEMS, Math.max(2, count < 2 ? 8 : count)));
	}
	node.idleText = readText(raw.idleText, `${path}.idleText`, problems) ?? "ready";
	node.unitWord = readText(raw.unitWord, `${path}.unitWord`, problems) ?? "checked";
	if (raw.plan !== undefined) {
		if (!Array.isArray(raw.plan) || (raw.plan.length !== 1 && raw.plan.length !== rounds)) {
			problems.push(`${path}.plan: must hold 1 or ${rounds} round plan(s)`);
			node.plan = [ { active: node.items, hits: [], outputs: {} } ];
		} else node.plan = raw.plan.map((entry, index) => readBatchPlanEntry(entry, node.items, `${path}.plan[${index}]`, problems));
	} else {
		node.plan = [
			readBatchPlanEntry(
				{ active: raw.active, hits: raw.hits, outputs: raw.outputs },
				node.items,
				path,
				problems,
			),
		];
	}
}

/** The box, tile geometry and ports of a `batch`, in pixels. */
export function shapeBatch(node, x, y, u) {
	const widestChars = Math.max(2, ...node.items.map((item) => item.length));
	const tileW = Math.max(3.1, widestChars * SMALL_TEXT_SIZE * CHAR_ADVANCE + 1.4) * u;
	const tileH = BATCH_TILE_H * u;
	const gap = BATCH_TILE_GAP * u;
	const w = node.items.length * tileW + (node.items.length - 1) * gap;
	const tiles = node.items.map((tag, index) => ({
		tag,
		x: x + index * (tileW + gap),
		y,
		w: tileW,
		h: tileH,
	}));
	const box = { x, y, w, h: tileH };
	return {
		box,
		bench: { x: x + w / 2, y: y + tileH / 2 },
		tileW,
		tileH,
		gap,
		tiles,
		ports: boxPorts(box, u),
	};
}

/** The plan of `node` in `round` (0-based). */
export function batchPlanFor(node, round) {
	return node.plan[Math.min(round, node.plan.length - 1)];
}

/** Where the active tiles of `node` sit in `round`, flush-left inside its rack. */
export function batchActiveTiles(node, round) {
	const plan = batchPlanFor(node, round);
	const { box, tileW, tileH, gap } = node.shape;
	return plan.active.map((tag, index) => ({
		tag,
		hit: plan.hits.includes(tag),
		output: plan.outputs[tag] ?? tag,
		x: box.x + index * (tileW + gap),
		y: box.y,
		w: tileW,
		h: tileH,
	}));
}

/**
 * Every hit of `node` in `round` with the second inside the round at which its tile finishes scanning (`emittedAt`) and
 * the second at which its bead reaches a collector (`arrivesAt`). Shared by the wire bead and the collector card so the
 * two never disagree.
 */
export function batchHitSchedule(scene, node, round) {
	const stays = staysAt(scene, node, round);
	if (stays.length === 0) return { stays: [], hits: [] };
	const stay = stays[stays.length - 1];
	const tiles = batchActiveTiles(node, round);
	const scanSpan = (stay.end - stay.start) * BATCH_SCAN_SHARE;
	const hits = [];
	for (const [index, tile] of tiles.entries()) {
		if (!tile.hit) continue;
		const emittedAt = stay.start + ((index + 1) / tiles.length) * scanSpan;
		hits.push({
			tag: tile.tag,
			output: tile.output,
			emittedAt,
			arrivesAt: Math.min(scene.loop - 0.02, emittedAt + BATCH_BEAD_TRAVEL),
			fromX: tiles[tiles.length - 1].x + tiles[tiles.length - 1].w,
		});
	}
	return { stays, stay, hits };
}

/** What a `batch` shows at one instant inside `round`. */
export function batchAt(scene, node, now, round, stay) {
	const tiles = batchActiveTiles(node, round);
	if (stay) {
		const scanPart = Math.min(1, Math.max(0, stay.progress / BATCH_SCAN_SHARE));
		const checked = Math.min(tiles.length, Math.floor(scanPart * tiles.length));
		return {
			mode: "live",
			round,
			tiles,
			checked,
			current: scanPart < 1 ? checked : -1,
			failed: stay.failed,
		};
	}
	const stays = staysAt(scene, node, round);
	if (stays.some((window) => window.end <= now))
		return { mode: "settled", round, tiles, checked: tiles.length, current: -1, failed: false };
	return { mode: "idle", round, tiles, checked: 0, current: -1, failed: false };
}

function batchTileLabel(scene, tile, fill, alpha = 1) {
	const u = scene.unit;
	return words(
		scene,
		tile.x + tile.w / 2,
		tile.y + tile.h / 2 + 0.48 * u,
		SMALL_TEXT_SIZE * u,
		[{ text: tile.tag, fill, bold: fill !== scene.theme.dim }],
		"middle",
		alpha,
	);
}

/** A batch's static body: drawn in the still layer only when the active tile set never changes across rounds. */
export function batchBody(scene, node, stroke) {
	const varies = scene.rounds > 1 && node.plan.length > 1;
	if (varies) return "";
	const u = scene.unit;
	let out = "";
	for (const tile of node.shape.tiles) {
		out += rectEl(tile, CHIP_RADIUS * u, stroke);
		out += batchTileLabel(scene, tile, scene.theme.dim, 0.9);
	}
	return out;
}

/** A batch's live layer: active tiles, caliper sweep, bridged wire across pruned slots, and progress caption. */
export function batchLive(scene, node, view, colour, caption, wireAlpha) {
	if (!view) return "";
	const u = scene.unit;
	const { theme } = scene;
	const { shape } = node;
	const varies = scene.rounds > 1 && node.plan.length > 1;
	const tiles = view.tiles;
	let out = "";
	if (varies) {
		const stroke = strokeOf(theme.line, u * 0.15);
		for (const tile of tiles) {
			out += rectEl(tile, CHIP_RADIUS * u, `${stroke} opacity="0.8"`);
			out += batchTileLabel(scene, tile, theme.dim, 0.85);
		}
		const last = tiles[tiles.length - 1];
		const rightEdge = shape.box.x + shape.box.w;
		if (last && node.usedPorts.has("out")) {
			const midY = shape.box.y + shape.box.h / 2;
			out += circleEl(last.x + last.w, midY, 0.42 * u, `fill="${theme.line}" opacity="0.8"`);
			if (last.x + last.w < rightEdge - 0.5)
				out += lineEl(last.x + last.w, midY, rightEdge, midY, `${strokeOf(theme.line, u * 0.13)} opacity="${alphaOf(wireAlpha)}"`);
		}
	}
	if (view.mode !== "idle") {
		for (const [index, tile] of tiles.entries()) {
			if (index === view.current) {
				const activeTone = view.failed ? theme.fail : colour;
				out += rectEl(tile, CHIP_RADIUS * u, `fill="${activeTone}" fill-opacity="0.24" stroke="${activeTone}" stroke-width="${px(u * 0.18)}"`);
				out += batchTileLabel(scene, tile, theme.text);
				// Caliper mark above and below the scanned tile.
				const cx = tile.x + tile.w / 2;
				out += lineEl(cx - 0.65 * u, tile.y - 0.55 * u, cx + 0.65 * u, tile.y - 0.55 * u, strokeOf(activeTone, u * 0.24, 'stroke-linecap="round"'));
				out += lineEl(cx, tile.y - 0.55 * u, cx, tile.y, strokeOf(activeTone, u * 0.16));
				out += lineEl(cx, tile.y + tile.h, cx, tile.y + tile.h + 0.55 * u, strokeOf(activeTone, u * 0.16));
			} else if (index < view.checked && tile.hit) {
				const alpha = view.mode === "settled" ? 0.88 : 1;
				out += rectEl(tile, CHIP_RADIUS * u, `fill="${theme.ok}" fill-opacity="0.2" stroke="${theme.ok}" stroke-width="${px(u * 0.17)}" opacity="${alphaOf(alpha)}"`);
				out += batchTileLabel(scene, tile, theme.ok, alpha);
			}
		}
	} else {
		// Idle caliper resting at the start of the rack.
		const first = tiles[0];
		if (first) {
			out += lineEl(first.x - 0.3 * u, first.y - 0.45 * u, first.x + 0.5 * u, first.y - 0.45 * u, `${strokeOf(theme.dim, u * 0.16, 'stroke-linecap="round"')} opacity="0.55"`);
			out += lineEl(first.x + 0.1 * u, first.y - 0.45 * u, first.x + 0.1 * u, first.y + first.h + 0.45 * u, `${strokeOf(theme.dim, u * 0.12)} opacity="0.45"`);
		}
	}
	const said =
		view.mode === "idle"
			? roundText(node.idleText, view.round, scene.vars)
			: `${view.checked} / ${tiles.length} ${roundText(node.unitWord, view.round, scene.vars)}`;
	const ink = view.mode === "live" ? theme.text : theme.dim;
	return out + words(scene, caption.x, caption.y, TEXT_SIZE * u, [{ text: said, fill: ink }]);
}

/** The widest caption a `batch` writes under its tiles, in characters. */
export function batchCaptionLength(node, rounds, vars) {
	const countDigits = String(node.items.length).length;
	const idle = roundText(node.idleText, 0, vars)?.length ?? 0;
	let unitLen = 0;
	for (let round = 0; round < rounds; round++)
		unitLen = Math.max(unitLen, (roundText(node.unitWord, round, vars) ?? "").length);
	return Math.max(idle, countDigits * 2 + 4 + unitLen);
}
