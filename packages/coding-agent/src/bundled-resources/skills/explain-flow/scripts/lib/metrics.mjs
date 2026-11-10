/**
 * The film's sizes and its measure of words: the grid units every station is drawn in, the text sizes, and how wide a
 * text is. Reading a spec, laying it out and drawing it all count in these, so a station can be read and drawn in a
 * module of its own.
 */

/** Layout constants, in grid units. */
export const MARGIN = 4;
export const BAND_HEADER = 5;
/** Rows at the foot of the canvas kept for the loop bar and the two captions over it. */
export const FOOT_ROWS = 6;
export const STATION_RADIUS = 1.25;
export const CHIP_RADIUS = 0.5;
export const TEXT_SIZE = 1.75;
export const SMALL_TEXT_SIZE = 1.5;
/** The advance of one monospace character, as a share of the font size. */
export const CHAR_ADVANCE = 0.6;
export const LINE_STEP = 2.5;
/** The step between the lines under a station. */
export const SUB_STEP = 2.25;
/** How long an item takes to move between a station's port and its inside. */
export const HOP_SECONDS = 0.22;

/** A round token in words: `{round}`, or `{round+1}`, `{round-2}` for a shift. */
const ROUND_TOKEN = /\{round([+-]\d+)?\}/g;

/**
 * `text` with every round token replaced. A token is a round's number starting at 1, shifted by the whole offset it
 * writes, so in the first round `{round}` is 1 and `{round+1}` is 2. Text with no token comes back as it went in, and
 * undefined stays undefined.
 */
export function roundText(text, round) {
	if (text === undefined) return undefined;
	return text.replace(ROUND_TOKEN, (_, offset) => String(round + 1 + (offset === undefined ? 0 : Number(offset))));
}

/** The widest form of `text` over `rounds` rounds: a layout that measures it holds in every round. */
export function widestRoundText(text, rounds) {
	if (text === undefined) return undefined;
	let widest = roundText(text, 0);
	for (let round = 1; round < rounds; round++) {
		const form = roundText(text, round);
		if (form.length > widest.length) widest = form;
	}
	return widest;
}

/**
 * How wide `text` is at `size` pixels: every character of the film's one type family has the same advance. Text that
 * holds a round token is as wide as its widest form over `rounds` rounds.
 */
export function textWidth(text, size, rounds = 1) {
	return (widestRoundText(text, rounds)?.length ?? 0) * size * CHAR_ADVANCE;
}

/**
 * The ports of a boxed station. A wire enters on the left and leaves on the right; one may also meet the station above
 * or below, a little in from its left edge, so the station's words on that side start after the wire.
 */
export function boxPorts(box, u) {
	const middle = box.y + box.h / 2;
	const inset = box.x + 2.5 * u;
	return {
		in: { x: box.x, y: middle, side: "in" },
		out: { x: box.x + box.w, y: middle, side: "out" },
		top: { x: inset, y: box.y, side: "top" },
		bottom: { x: inset, y: box.y + box.h, side: "bottom" },
	};
}
