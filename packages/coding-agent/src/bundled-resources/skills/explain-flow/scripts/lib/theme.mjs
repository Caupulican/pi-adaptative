/**
 * Themes of a flow film: a small set of colour roles and one type family. A product passes its own roles, so a film
 * carries that product's identity; the built-in themes are the harness's own. Nothing here names a look to copy.
 *
 * Roles: `bg` the canvas, `line` the quiet structure (station outlines, wires), `text` the names, `dim` the notes,
 * `work` an item being worked on, `ok` and `fail` the two outcomes, `info` a schedule or a clock. At rest only `line`,
 * `text` and `dim` are on screen: a state colour appears only where something differs from rest.
 */

export const MONO_STACK =
	'"JetBrains Mono", "Fira Code", "IBM Plex Mono", "DejaVu Sans Mono", "Noto Sans Mono", Menlo, Consolas, monospace';

export const THEME_ROLES = ["bg", "line", "text", "dim", "work", "ok", "fail", "info"];
const HEX = /^#[0-9a-fA-F]{6}$/;

export const THEMES = {
	/** The harness's terminal theme: phosphor on a dark field. */
	matrix: {
		bg: "#010806",
		line: "#2f7a4c",
		text: "#d9f7e3",
		dim: "#5fb37f",
		work: "#ffd84d",
		ok: "#3dff91",
		fail: "#ff6b85",
		info: "#5ee6d3",
	},
	/** Ink on warm paper, for a page with a light background. */
	paper: {
		bg: "#f4f1e8",
		line: "#a9a391",
		text: "#1f1d19",
		dim: "#6d685b",
		work: "#a85b00",
		ok: "#1f7a3d",
		fail: "#b3261e",
		info: "#0b6e8a",
	},
};

/** The channels of a `#rrggbb` colour. */
export function hexChannels(hex) {
	return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
}

/** `from` moved `amount` (0..1) of the way to `to`, as `#rrggbb`. */
export function mixHex(from, to, amount) {
	const a = hexChannels(from);
	const b = hexChannels(to);
	return `#${a
		.map((channel, index) =>
			Math.round(channel + (b[index] - channel) * amount)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

/** Where each role comes from in a harness theme file: the first key that resolves to a colour is taken. */
const HARNESS_ROLE_KEYS = {
	bg: ["export.pageBg"],
	line: ["colors.borderMuted", "colors.border"],
	text: ["colors.text"],
	dim: ["colors.dim", "colors.muted"],
	work: ["colors.warning"],
	ok: ["colors.success", "colors.accent"],
	fail: ["colors.error"],
	info: ["colors.mdLink", "colors.customMessageLabel", "colors.accent"],
};

/**
 * The roles of a harness theme file (its `vars`, `colors` and `export` sections), so a film follows the theme the
 * owner runs. A value names a variable or is a colour itself; a role the file cannot give keeps the harness default
 * and is named in `problems`.
 */
export function themeFromHarness(file, problems) {
	const vars = file?.vars ?? {};
	const read = (path) => {
		const [section, key] = path.split(".");
		const value = file?.[section]?.[key];
		const colour = typeof value === "string" && HEX.test(value) ? value : vars[value];
		return typeof colour === "string" && HEX.test(colour) ? colour : undefined;
	};
	const theme = { font: MONO_STACK };
	for (const role of THEME_ROLES) {
		const colour = HARNESS_ROLE_KEYS[role].map(read).find(Boolean);
		if (!colour) problems.push(`theme file: no colour for "${role}" (looked at ${HARNESS_ROLE_KEYS[role].join(", ")})`);
		theme[role] = colour ?? THEMES.matrix[role];
	}
	return theme;
}

/**
 * The theme a spec names: a built-in name, or an object with every role as `#rrggbb` and an optional `font` (a CSS
 * font-family list). Problems are pushed to `problems`; the harness theme is returned in their place.
 */
export function resolveTheme(input, problems) {
	const fallback = { ...THEMES.matrix, font: MONO_STACK };
	if (input === undefined) return fallback;
	if (typeof input === "string") {
		const named = THEMES[input];
		if (named) return { ...named, font: MONO_STACK };
		problems.push(`theme: no built-in theme "${input}" (built in: ${Object.keys(THEMES).join(", ")})`);
		return fallback;
	}
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		problems.push("theme: must be a built-in name or an object of colour roles");
		return fallback;
	}
	const theme = { font: typeof input.font === "string" && input.font.trim() ? input.font : MONO_STACK };
	for (const role of THEME_ROLES) {
		const value = input[role];
		if (typeof value !== "string" || !HEX.test(value)) {
			problems.push(`theme.${role}: must be a colour written as #rrggbb`);
			theme[role] = fallback[role];
		} else theme[role] = value;
	}
	return theme;
}
