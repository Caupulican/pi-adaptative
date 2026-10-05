/**
 * The carrier: the one moving glyph of the flow views. It rides an edge's path while the edge is in
 * flight and for CARRIER_SETTLE_MS after the edge settles, then is gone; a settled edge is solid
 * glyphs only. Pure: where the carrier is is a function of (path length, the edge's timing, nowMs),
 * so a frame is replayable without a timer. The animator owns when frames are requested; this module
 * only answers where the carrier is and until when one is needed.
 */

/** The carrier glyph; the same one rides the sequence arrows and the diagram spine. */
export const CARRIER_GLYPH = "●";

/** A transition travels its path once, in this long. */
export const CARRIER_SETTLE_MS = 600;

/** An edge still in flight loops its carrier along the path with this period. */
export const CARRIER_LOOP_MS = 1200;

/**
 * The fast loop runs for this long from the edge's start (its last transition). After it the edge
 * keeps its static in-flight form and the carrier steps one cell per second of wall clock, driven by
 * the lane's existing one-second clock: no animation timer is held for an open edge.
 */
export const CARRIER_FLIGHT_MS = 4000;

/** The carrier's step cadence once the fast loop is over. */
export const CARRIER_STEP_MS = 1000;

export interface CarrierTiming {
	readonly startedAt: number;
	/** Absent while the edge is in flight. */
	readonly endedAt?: number;
}

/**
 * The index along a path of `length` cells where the carrier is at `nowMs`, or undefined when the
 * edge is settled and its last transition is older than CARRIER_SETTLE_MS (or the path is empty).
 */
export function carrierIndex(length: number, timing: CarrierTiming, nowMs: number): number | undefined {
	if (length <= 0) return undefined;
	if (timing.endedAt === undefined) {
		const elapsed = Math.max(0, nowMs - timing.startedAt);
		if (elapsed >= CARRIER_FLIGHT_MS) return Math.floor(nowMs / CARRIER_STEP_MS) % length;
		return Math.min(length - 1, Math.floor(((elapsed % CARRIER_LOOP_MS) / CARRIER_LOOP_MS) * length));
	}
	const since = Math.max(0, nowMs - timing.endedAt);
	if (since >= CARRIER_SETTLE_MS) return undefined;
	return Math.min(length - 1, Math.floor((since / CARRIER_SETTLE_MS) * length));
}

/**
 * The moment after which this edge needs no animation timer: the end of the fast loop while it is in
 * flight, the end of its settle window right after a transition, undefined once it is quiet. An open
 * edge past its fast loop is undefined too: its carrier is stepped by the lane's one-second clock.
 */
export function carrierActiveUntil(timing: CarrierTiming, nowMs: number): number | undefined {
	const until =
		timing.endedAt === undefined ? timing.startedAt + CARRIER_FLIGHT_MS : timing.endedAt + CARRIER_SETTLE_MS;
	return until > nowMs ? until : undefined;
}

/** An arrow between two lifeline cells of one row, in the row's own cell indexes. */
export interface ArrowGeometry {
	readonly from: number;
	readonly to: number;
}

/**
 * The row cell the carrier occupies on an arrow: only the cells strictly between the two lifelines
 * (the body and the head cell), never an endpoint, so it never leaves the arrow path.
 */
export function arrowCarrierCell(arrow: ArrowGeometry, timing: CarrierTiming, nowMs: number): number | undefined {
	const span = Math.abs(arrow.to - arrow.from) - 1;
	const step = carrierIndex(span, timing, nowMs);
	if (step === undefined) return undefined;
	return arrow.from + (arrow.to > arrow.from ? 1 : -1) * (step + 1);
}
