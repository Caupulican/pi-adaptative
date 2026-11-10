/**
 * Compiles a flow spec into a scene: every station placed in pixels, every wire routed, and every token's journey
 * turned into timed segments inside one loop. A spec that cannot be drawn truthfully (an unknown station, a journey
 * with no wire under it, two items in a one-item station) is refused with every problem named at once.
 *
 * Geometry is counted in grid units (`unit` pixels, 10 by default). Stations are a closed set, each shaped by what it
 * does: `source` (authors of work), `queue` (items wait in slots), `worker` (one item at a time, in phases), `rail` (the
 * record of what landed, newest first), `sweep` (a check that runs on a schedule), `chain` (named steps in order, also
 * as one row of a list with its name at the left), `tally` (a count shown as boxes), `note` (words only) and `trial`
 * (several candidates, each scored, one kept; see `trial.mjs`). The instruments, which hold no item and have no port
 * (`table`, `series`, a `tally` by rounds, and the lines of a `note` that follow a station), are read and shaped in
 * `instruments.mjs`.
 */

import { cornerPath, curvePath } from "./geometry.mjs";
import { MECHANISMS } from "./mechanisms.mjs";
import {
	BAND_HEADER,
	boxPorts,
	FOOT_ROWS,
	HOP_SECONDS,
	LINE_STEP,
	MARGIN,
	SMALL_TEXT_SIZE,
	SUB_STEP,
	TEXT_SIZE,
	textWidth,
	widestRoundText,
} from "./metrics.mjs";
import {
	NOTE_SIZES,
	readLinkedLines,
	readSeries,
	readTable,
	resolveLinks,
	shapeSeries,
	shapeTable,
	tallyMarks,
} from "./instruments.mjs";
import { isRecord, readNumber, readOneOf, readText, readTextList } from "./read.mjs";
import { resolveTheme } from "./theme.mjs";
import { shapeTrial, TRIAL_KEEPS, TRIAL_PHASES, trialCaptionLength } from "./trial.mjs";

export const TIERS = ["live", "next", "later"];
export const NODE_KINDS = ["source", "queue", "worker", "trial", "rail", "sweep", "chain", "tally", "note", "table", "series"];
/** The stations that hold an item for a stay; a queue holds one per slot, the others one at a time. */
const HOLDING_KINDS = ["queue", "worker", "trial"];
export const CHAIN_MODES = ["step", "fill", "together"];
export const TONES = ["work", "ok", "fail", "info", "text"];
const PORT_NAMES = ["in", "out", "top", "bottom"];
const ROUTES = ["curve", "elbow", "loop"];
const RESULTS = ["ok", "fail"];
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const ENDPOINT = /^([a-z][a-z0-9-]{0,31})(?::(\d+))?(?:\.(in|out|top|bottom))?$/;

/** Rows under a station kept for what it says about the item it holds (a worker: its lane, then its phase). */
const CAPTION_ROWS = { source: 0, queue: 0, worker: 2, trial: 1, rail: 0, sweep: 0, chain: 0, tally: 0, note: 0, table: 0, series: 0 };

/** The rows a station keeps under its body: its kind's, and for a rail whose landings carry marks one row for them. */
export function captionRows(node) {
	return CAPTION_ROWS[node.kind] + (node.marked ? 1 : 0);
}
const MIN_TRAVEL_SECONDS = 0.4;

export class SpecError extends Error {
	constructor(problems) {
		super(`The flow spec has ${problems.length} problem(s):\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
		this.name = "SpecError";
		this.problems = problems;
	}
}

/** Where a station's words start on one side: at its left edge, or after the wire that meets it on that side. */
export function wordsLeft(node, side, u) {
	const port = node.shape.ports[side];
	return port && node.usedPorts.has(side) ? port.x + 1.5 * u : node.shape.box.x;
}

/** The box, ports and inner geometry of one station, in pixels. `x`, `y` are the top left of its body. */
function shapeNode(node, x, y, u, rounds) {
	const side = (px, py, name) => ({ x: px, y: py, side: name });
	switch (node.kind) {
		case "source": {
			const pitch = node.pitch * u;
			const emitters = Array.from({ length: node.count }, (_, index) => {
				const top = y + index * pitch;
				return {
					lamp: { x: x + u, y: top + 1.5 * u },
					card: { x: x + 3 * u, y: top, w: 5 * u, h: 3 * u },
					in: side(x - 0.5 * u, top + 1.5 * u, "in"),
					out: side(x + 8 * u, top + 1.5 * u, "out"),
				};
			});
			return { box: { x, y, w: 8 * u, h: (node.count - 1) * pitch + 3 * u }, emitters, ports: {} };
		}
		case "queue": {
			const w = 7 * u;
			const h = node.slots * 4 * u + u;
			const slots = Array.from({ length: node.slots }, (_, index) => ({
				x: x + u,
				y: y + u + index * 4 * u,
				w: 5 * u,
				h: 3 * u,
			}));
			const box = { x, y, w, h };
			return { box, slots, ports: boxPorts(box, u) };
		}
		case "worker": {
			const box = { x, y, w: 11 * u, h: 7 * u };
			return { box, bench: { x: x + box.w / 2, y: y + box.h / 2 }, ports: boxPorts(box, u) };
		}
		case "trial":
			return shapeTrial(node, x, y, u);
		case "rail": {
			const pitch = 6 * u;
			const w = node.dots * pitch + 2 * u;
			const cy = y + u;
			return {
				box: { x, y, w, h: 2 * u },
				line: { x1: x, x2: x + w - u, y: cy },
				first: { x: x + 3 * u, y: cy },
				pitch,
				ports: { in: side(x, cy, "in"), out: side(x + w, cy, "out"), bottom: side(x + 3 * u, cy, "bottom") },
			};
		}
		case "sweep": {
			const box = { x, y, w: 14 * u, h: 4 * u };
			return { box, track: { x1: x + 2 * u, x2: x + box.w - 2 * u, y: y + box.h / 2 }, ports: boxPorts(box, u) };
		}
		case "tally": {
			// A tally by rounds writes a word under each box: its boxes stand as far apart as the widest word needs.
			const marks = tallyMarks(node, rounds);
			const pitch = Math.max(2.2, node.per ? textWidth(marks.widest, 1.2 * u) / u + 1 : 0);
			const boxes = Array.from({ length: node.boxes }, (_, index) => ({ x: x + index * pitch * u, y: y + 0.2 * u, w: 1.6 * u, h: 1.6 * u }));
			const words = { x: x + node.boxes * pitch * u + u, y: y + 1.6 * u };
			const said = textWidth(node.text ?? "", SMALL_TEXT_SIZE * u, rounds);
			return { box: { x, y, w: words.x - x + said, h: (marks.texts.length > 0 ? 4.2 : 2) * u }, boxes, words, ports: {} };
		}
		case "chain": {
			const size = SMALL_TEXT_SIZE * u;
			const gap = 3 * u;
			let cursor = x + (node.lead ?? 0) * u;
			const chips = node.items.map((item) => {
				const chip = { x: cursor, y, w: textWidth(item, size, rounds) + 3 * u, h: 3 * u, text: item };
				cursor += chip.w + gap;
				return chip;
			});
			const box = { x, y, w: cursor - gap - x, h: 3 * u };
			const first = chips[0] ?? box;
			return { box, chips, ports: { ...boxPorts(box, u), in: { x: first.x, y: y + 1.5 * u, side: "in" } } };
		}
		case "table":
			return shapeTable(node, x, y, u, rounds);
		case "series":
			return shapeSeries(node, x, y, u);
		default: {
			// A note: its lines at its size, the line step growing with the size in the same ratio.
			const scale = node.size === "text" ? 1 : NOTE_SIZES[node.size] / TEXT_SIZE;
			const size = TEXT_SIZE * u * scale;
			const w = Math.max(0, ...node.lines.map((line) => textWidth(line, size, rounds)));
			return { box: { x, y, w, h: Math.max(node.lines.length, 1) * LINE_STEP * u * scale }, ports: {} };
		}
	}
}

/** A trial's own scores: one list per round, one number from 0 to 1 per candidate. Undefined when the spec gives none. */
function readScores(raw, path, problems, rounds, count) {
	if (raw === undefined) return undefined;
	const shaped =
		Array.isArray(raw) &&
		raw.length === rounds &&
		raw.every((round) => Array.isArray(round) && round.length === count && round.every((score) => typeof score === "number"));
	if (!shaped) {
		problems.push(`${path}: must hold ${rounds} round(s) of ${count} numbers each, one score per candidate`);
		return undefined;
	}
	if (raw.some((round) => round.some((score) => !(score >= 0 && score <= 1)))) {
		problems.push(`${path}: every score must be from 0 to 1`);
		return undefined;
	}
	return raw;
}

function readNode(raw, path, bands, problems, rounds, marked) {
	if (!isRecord(raw)) {
		problems.push(`${path}: must be an object`);
		return undefined;
	}
	const id = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : undefined;
	if (!id) problems.push(`${path}.id: must be lowercase letters, digits and hyphens, starting with a letter`);
	const kind = readOneOf(raw.kind, NODE_KINDS, `${path}.kind`, problems);
	const band = bands.find((entry) => entry.id === raw.band) ?? (raw.band === undefined ? bands[0] : undefined);
	if (!band) problems.push(`${path}.band: names no band`);
	const at = Array.isArray(raw.at) && raw.at.length === 2 ? raw.at : undefined;
	if (!at) problems.push(`${path}.at: must be [column, row] in grid units from the band's top left`);
	const node = {
		id: id ?? `node-${path}`,
		kind,
		band: band ?? bands[0],
		column: readNumber(at?.[0], `${path}.at[0]`, problems, { min: 0, max: 400, fallback: 0 }),
		row: readNumber(at?.[1], `${path}.at[1]`, problems, { min: 0, max: 400, fallback: 0 }),
		label: readText(raw.label, `${path}.label`, problems),
		note: readText(raw.note, `${path}.note`, problems),
		value: readText(raw.value, `${path}.value`, problems),
		sub: readTextList(raw.sub, `${path}.sub`, problems, 4),
	};
	if (kind === "source") {
		node.count = readNumber(raw.count, `${path}.count`, problems, { min: 1, max: 8, fallback: 3, integer: true });
		node.pitch = readNumber(raw.pitch, `${path}.pitch`, problems, { min: 4, max: 16, fallback: 6 });
	} else if (kind === "worker") {
		node.mechanism = readOneOf(raw.mechanism, MECHANISMS, `${path}.mechanism`, problems, "scan");
	} else if (kind === "tally" && raw.per !== undefined) {
		// A tally by rounds: one box per round, the rounds that are over crossed, the round in hand lit.
		node.per = readOneOf(raw.per, ["round"], `${path}.per`, problems);
		if (raw.boxes !== undefined || raw.crossed !== undefined)
			problems.push(`${path}: a tally by rounds has one box per round; it takes no "boxes" and no "crossed"`);
		node.boxes = rounds;
		node.crossed = 0;
		node.text = readText(raw.text, `${path}.text`, problems);
		node.marks = readText(raw.marks, `${path}.marks`, problems);
	} else if (kind === "tally") {
		node.boxes = readNumber(raw.boxes, `${path}.boxes`, problems, { min: 1, max: 12, integer: true });
		node.crossed = readNumber(raw.crossed, `${path}.crossed`, problems, { min: 0, max: node.boxes, fallback: 0, integer: true });
		node.text = readText(raw.text, `${path}.text`, problems);
	} else if (kind === "trial") {
		node.count = readNumber(raw.count, `${path}.count`, problems, { min: 2, max: 12, fallback: 8, integer: true });
		node.keep = readOneOf(raw.keep, TRIAL_KEEPS, `${path}.keep`, problems, "highest");
		node.stem = readText(raw.stem, `${path}.stem`, problems) ?? "c";
		if (!/^[A-Za-z]{1,3}$/.test(node.stem)) problems.push(`${path}.stem: must be 1 to 3 letters`);
		node.scores = readScores(raw.scores, `${path}.scores`, problems, rounds, node.count);
	} else if (kind === "queue") {
		node.slots = readNumber(raw.slots, `${path}.slots`, problems, { min: 1, max: 6, fallback: 3, integer: true });
	} else if (kind === "rail") {
		node.marked = marked.has(node.id);
		node.dots = readNumber(raw.dots, `${path}.dots`, problems, { min: 3, max: 16, fallback: 7, integer: true });
		node.okText = readText(raw.okText, `${path}.okText`, problems);
		node.failText = readText(raw.failText, `${path}.failText`, problems);
	} else if (kind === "sweep") {
		node.period = readNumber(raw.period, `${path}.period`, problems, { min: 1, max: 600, fallback: 6 });
	} else if (kind === "chain") {
		node.items = readTextList(raw.items, `${path}.items`, problems, 8);
		if (node.items.length === 0) problems.push(`${path}.items: a chain needs at least one step`);
		node.pulse =
			raw.pulse === undefined ? undefined : readNumber(raw.pulse, `${path}.pulse`, problems, { min: 1, max: 600 });
		node.mode = readOneOf(raw.mode, CHAIN_MODES, `${path}.mode`, problems, "step");
		node.tag = readText(raw.tag, `${path}.tag`, problems);
		node.lead = raw.lead === undefined ? undefined : readNumber(raw.lead, `${path}.lead`, problems, { min: 4, max: 120 });
	} else if (kind === "note") {
		const lines = readLinkedLines(raw.lines, `${path}.lines`, problems, 6);
		node.lines = lines.texts;
		node.links = lines.links;
		node.size = readOneOf(raw.size, Object.keys(NOTE_SIZES), `${path}.size`, problems, "text");
	} else if (kind === "table") {
		readTable(raw, node, path, problems);
	} else if (kind === "series") {
		readSeries(raw, node, path, problems, rounds);
	}
	return node;
}

/** Splits `node`, `node:2` or `node.bottom` into its parts. */
function readEndpoint(value, path, nodes, problems) {
	const match = typeof value === "string" ? ENDPOINT.exec(value) : null;
	if (!match) {
		problems.push(`${path}: must name a station as "id", "id:emitter" or "id.port"`);
		return undefined;
	}
	const node = nodes.find((entry) => entry.id === match[1]);
	if (!node) {
		problems.push(`${path}: no station "${match[1]}"`);
		return undefined;
	}
	const index = match[2] === undefined ? undefined : Number(match[2]);
	if (node.kind === "source") {
		if (index !== undefined && (index < 1 || index > node.count)) {
			problems.push(`${path}: "${node.id}" has emitters 1 to ${node.count}`);
			return undefined;
		}
	} else if (index !== undefined) {
		problems.push(`${path}: only a source has numbered emitters`);
		return undefined;
	}
	return { node, emitter: index === undefined ? undefined : index - 1, port: match[3] };
}

/** The port an endpoint leaves from (`role` "from") or arrives at (`role` "to"). */
function portOf(endpoint, role, path, problems) {
	const { node, emitter, port } = endpoint;
	if (node.kind === "source") {
		const unit = node.shape.emitters[emitter ?? 0];
		return role === "from" ? unit.out : unit.in;
	}
	const name = port ?? (role === "from" ? "out" : "in");
	const found = node.shape.ports[name];
	if (!found) {
		problems.push(`${path}: a ${node.kind} has no "${name}" port`);
		return undefined;
	}
	return found;
}

/** The corner points of a route that leaves `a`, runs along `laneY` and enters `b`. */
function loopCorners(a, b, laneY, reach) {
	const corners = [{ x: a.x, y: a.y }];
	if (a.side === "top" || a.side === "bottom") corners.push({ x: a.x, y: laneY });
	else corners.push({ x: a.x + reach, y: a.y }, { x: a.x + reach, y: laneY });
	if (b.side === "top" || b.side === "bottom") corners.push({ x: b.x, y: laneY });
	else corners.push({ x: b.x - reach, y: laneY }, { x: b.x - reach, y: b.y });
	corners.push({ x: b.x, y: b.y });
	return corners;
}

function readWire(raw, path, nodes, scene, problems) {
	if (!isRecord(raw)) {
		problems.push(`${path}: must be an object`);
		return undefined;
	}
	const from = readEndpoint(raw.from, `${path}.from`, nodes, problems);
	const to = readEndpoint(raw.to, `${path}.to`, nodes, problems);
	if (!from || !to) return undefined;
	const a = portOf(from, "from", `${path}.from`, problems);
	const b = portOf(to, "to", `${path}.to`, problems);
	if (!a || !b) return undefined;
	const u = scene.unit;
	const route = readOneOf(raw.route, ROUTES, `${path}.route`, problems, "curve");
	const origin = { x: MARGIN * u, y: from.node.band.top + BAND_HEADER * u };
	let shape;
	if (Array.isArray(raw.via)) {
		const corners = [{ x: a.x, y: a.y }];
		for (const [index, point] of raw.via.entries()) {
			if (!Array.isArray(point) || point.length !== 2 || point.some((part) => typeof part !== "number")) {
				problems.push(`${path}.via[${index}]: must be [column, row] in grid units`);
				continue;
			}
			corners.push({ x: origin.x + point[0] * u, y: origin.y + point[1] * u });
		}
		corners.push({ x: b.x, y: b.y });
		shape = cornerPath(corners, 1.5 * u);
	} else if (route === "loop") {
		const lowest = Math.max(...nodes.filter((node) => node.band === from.node.band).map((node) => node.bottom));
		const laneY =
			raw.lane === undefined
				? lowest + 2 * u
				: origin.y + readNumber(raw.lane, `${path}.lane`, problems, { min: 0, max: 400 }) * u;
		shape = cornerPath(loopCorners(a, b, laneY, 2 * u), 1.5 * u);
	} else if (route === "elbow") {
		const bend = readNumber(raw.bend, `${path}.bend`, problems, { min: 0.05, max: 0.95, fallback: 0.5 });
		const middle = a.x + (b.x - a.x) * bend;
		shape = cornerPath([{ x: a.x, y: a.y }, { x: middle, y: a.y }, { x: middle, y: b.y }, { x: b.x, y: b.y }], 1.5 * u);
	} else if (Math.abs(a.y - b.y) < 0.5) shape = cornerPath([{ x: a.x, y: a.y }, { x: b.x, y: b.y }], 0);
	else shape = curvePath(a, b);
	return {
		id: typeof raw.id === "string" && ID.test(raw.id) ? raw.id : undefined,
		from,
		to,
		path: shape,
		// How the wire runs: along a lane it was given, level between two ports, or with a turn to another row.
		run: Array.isArray(raw.via) || route === "loop" ? "lane" : Math.abs(a.y - b.y) < 0.5 ? "level" : "turn",
		tier: from.node.band.tier,
		label: readText(raw.label, `${path}.label`, problems),
	};
}

function sameEnd(wireEnd, endpoint) {
	return (
		wireEnd.node === endpoint.node &&
		(endpoint.node.kind !== "source" || (wireEnd.emitter ?? 0) === (endpoint.emitter ?? 0)) &&
		(endpoint.port === undefined || wireEnd.port === undefined || wireEnd.port === endpoint.port)
	);
}

/** One token's journey as timed segments, counted from the journey's start. */
function readRun(raw, path, scene, problems) {
	if (!isRecord(raw)) {
		problems.push(`${path}: must be an object`);
		return undefined;
	}
	const { nodes, wires } = scene;
	const from = readEndpoint(raw.from, `${path}.from`, nodes, problems);
	const steps = Array.isArray(raw.steps) ? raw.steps : [];
	if (steps.length === 0) problems.push(`${path}.steps: a journey needs at least one step`);
	const run = {
		id: readText(raw.id, `${path}.id`, problems) ?? path,
		start: readNumber(raw.start, `${path}.start`, problems, { min: 0, max: scene.loop, fallback: 0 }),
		from,
		segments: [],
		landings: [],
		arrivals: [],
	};
	if (!from) return run;
	let here = from;
	let clock = 0;
	let tone = readOneOf(raw.tone, TONES, `${path}.tone`, problems, "work");
	let passed = false;
	/** The trial the item last stayed in: the words it carries from there on may name the kept candidate. */
	let trial;
	for (const [index, step] of steps.entries()) {
		const at = `${path}.steps[${index}]`;
		if (!isRecord(step)) {
			problems.push(`${at}: must be an object`);
			return run;
		}
		const to = readEndpoint(step.to, `${at}.to`, nodes, problems);
		if (!to) return run;
		const candidates = wires.filter(
			(wire) =>
				sameEnd(wire.from, here) && sameEnd(wire.to, to) && (step.wire === undefined || wire.id === step.wire),
		);
		if (candidates.length !== 1) {
			problems.push(
				`${at}: ${candidates.length === 0 ? "no wire" : "more than one wire"} from "${here.node.id}" to "${to.node.id}"${candidates.length === 0 ? "; declare it in wires" : '; give the wire an id and name it in "wire"'}`,
			);
			return run;
		}
		const wire = candidates[0];
		const travel = readNumber(step.travel, `${at}.travel`, problems, {
			min: 0.1,
			max: scene.loop,
			fallback: Math.max(MIN_TRAVEL_SECONDS, wire.path.length / scene.speed),
		});
		run.segments.push({
			kind: "travel",
			from: clock,
			to: clock + travel,
			wire,
			tone,
			passed,
			carry: readText(step.carry, `${at}.carry`, problems),
			trial,
		});
		clock += travel;
		const target = to.node;
		if (target.kind === "rail") {
			run.landings.push({
				node: target,
				at: clock,
				result: step.result === undefined ? undefined : readOneOf(step.result, RESULTS, `${at}.result`, problems),
				mark: readText(step.mark, `${at}.mark`, problems),
				trial,
			});
			here = to;
			if (index < steps.length - 1) problems.push(`${at}: a rail ends a journey; it has no step after it`);
			break;
		}
		if (target.kind === "source") {
			run.arrivals.push({ node: target, emitter: to.emitter ?? 0, at: clock });
			here = to;
			if (index < steps.length - 1) problems.push(`${at}: a source ends a journey; start a new one from it`);
			break;
		}
		if (!HOLDING_KINDS.includes(target.kind)) {
			problems.push(`${at}.to: an item travels to a queue, a worker, a trial, a rail or a source, not to a ${target.kind}`);
			return run;
		}
		const work = readNumber(step.work, `${at}.work`, problems, {
			min: HOP_SECONDS * 2 + 0.1,
			max: scene.loop,
			fallback: 1.2,
		});
		const result = step.result === undefined ? undefined : readOneOf(step.result, RESULTS, `${at}.result`, problems);
		run.segments.push({
			kind: "work",
			from: clock,
			to: clock + work,
			node: target,
			enter: wire.path.points[wire.path.points.length - 1],
			tone,
			phases: stayPhases(target, readTextList(step.phases, `${at}.phases`, problems, 6)),
			lane: readText(step.lane, `${at}.lane`, problems),
			laneTone: readOneOf(step.laneTone, TONES, `${at}.laneTone`, problems, "text"),
			result,
			text: readText(step.text, `${at}.text`, problems),
		});
		clock += work;
		if (target.kind === "trial") trial = target;
		passed = result === "ok";
		if (result === "fail") tone = "fail";
		else if (step.tone !== undefined) tone = readOneOf(step.tone, TONES, `${at}.tone`, problems, tone);
		here = to;
	}
	run.duration = clock;
	// A stay ends at the port its next wire leaves from, so the item slides out instead of jumping.
	for (const [index, segment] of run.segments.entries()) {
		if (segment.kind !== "work") continue;
		const next = run.segments[index + 1];
		segment.exit = next?.kind === "travel" ? next.wire.path.points[0] : undefined;
	}
	if (clock > scene.loop) problems.push(`${path}: the journey lasts ${clock.toFixed(1)} s, longer than the ${scene.loop} s loop`);
	return run;
}

/** The phases a stay shows: a trial always has its three, named by the step when it names three. */
function stayPhases(target, named) {
	if (target.kind !== "trial") return named;
	return named.length === TRIAL_PHASES.length ? named : TRIAL_PHASES;
}

/** Whether two stays overlap inside the loop, each given as a start in the loop and a length. */
function staysOverlap(a, b, loop) {
	const meets = (start, end, otherStart, otherEnd) => start < otherEnd && otherStart < end;
	for (const shift of [-loop, 0, loop])
		if (meets(a.start + shift, a.start + shift + a.length, b.start, b.start + b.length)) return true;
	return false;
}

/** Gives every stay in a queue its slot, and refuses a station that would hold more than it can. */
function assignPlaces(scene, problems) {
	for (const node of scene.nodes) {
		if (!HOLDING_KINDS.includes(node.kind)) continue;
		const stays = [];
		for (const run of scene.runs)
			for (const segment of run.segments)
				if (segment.kind === "work" && segment.node === node)
					stays.push({ segment, start: (run.start + segment.from) % scene.loop, length: segment.to - segment.from });
		stays.sort((a, b) => a.start - b.start);
		const places = node.kind === "queue" ? node.slots : 1;
		for (const stay of stays) {
			const taken = new Set(
				stays.filter((other) => other.slot !== undefined && staysOverlap(stay, other, scene.loop)).map((o) => o.slot),
			);
			let slot = 0;
			while (taken.has(slot)) slot++;
			if (slot >= places) {
				problems.push(
					`runs: "${node.id}" would hold ${slot + 1} items at ${stay.start.toFixed(1)} s; it ${node.kind === "queue" ? `has ${places} slot(s)` : "works on one item at a time"}`,
				);
				slot = places - 1;
			}
			stay.slot = slot;
			stay.segment.slot = slot;
		}
	}
}

/** The rows a station's lines take under its body: its captions, then its sub lines. */
function rowsBelow(node) {
	const lines = captionRows(node) + node.sub.length;
	return lines > 0 ? lines * SUB_STEP + 1 : 0;
}

/** The words a station writes above its body: its name and note, or for a rail the longest thing it can say. */
function labelText(node, rounds) {
	const notes = node.kind === "rail" ? [node.note, node.okText, node.failText] : [node.note];
	const longest = notes
		.filter(Boolean)
		.sort((a, b) => widestRoundText(b, rounds).length - widestRoundText(a, rounds).length)[0];
	return [node.label, longest].filter(Boolean).join(" · ");
}

/** The widest thing each station says about an item it holds (a worker's lane, phases and failure words), in pixels. */
function captionWidths(scene) {
	const size = TEXT_SIZE * scene.unit;
	const widths = new Map();
	for (const run of scene.runs)
		for (const segment of run.segments) {
			if (segment.kind !== "work") continue;
			const said = [segment.lane, segment.text, ...segment.phases].filter(Boolean);
			if (segment.node.kind === "trial") said.push("M".repeat(trialCaptionLength(segment.node, segment.phases)));
			const widest = Math.max(0, ...said.map((text) => textWidth(text, size, scene.rounds)));
			widths.set(segment.node, Math.max(widths.get(segment.node) ?? 0, widest));
		}
	return widths;
}

/** The rectangle the letters of one line of text cover, from the top of a tall letter to the foot of a low one. */
function lineRect(what, x, baseline, text, u, rounds, width) {
	return { what, x, y: baseline - 1.6 * u, w: width ?? textWidth(text, TEXT_SIZE * u, rounds), h: 2.1 * u };
}

/** The rectangles a station covers: its body, its lines above and its lines below. Text is measured, not guessed. */
function extents(node, u, captionWidth, rounds) {
	const { box } = node.shape;
	if (node.kind === "chain" && node.lead !== undefined) {
		// A list row: its name sits at the left on the chips' own line, its other lines under the name.
		const chipsLeft = box.x + node.lead * u;
		const rects = [{ what: "body", x: chipsLeft, y: box.y, w: box.x + box.w - chipsLeft, h: box.h }];
		rects.push(lineRect("label", box.x, box.y + 2 * u, [node.tag, node.label].filter(Boolean).join(" "), u, rounds));
		for (const [index, text] of [node.note, ...node.sub].filter(Boolean).entries())
			rects.push(lineRect("lines", box.x, box.y + 2 * u + (index + 1) * SUB_STEP * u, text, u, rounds));
		return rects;
	}
	const rects = [{ what: "body", x: box.x, y: box.y, w: box.w, h: box.h }];
	const label = labelText(node, rounds);
	const above = [];
	if (node.value) above.push(node.value);
	if (label) above.push(label);
	for (const [index, text] of above.entries())
		rects.push(lineRect("label", wordsLeft(node, "top", u), box.y - (1.5 + index * LINE_STEP) * u, text, u, rounds));
	const below = [...Array.from({ length: captionRows(node) }, () => undefined), ...node.sub];
	for (const [index, text] of below.entries())
		rects.push(lineRect("lines", wordsLeft(node, "bottom", u), box.y + box.h + (2.5 + index * SUB_STEP) * u, text ?? "", u, rounds, text === undefined ? captionWidth : undefined));
	// A rail's marks stand under its dots, along its whole line: that row is theirs.
	if (node.marked) rects.push({ what: "lines", x: box.x, y: box.y + box.h + 0.2 * u, w: box.w, h: 1.9 * u });
	return rects;
}

/** Whether a wire's path enters a rectangle, walking each of its pieces in steps of a few pixels. */
function wireCrosses(path, rect) {
	for (let index = 1; index < path.points.length; index++) {
		const a = path.points[index - 1];
		const b = path.points[index];
		const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
		for (let step = 0; step <= steps; step++) {
			const x = a.x + ((b.x - a.x) * step) / steps;
			const y = a.y + ((b.y - a.y) * step) / steps;
			if (x > rect.x && x < rect.x + rect.w && y > rect.y && y < rect.y + rect.h) return true;
		}
	}
	return false;
}

function checkLayout(scene, problems) {
	const u = scene.unit;
	const said = captionWidths(scene);
	const all = scene.nodes.map((node) => ({ node, rects: extents(node, u, said.get(node) ?? 0, scene.rounds) }));
	for (const { node, rects } of all) {
		const left = Math.min(...rects.map((rect) => rect.x));
		const right = Math.max(...rects.map((rect) => rect.x + rect.w));
		const top = Math.min(...rects.map((rect) => rect.y));
		const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
		const band = node.band;
		if (left < 0 || right > scene.width - MARGIN * u)
			problems.push(`nodes "${node.id}": it runs past the ${left < 0 ? "left" : "right"} edge (its widest line ends at column ${Math.round(right / u) - MARGIN}; the last column is ${Math.round(scene.width / u) - 2 * MARGIN})`);
		if (top < band.top + 3.5 * u || bottom > band.top + band.height)
			problems.push(`nodes "${node.id}": it does not fit inside band "${band.id}" (rows ${Math.round((top - band.top) / u) - BAND_HEADER} to ${Math.round((bottom - band.top) / u) - BAND_HEADER}; the band has ${Math.round(band.height / u) - BAND_HEADER})`);
	}
	// A wire never runs through words, nor through a station it does not end at.
	for (const [index, wire] of scene.wires.entries()) {
		const hit = all.find(({ node, rects }) =>
			rects.some((rect) => {
				const body = rect.what === "body";
				if (body && (node === wire.from.node || node === wire.to.node)) return false;
				const inset = body ? 0.2 * u : 0;
				return wireCrosses(wire.path, { x: rect.x + inset, y: rect.y + inset, w: rect.w - 2 * inset, h: rect.h - 2 * inset });
			}),
		);
		if (hit)
			problems.push(`wires[${index}] (${wire.from.node.id} to ${wire.to.node.id}): it runs through "${hit.node.id}" or its words; route it another way (a loop lane, via corners) or move the station`);
	}
	for (let first = 0; first < all.length; first++)
		for (let second = first + 1; second < all.length; second++) {
			// Two stations keep a clear strip between everything they draw: letters that nearly touch read as one.
			const hit = all[first].rects.flatMap((a) =>
				all[second].rects
					.filter((b) => {
						// Two lines of words side by side read as one line, and letters close under an outline read as part of it.
						const bodies = (a.what === "body" ? 1 : 0) + (b.what === "body" ? 1 : 0);
						const across = bodies === 0 ? 2 * u : 0.4 * u;
						const down = bodies === 1 ? u : 0.4 * u;
						return a.x - across < b.x + b.w && b.x < a.x + a.w + across && a.y - down < b.y + b.h && b.y < a.y + a.h + down;
					})
					.map((b) => [a, b]),
			)[0];
			if (hit)
				problems.push(`nodes "${all[first].node.id}" and "${all[second].node.id}": the ${hit[0].what} of one runs into the ${hit[1].what} of the other; move one or shorten its words`);
		}
}

/**
 * The rails whose landings carry a mark, read from the spec before anything is placed: such a rail keeps a row under
 * its line for the marks, and its place on the canvas must know that from the start.
 */
function markedRails(spec) {
	const ids = new Set();
	for (const run of Array.isArray(spec.runs) ? spec.runs : [])
		for (const step of isRecord(run) && Array.isArray(run.steps) ? run.steps : [])
			if (isRecord(step) && typeof step.mark === "string" && step.mark !== "" && typeof step.to === "string")
				ids.add(ENDPOINT.exec(step.to)?.[1]);
	return ids;
}

/**
 * Compiles a spec into its scene and lists every rule it breaks. The scene is complete enough to read (paths, journeys,
 * durations) even when problems are listed; only a spec with no readable bands or no object at all throws a `SpecError`.
 */
export function compileScene(spec) {
	const problems = [];
	if (!isRecord(spec)) throw new SpecError(["the spec must be a JSON object"]);
	const size = Array.isArray(spec.size) && spec.size.length === 2 ? spec.size : [1280, 800];
	const loop = readNumber(spec.loop, "loop", problems, { min: 2, max: 120, fallback: 12 });
	const rounds = readNumber(spec.rounds, "rounds", problems, { min: 1, max: 12, fallback: 1, integer: true });
	// A film repeats over its period: one round's seconds, times the rounds it runs.
	const period = loop * rounds;
	if (period > 120)
		problems.push(`rounds: ${rounds} round(s) of ${loop} s make a ${period} s period; a period is at most 120 s`);
	const scene = {
		title: readText(spec.title, "title", problems) ?? "Flow",
		width: readNumber(size[0], "size[0]", problems, { min: 320, max: 3840, integer: true }),
		height: readNumber(size[1], "size[1]", problems, { min: 240, max: 2160, integer: true }),
		unit: readNumber(spec.unit, "unit", problems, { min: 4, max: 24, fallback: 10 }),
		loop,
		rounds,
		period,
		fps: readNumber(spec.fps, "fps", problems, { min: 10, max: 60, fallback: 30, integer: true }),
		speed: readNumber(spec.speed, "speed", problems, { min: 60, max: 2400, fallback: 440 }),
		theme: resolveTheme(spec.theme, problems),
		clock: readText(spec.clock, "clock", problems),
		footer: readText(spec.footer, "footer", problems),
		bands: [],
		nodes: [],
		wires: [],
		runs: [],
	};
	if ((scene.width | scene.height) & 1) problems.push("size: both sides must be even numbers, as the video codec needs");
	const u = scene.unit;
	let top = 0;
	for (const [index, raw] of (Array.isArray(spec.bands) ? spec.bands : []).entries()) {
		const path = `bands[${index}]`;
		if (!isRecord(raw) || typeof raw.id !== "string" || !ID.test(raw.id)) {
			problems.push(`${path}.id: must be lowercase letters, digits and hyphens, starting with a letter`);
			continue;
		}
		const height = readNumber(raw.height, `${path}.height`, problems, { min: 8, max: 400 }) * u;
		scene.bands.push({
			id: raw.id,
			tier: readOneOf(raw.tier, TIERS, `${path}.tier`, problems, "live"),
			title: readText(raw.title, `${path}.title`, problems),
			note: readText(raw.note, `${path}.note`, problems),
			top,
			height,
		});
		top += height;
	}
	if (scene.bands.length === 0) problems.push("bands: at least one band is needed");
	if (top + FOOT_ROWS * u > scene.height)
		problems.push(`bands: together they take ${Math.round(top / u)} rows and the loop bar ${FOOT_ROWS}; the canvas has ${Math.floor(scene.height / u)}`);
	if (problems.length > 0 && scene.bands.length === 0) throw new SpecError(problems);

	const marked = markedRails(spec);
	const seen = new Set();
	for (const [index, raw] of (Array.isArray(spec.nodes) ? spec.nodes : []).entries()) {
		const node = readNode(raw, `nodes[${index}]`, scene.bands, problems, scene.rounds, marked);
		if (!node) continue;
		if (seen.has(node.id)) problems.push(`nodes[${index}].id: "${node.id}" is used twice`);
		seen.add(node.id);
		node.tier = node.band.tier;
		node.shape = shapeNode(node, (MARGIN + node.column) * u, node.band.top + (BAND_HEADER + node.row) * u, u, scene.rounds);
		node.bottom = node.shape.box.y + node.shape.box.h + rowsBelow(node) * u;
		node.usedPorts = new Set();
		scene.nodes.push(node);
	}
	if (scene.nodes.length === 0) problems.push("nodes: at least one station is needed");
	for (const [index, raw] of (Array.isArray(spec.wires) ? spec.wires : []).entries()) {
		const wire = readWire(raw, `wires[${index}]`, scene.nodes, scene, problems);
		if (!wire) continue;
		scene.wires.push(wire);
		wire.from.node.usedPorts.add(wire.from.port ?? "out");
		wire.to.node.usedPorts.add(wire.to.port ?? "in");
		for (const end of [wire.from, wire.to])
			if (end.node.marked && end.port === "bottom")
				problems.push(`wires[${index}]: it meets "${end.node.id}" from below, where that rail's marks stand; use another port, or land its items without a mark`);
	}
	for (const [index, raw] of (Array.isArray(spec.runs) ? spec.runs : []).entries()) {
		const run = readRun(raw, `runs[${index}]`, scene, problems);
		if (run) scene.runs.push(run);
	}
	resolveLinks(scene, problems);
	assignPlaces(scene, problems);
	checkLayout(scene, problems);
	return { scene, problems };
}

/** The scene of a spec, or a `SpecError` that names every problem. */
export function buildScene(spec) {
	const { scene, problems } = compileScene(spec);
	if (problems.length > 0) throw new SpecError(problems);
	return scene;
}

/** The beats of a scene in time order, one line each: what the storyboard review reads. */
export function storyboard(scene) {
	const beats = [];
	for (const run of scene.runs) {
		for (const segment of run.segments) {
			const from = run.start + segment.from;
			const to = run.start + segment.to;
			if (segment.kind === "travel")
				beats.push({ at: from, line: `${from.toFixed(1)}-${to.toFixed(1)} s  ${run.id} travels ${segment.wire.from.node.id} to ${segment.wire.to.node.id}${segment.carry ? ` carrying "${segment.carry}"` : ""}` });
			else
				beats.push({ at: from, line: `${from.toFixed(1)}-${to.toFixed(1)} s  ${run.id} at ${segment.node.id}${segment.phases.length > 0 ? ` (${segment.phases.join(", ")})` : ""}${segment.result ? `, ends ${segment.result}${segment.text ? `: ${segment.text}` : ""}` : ""}` });
		}
		for (const landing of run.landings)
			beats.push({ at: run.start + landing.at, line: `${(run.start + landing.at).toFixed(1)} s  ${run.id} lands on ${landing.node.id}${landing.result ? ` as ${landing.result}` : ""}` });
		for (const arrival of run.arrivals)
			beats.push({ at: run.start + arrival.at, line: `${(run.start + arrival.at).toFixed(1)} s  ${run.id} is back at ${arrival.node.id}:${arrival.emitter + 1}` });
	}
	return beats.sort((a, b) => a.at - b.at).map((beat) => beat.line);
}
