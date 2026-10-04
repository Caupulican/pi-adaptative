import type { EditorTheme, MarkdownTheme, SelectListTheme, SettingsListTheme } from "@caupulican/pi-tui";
import chalk from "chalk";
import type { SourceInfo } from "../core/source-info.ts";

export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "bashMode";

export type ThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg"
	| "workbenchSurface"
	| "toolDiffAddedBg"
	| "toolDiffRemovedBg"
	| "codeBlockBg"
	| "codeBlockActiveBg"
	| "selectionBg";

// ============================================================================
// Theme Class
// ============================================================================

export class Theme {
	readonly name?: string;
	readonly sourcePath?: string;
	sourceInfo?: SourceInfo;
	private fgColors: Map<ThemeColor, string>;
	private bgColors: Map<ThemeBg, string>;
	private mode: ColorMode;

	constructor(
		fgColors: Record<ThemeColor, string | number>,
		bgColors: Record<ThemeBg, string | number>,
		mode: ColorMode,
		options: { name?: string; sourcePath?: string; sourceInfo?: SourceInfo } = {},
	) {
		this.name = options.name;
		this.sourcePath = options.sourcePath;
		this.sourceInfo = options.sourceInfo;
		this.mode = mode;
		this.fgColors = new Map();
		for (const [key, value] of Object.entries(fgColors) as [ThemeColor, string | number][]) {
			this.fgColors.set(key, fgAnsi(value, mode));
		}
		this.bgColors = new Map();
		for (const [key, value] of Object.entries(bgColors) as [ThemeBg, string | number][]) {
			this.bgColors.set(key, bgAnsi(value, mode));
		}
	}

	fg(color: ThemeColor, text: string): string {
		const ansi = this.fgColors.get(color);
		if (ansi === undefined) throw new Error(`Unknown theme color: ${color}`);
		if (this.mode === "none") return text;
		return `${ansi}${text}\x1b[39m`; // Reset only foreground color
	}

	bg(color: ThemeBg, text: string): string {
		const ansi = this.bgColors.get(color);
		if (ansi === undefined) throw new Error(`Unknown theme background color: ${color}`);
		if (this.mode === "none") return text;
		return `${ansi}${text}\x1b[49m`; // Reset only background color
	}

	/** Optional surfaces (diff rows) exist only when the theme defines them. */
	hasBg(color: ThemeBg): boolean {
		return this.bgColors.has(color);
	}

	bold(text: string): string {
		return chalk.bold(text);
	}

	italic(text: string): string {
		return chalk.italic(text);
	}

	underline(text: string): string {
		return chalk.underline(text);
	}

	inverse(text: string): string {
		return chalk.inverse(text);
	}

	strikethrough(text: string): string {
		return chalk.strikethrough(text);
	}

	getFgAnsi(color: ThemeColor): string {
		const ansi = this.fgColors.get(color);
		if (ansi === undefined) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	getBgAnsi(color: ThemeBg): string {
		const ansi = this.bgColors.get(color);
		if (ansi === undefined) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	getColorMode(): ColorMode {
		return this.mode;
	}

	getThinkingBorderColor(
		level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra",
	): (str: string) => string {
		// Map thinking levels to dedicated theme colors
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
			case "max":
			case "ultra":
				return (str: string) => this.fg("thinkingXhigh", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}
}

// ============================================================================
// Global Theme Instance
// ============================================================================

// Use globalThis to share theme across module loaders (tsx + jiti in dev mode)
export const THEME_KEY = Symbol.for("@caupulican/pi-adaptative:theme");

export const THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme");

// Export theme as a getter that reads from globalThis
// This ensures all module instances (tsx, jiti) see the same theme
export const theme: Theme = new Proxy({} as Theme, {
	get(_target, prop) {
		const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
		if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
		return (t as unknown as Record<string | symbol, unknown>)[prop];
	},
});

export function setGlobalTheme(t: Theme): void {
	(globalThis as Record<symbol, Theme>)[THEME_KEY] = t;
	(globalThis as Record<symbol, Theme>)[THEME_KEY_OLD] = t;
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string, options: { plainColor?: ThemeColor } = {}): string[] {
	return highlightCodeLines(code, lang, "plain", options.plainColor);
}

/**
 * Get language identifier from file path extension.
 */
export function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;

	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		fish: "fish",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		sass: "sass",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
		markdown: "markdown",
		dockerfile: "dockerfile",
		makefile: "makefile",
		cmake: "cmake",
		lua: "lua",
		perl: "perl",
		r: "r",
		scala: "scala",
		clj: "clojure",
		ex: "elixir",
		exs: "elixir",
		erl: "erlang",
		hs: "haskell",
		ml: "ocaml",
		vim: "vim",
		graphql: "graphql",
		proto: "protobuf",
		tf: "hcl",
		hcl: "hcl",
	};

	return extToLang[ext];
}

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
		highlightCode: (code: string, lang?: string): string[] => highlightCodeLines(code, lang, "themed"),
		codeBlockSurface: codeSurface,
		codeBlockLabel: (text: string) => theme.fg("muted", text),
	};
}

/**
 * SGR sequence the conversation window asserts over mouse-selected cells. A background wash keeps every
 * foreground token color readable; without a `selectionBg` tone, or on 16-color and NO_COLOR terminals where
 * a tone cannot be shown faithfully, reverse video marks the cells and still keeps each cell's own colors.
 */
export function getSelectionStyle(): string {
	const mode = theme.getColorMode();
	if ((mode === "truecolor" || mode === "256color") && theme.hasBg("selectionBg")) {
		return theme.getBgAnsi("selectionBg");
	}
	return "\x1b[7m";
}

export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
		// The same highlighter, tokens and surface the transcript's code blocks use.
		code: {
			highlight: (code: string, lang?: string) => highlightCodeLines(code, lang, "themed"),
			plain: (text: string) => theme.fg("mdCodeBlock", text),
			fence: (text: string) => theme.fg("mdCodeBlockBorder", text),
			label: (text: string) => theme.fg("muted", text),
			surface: codeSurface,
			activeSurface: activeCodeSurface,
		},
	};
}

export function getSettingsListTheme(): SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text: string) => theme.fg("dim", text),
	};
}

import type { ColorDepth } from "@caupulican/pi-tui";
import {
	ansi256ToHex,
	ANSI_256_CUBE_LEVELS as CUBE_VALUES,
	ANSI_256_GRAY_LEVELS as GRAY_VALUES,
} from "../utils/ansi-colors.ts";
import { detectCodeLanguage, highlight, supportsLanguage } from "../utils/syntax-highlight.ts";

export type ColorMode = ColorDepth;

// ============================================================================
// Color Utilities
// ============================================================================

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace("#", "");
	if (cleaned.length !== 6) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	const r = parseInt(cleaned.substring(0, 2), 16);
	const g = parseInt(cleaned.substring(2, 4), 16);
	const b = parseInt(cleaned.substring(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	return { r, g, b };
}

export function findClosestCubeIndex(value: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < CUBE_VALUES.length; i++) {
		const dist = Math.abs(value - CUBE_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

export function findClosestGrayIndex(gray: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < GRAY_VALUES.length; i++) {
		const dist = Math.abs(gray - GRAY_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

export function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
	// Weighted Euclidean distance (human eye is more sensitive to green)
	const dr = r1 - r2;
	const dg = g1 - g2;
	const db = b1 - b2;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

export function rgbTo256(r: number, g: number, b: number): number {
	// Find closest color in the 6x6x6 cube
	const rIdx = findClosestCubeIndex(r);
	const gIdx = findClosestCubeIndex(g);
	const bIdx = findClosestCubeIndex(b);
	const cubeR = CUBE_VALUES[rIdx];
	const cubeG = CUBE_VALUES[gIdx];
	const cubeB = CUBE_VALUES[bIdx];
	const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
	const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);

	// Find closest grayscale
	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	const grayIdx = findClosestGrayIndex(gray);
	const grayValue = GRAY_VALUES[grayIdx];
	const grayIndex = 232 + grayIdx;
	const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);

	// Check if color has noticeable saturation (hue matters)
	// If max-min spread is significant, prefer cube to preserve tint
	const maxC = Math.max(r, g, b);
	const minC = Math.min(r, g, b);
	const spread = maxC - minC;

	// Only consider grayscale if color is nearly neutral (spread < 10)
	// AND grayscale is actually closer
	if (spread < 10 && grayDist < cubeDist) {
		return grayIndex;
	}

	return cubeIndex;
}

export function hexTo256(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return rgbTo256(r, g, b);
}

/** The 16 ANSI colors as most terminals ship them: indexes 0-7 normal, 8-15 bright. */
export const ANSI_16_RGB: ReadonlyArray<readonly [number, number, number]> = [
	[0, 0, 0],
	[205, 0, 0],
	[0, 205, 0],
	[205, 205, 0],
	[0, 0, 238],
	[205, 0, 205],
	[0, 205, 205],
	[229, 229, 229],
	[127, 127, 127],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[92, 92, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
];

/** Nearest of the first `count` ANSI colors; backgrounds use only the 8 normal colors. */
export function rgbTo16(r: number, g: number, b: number, count: 8 | 16): number {
	let best = 0;
	let bestDistance = Infinity;
	for (let i = 0; i < count; i++) {
		const [cr, cg, cb] = ANSI_16_RGB[i]!;
		const distance = colorDistance(r, g, b, cr, cg, cb);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = i;
		}
	}
	return best;
}

export function colorToRgb(color: string | number): { r: number; g: number; b: number } {
	return hexToRgb(typeof color === "number" ? ansi256ToHex(color) : color);
}

/** SGR sequence selecting `color` at the given depth. "none" selects nothing: the user opted out of color. */
export function colorAnsi(color: string | number, mode: ColorMode, layer: "fg" | "bg"): string {
	if (mode === "none") return "";
	if (color === "") return layer === "fg" ? "\x1b[39m" : "\x1b[49m";
	if (typeof color !== "number" && !color.startsWith("#")) throw new Error(`Invalid color value: ${color}`);
	const base = layer === "fg" ? 38 : 48;
	switch (mode) {
		case "truecolor": {
			if (typeof color === "number") return `\x1b[${base};5;${color}m`;
			const { r, g, b } = hexToRgb(color);
			return `\x1b[${base};2;${r};${g};${b}m`;
		}
		case "256color":
			return `\x1b[${base};5;${typeof color === "number" ? color : hexTo256(color)}m`;
		case "16color": {
			const { r, g, b } = colorToRgb(color);
			const index = rgbTo16(r, g, b, layer === "fg" ? 16 : 8);
			const code = index < 8 ? (layer === "fg" ? 30 : 40) + index : 90 + (index - 8);
			return `\x1b[${code}m`;
		}
	}
}

export function fgAnsi(color: string | number, mode: ColorMode): string {
	return colorAnsi(color, mode, "fg");
}

export function bgAnsi(color: string | number, mode: ColorMode): string {
	return colorAnsi(color, mode, "bg");
}

// ============================================================================
// TUI Helpers
// ============================================================================

export type CliHighlightTheme = Record<string, (s: string) => string>;

export function buildCliHighlightTheme(t: Theme): CliHighlightTheme {
	return {
		keyword: (s: string) => t.fg("syntaxKeyword", s),
		built_in: (s: string) => t.fg("syntaxType", s),
		literal: (s: string) => t.fg("syntaxNumber", s),
		number: (s: string) => t.fg("syntaxNumber", s),
		regexp: (s: string) => t.fg("syntaxString", s),
		string: (s: string) => t.fg("syntaxString", s),
		comment: (s: string) => t.fg("syntaxComment", s),
		doctag: (s: string) => t.fg("syntaxComment", s),
		meta: (s: string) => t.fg("muted", s),
		function: (s: string) => t.fg("syntaxFunction", s),
		title: (s: string) => t.fg("syntaxFunction", s),
		class: (s: string) => t.fg("syntaxType", s),
		type: (s: string) => t.fg("syntaxType", s),
		tag: (s: string) => t.fg("syntaxPunctuation", s),
		name: (s: string) => t.fg("syntaxKeyword", s),
		attr: (s: string) => t.fg("syntaxVariable", s),
		variable: (s: string) => t.fg("syntaxVariable", s),
		params: (s: string) => t.fg("syntaxVariable", s),
		operator: (s: string) => t.fg("syntaxOperator", s),
		punctuation: (s: string) => t.fg("syntaxPunctuation", s),
		emphasis: (s: string) => t.italic(s),
		strong: (s: string) => t.bold(s),
		link: (s: string) => t.underline(s),
		addition: (s: string) => t.fg("toolDiffAdded", s),
		deletion: (s: string) => t.fg("toolDiffRemoved", s),
	};
}

let cachedHighlightThemeFor: Theme | undefined;
let cachedCliHighlightTheme: CliHighlightTheme | undefined;

export function getCliHighlightTheme(t: Theme): CliHighlightTheme {
	if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
		cachedHighlightThemeFor = t;
		cachedCliHighlightTheme = buildCliHighlightTheme(t);
	}
	return cachedCliHighlightTheme;
}

export type HighlightFailureFallback = "plain" | "themed";

export function highlightCodeLines(
	code: string,
	lang: string | undefined,
	failureFallback: HighlightFailureFallback,
	plainColor?: ThemeColor,
): string[] {
	const plainLines = () => code.split("\n").map((line) => theme.fg(plainColor ?? "mdCodeBlock", line));
	// Validate language before highlighting to avoid stderr spam from cli-highlight
	const language = lang || detectCodeLanguage(code);
	const validLang = language && supportsLanguage(language) ? language : undefined;
	// Skip highlighting when no valid language is specified or provable from the text (shebang, JSON
	// shape). cli-highlight's free-form auto-detection is unreliable and can misidentify prose as
	// AppleScript, LiveCodeServer, etc., coloring random English words as keywords.
	if (!validLang) {
		return plainLines();
	}
	const opts = {
		language: validLang,
		ignoreIllegals: true,
		theme: plainColor
			? { ...getCliHighlightTheme(theme), default: (s: string) => theme.fg(plainColor, s) }
			: getCliHighlightTheme(theme),
	};
	try {
		return highlight(code, opts).split("\n");
	} catch {
		return plainColor || failureFallback === "themed" ? plainLines() : code.split("\n");
	}
}

/** Surface tone behind code; themes without `codeBlockBg` leave rows untinted. */
export function codeSurface(text: string): string {
	return theme.hasBg("codeBlockBg") ? theme.bg("codeBlockBg", text) : text;
}

export function activeCodeSurface(text: string): string {
	if (theme.hasBg("codeBlockActiveBg")) return theme.bg("codeBlockActiveBg", text);
	return codeSurface(text);
}
