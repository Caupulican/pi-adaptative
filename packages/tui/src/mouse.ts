/**
 * Mouse sequence decoding for ANSI / xterm SGR 1006 mode.
 */

export type MouseButton = "left" | "middle" | "right" | "wheelUp" | "wheelDown" | "none";
export type MouseAction = "down" | "up" | "drag" | "scroll";

export interface TerminalMouseEvent {
	readonly action: MouseAction;
	readonly button: MouseButton;
	readonly column: number; // 0-based
	readonly row: number; // 0-based
	readonly rawButton: number;
}

const SGR_MOUSE_REGEX = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * Check if the given input string begins with or is an xterm SGR mouse sequence.
 */
export function isMouseSequence(data: string): boolean {
	return data.startsWith("\x1b[<");
}

/**
 * Parse an xterm SGR mouse sequence (`\x1b[<button;col;row;[Mm]`).
 * Returns 0-based coordinates and normalized action/button types.
 */
export function parseMouseSequence(data: string): TerminalMouseEvent | undefined {
	const match = SGR_MOUSE_REGEX.exec(data);
	if (!match) return undefined;

	const rawButton = Number(match[1]);
	const column = Number(match[2]) - 1;
	const row = Number(match[3]) - 1;
	const isRelease = match[4] === "m";

	if (rawButton === 64) {
		return { action: "scroll", button: "wheelUp", column, row, rawButton };
	}
	if (rawButton === 65) {
		return { action: "scroll", button: "wheelDown", column, row, rawButton };
	}
	if (isRelease) {
		return {
			action: "up",
			button: rawButton === 0 ? "left" : rawButton === 1 ? "middle" : rawButton === 2 ? "right" : "none",
			column,
			row,
			rawButton,
		};
	}
	if (rawButton === 32) {
		return { action: "drag", button: "left", column, row, rawButton };
	}
	if (rawButton === 0) {
		return { action: "down", button: "left", column, row, rawButton };
	}
	if (rawButton === 1) {
		return { action: "down", button: "middle", column, row, rawButton };
	}
	if (rawButton === 2) {
		return { action: "down", button: "right", column, row, rawButton };
	}

	return { action: "down", button: "none", column, row, rawButton };
}
