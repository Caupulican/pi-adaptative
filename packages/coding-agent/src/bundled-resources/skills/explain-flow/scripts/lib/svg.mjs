/** The few SVG elements a flow film is drawn with, as text. Coordinates are rounded to a tenth of a pixel. */

import { px } from "./geometry.mjs";

export function esc(text) {
	return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** An opacity as a two-decimal attribute value. */
export function alphaOf(value) {
	return (Math.round(Math.min(Math.max(value, 0), 1) * 100) / 100).toString();
}

export function rectEl(shape, radius, attrs) {
	return `<rect x="${px(shape.x)}" y="${px(shape.y)}" width="${px(shape.w)}" height="${px(shape.h)}" rx="${px(radius)}" ${attrs}/>`;
}

export function lineEl(x1, y1, x2, y2, attrs) {
	return `<line x1="${px(x1)}" y1="${px(y1)}" x2="${px(x2)}" y2="${px(y2)}" ${attrs}/>`;
}

export function circleEl(x, y, r, attrs) {
	return `<circle cx="${px(x)}" cy="${px(y)}" r="${px(r)}" ${attrs}/>`;
}

/** One line of text from parts, each with its own colour and weight. */
export function words(scene, x, y, size, parts, anchor = "start", alpha = 1) {
	const spans = parts
		.filter((part) => part.text !== undefined && part.text !== "")
		.map((part) => `<tspan fill="${part.fill}"${part.bold ? ' font-weight="700"' : ""}>${esc(part.text)}</tspan>`)
		.join("");
	if (spans === "") return "";
	return `<text x="${px(x)}" y="${px(y)}" font-family="${esc(scene.theme.font.replace(/"/g, "'"))}" font-size="${px(size)}" text-anchor="${anchor}" xml:space="preserve"${alpha < 1 ? ` opacity="${alphaOf(alpha)}"` : ""}>${spans}</text>`;
}

export function pathEl(d, attrs) {
	return `<path d="${d}" ${attrs}/>`;
}

/** A plain stroke of `colour`, `width` pixels wide. */
export function strokeOf(colour, width, more = "") {
	return `fill="none" stroke="${colour}" stroke-width="${px(width)}"${more ? ` ${more}` : ""}`;
}
