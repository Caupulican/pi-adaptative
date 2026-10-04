/** How many colors the terminal can show, after the user's own color opt-out. */
export type ColorDepth = "truecolor" | "256color" | "16color" | "none";

/**
 * TERM families that cannot show the 256-color cube. Plain `xterm`, `screen` and `tmux` are deliberately
 * absent: terminals and multiplexers report those names while showing 256 colors, so unknown and ambiguous
 * TERM values keep the 256-color default.
 */
const SIXTEEN_COLOR_TERMS = /^(linux|vt\d+|ansi|cygwin|xterm-color|rxvt|rxvt-unicode)$/;

/**
 * Resolve the color depth for one environment. `NO_COLOR` (set and non-empty, https://no-color.org)
 * always wins; otherwise a true-color terminal reports 24-bit, a TERM that names no 256-color
 * support reports 16 colors, and anything else keeps the 256-color default.
 */
export function detectColorDepth(trueColor: boolean, env: NodeJS.ProcessEnv = process.env): ColorDepth {
	if (env.NO_COLOR) return "none";
	if (trueColor) return "truecolor";
	const term = env.TERM?.toLowerCase() ?? "";
	if (SIXTEEN_COLOR_TERMS.test(term) && !env.COLORTERM) return "16color";
	return "256color";
}
