/** An indexed terminal layout can frame rows lazily while its wrapping remains authoritative. */
import type { Component } from "./tui.ts";

export interface TerminalRows {
	readonly length: number;
	at(index: number): string | undefined;
}

export function collectTerminalRows(rows: TerminalRows): string[] {
	return Array.from({ length: rows.length }, (_, index) => rows.at(index) ?? "");
}

/** Preserve render overrides on extension components that inherit a built-in row view. */
export function componentTerminalRows(component: Component, width: number): TerminalRows {
	return borrowComponentRows(component, width) ?? component.render(width);
}

export function borrowComponentRows(component: Component, width: number): TerminalRows | undefined {
	if (!component.renderRows) return undefined;
	for (let layer: object | null = component; layer; layer = Object.getPrototypeOf(layer)) {
		if (Object.hasOwn(layer, "renderRows")) return component.renderRows(width);
		if (Object.hasOwn(layer, "render")) break;
	}
	return undefined;
}

export function joinTerminalRows(segments: readonly TerminalRows[]): TerminalRows {
	if (segments.length === 1) return segments[0]!;
	const ends: number[] = [];
	let length = 0;
	for (const segment of segments) {
		length += segment.length;
		ends.push(length);
	}
	return {
		length,
		at(index) {
			if (index < 0 || index >= length) return undefined;
			let first = 0;
			let end = ends.length;
			while (first < end) {
				const middle = (first + end) >>> 1;
				if (index < ends[middle]!) end = middle;
				else first = middle + 1;
			}
			return segments[first]?.at(index - (ends[first - 1] ?? 0));
		},
	};
}
