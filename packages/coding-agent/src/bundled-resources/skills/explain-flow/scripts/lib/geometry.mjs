/**
 * Paths of a flow film. A wire is drawn from its exact SVG path and travelled along points sampled on it, so a token
 * moves at a known distance per second on any shape. Every function is pure.
 */

const CURVE_STEPS = 32;
const CORNER_STEPS = 8;

/** Rounds a coordinate for the SVG text: a tenth of a pixel is below what a frame shows. */
export function px(value) {
	return (Math.round(value * 10) / 10).toString();
}

function distance(a, b) {
	return Math.hypot(b.x - a.x, b.y - a.y);
}

/** A path: its SVG `d`, the points sampled along it, each point's distance from the start, and the whole length. */
function pathOf(d, points) {
	const lengths = [0];
	for (let index = 1; index < points.length; index++)
		lengths.push(lengths[index - 1] + distance(points[index - 1], points[index]));
	return { d, points, lengths, length: lengths[lengths.length - 1] };
}

/** How a curve leaves or meets a port along the outward normal of that port's edge. */
function portControl(port, reach) {
	if (port.side === "top") return { x: port.x, y: port.y - reach };
	if (port.side === "bottom") return { x: port.x, y: port.y + reach };
	if (port.side === "in") return { x: port.x - reach, y: port.y };
	return { x: port.x + reach, y: port.y };
}

/** A smooth cubic curve from `a` to `b` that leaves and arrives perpendicular to each port's edge. */
export function curvePath(a, b) {
	const vertical = a.side === "top" || a.side === "bottom" || b.side === "top" || b.side === "bottom";
	const span = vertical ? Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) : Math.abs(b.x - a.x);
	const reach = Math.max(span / 2, 16);
	const c1 = portControl(a, reach);
	const c2 = portControl(b, reach);
	const points = [];
	for (let step = 0; step <= CURVE_STEPS; step++) {
		const t = step / CURVE_STEPS;
		const u = 1 - t;
		points.push({
			x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
			y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
		});
	}
	const d = `M${px(a.x)} ${px(a.y)}C${px(c1.x)} ${px(c1.y)} ${px(c2.x)} ${px(c2.y)} ${px(b.x)} ${px(b.y)}`;
	return pathOf(d, points);
}

/** Straight runs through `corners`, each inner corner rounded by `radius` (less where a run is too short for it). */
export function cornerPath(corners, radius) {
	const first = corners[0];
	let d = `M${px(first.x)} ${px(first.y)}`;
	const points = [{ ...first }];
	for (let index = 1; index < corners.length - 1; index++) {
		const before = corners[index - 1];
		const corner = corners[index];
		const after = corners[index + 1];
		const cut = Math.min(radius, distance(before, corner) / 2, distance(corner, after) / 2);
		if (cut < 0.5) {
			d += `L${px(corner.x)} ${px(corner.y)}`;
			points.push({ ...corner });
			continue;
		}
		const inLength = distance(before, corner);
		const outLength = distance(corner, after);
		const enter = {
			x: corner.x + ((before.x - corner.x) * cut) / inLength,
			y: corner.y + ((before.y - corner.y) * cut) / inLength,
		};
		const leave = {
			x: corner.x + ((after.x - corner.x) * cut) / outLength,
			y: corner.y + ((after.y - corner.y) * cut) / outLength,
		};
		d += `L${px(enter.x)} ${px(enter.y)}Q${px(corner.x)} ${px(corner.y)} ${px(leave.x)} ${px(leave.y)}`;
		for (let step = 0; step <= CORNER_STEPS; step++) {
			const t = step / CORNER_STEPS;
			const u = 1 - t;
			points.push({
				x: u * u * enter.x + 2 * u * t * corner.x + t * t * leave.x,
				y: u * u * enter.y + 2 * u * t * corner.y + t * t * leave.y,
			});
		}
	}
	const last = corners[corners.length - 1];
	d += `L${px(last.x)} ${px(last.y)}`;
	points.push({ ...last });
	return pathOf(d, points);
}

/** The point `along` pixels from the start of `path`, and the direction of travel there in degrees. */
export function pointAt(path, along) {
	const target = Math.min(Math.max(along, 0), path.length);
	const { points, lengths } = path;
	let low = 0;
	let high = lengths.length - 1;
	while (high - low > 1) {
		const middle = (low + high) >> 1;
		if (lengths[middle] <= target) low = middle;
		else high = middle;
	}
	const from = points[low];
	const to = points[high] ?? from;
	const span = lengths[high] - lengths[low];
	const part = span > 0 ? (target - lengths[low]) / span : 0;
	return {
		x: from.x + (to.x - from.x) * part,
		y: from.y + (to.y - from.y) * part,
		angle: (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI,
	};
}

/** The SVG `d` of the piece of `path` between two distances from its start: a token's trail. */
export function pieceOf(path, from, to) {
	const start = Math.min(Math.max(from, 0), path.length);
	const end = Math.min(Math.max(to, start), path.length);
	const head = pointAt(path, start);
	let d = `M${px(head.x)} ${px(head.y)}`;
	for (let index = 0; index < path.points.length; index++) {
		const at = path.lengths[index];
		if (at <= start || at >= end) continue;
		d += `L${px(path.points[index].x)} ${px(path.points[index].y)}`;
	}
	const tail = pointAt(path, end);
	return `${d}L${px(tail.x)} ${px(tail.y)}`;
}

/** Slow at both ends, fast in the middle: how a token leaves one station and arrives at the next. */
export function easeInOut(t) {
	const clamped = Math.min(Math.max(t, 0), 1);
	return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - (-2 * clamped + 2) ** 3 / 2;
}

/** The slope of `easeInOut` at `t`, 0 at both ends and 3 in the middle: a token's speed as a multiple of its mean speed. */
export function easeSpeed(t) {
	const clamped = Math.min(Math.max(t, 0), 1);
	return clamped < 0.5 ? 12 * clamped * clamped : 12 * (1 - clamped) * (1 - clamped);
}

/** A value that rises from 0 to 1 over `rise` after `since`, for a change that fades in. */
export function fadeIn(since, rise) {
	return Math.min(Math.max(since / rise, 0), 1);
}
