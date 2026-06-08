import * as os from "node:os";
import { relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@caupulican/pi-ai";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@caupulican/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { resolvePath } from "../../utils/paths.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

function toDisplaySeparators(path: string): string {
	return path.split(sep).join("/");
}

function looksLikeWindowsAbsolutePath(path: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(path);
}

function addCandidate(candidates: string[], value: string | undefined): void {
	if (!value || candidates.includes(value)) return;
	candidates.push(value);
}

export function shortenPath(path: unknown, cwd?: string): string {
	if (typeof path !== "string") return "";
	const candidates: string[] = [];
	addCandidate(candidates, toDisplaySeparators(path));

	const home = os.homedir();
	if (path.startsWith(home)) {
		addCandidate(candidates, `~${toDisplaySeparators(path.slice(home.length))}`);
	}

	if (cwd && !looksLikeWindowsAbsolutePath(path)) {
		try {
			const absolutePath = resolvePath(path, cwd);
			const resolvedCwd = resolvePath(cwd);
			const relativePath = relative(resolvedCwd, absolutePath) || ".";
			addCandidate(candidates, toDisplaySeparators(relativePath));
		} catch {
			// Keep the raw/home-shortened candidates when a path cannot be resolved for display.
		}
	}

	return candidates.reduce((shortest, candidate) => (candidate.length < shortest.length ? candidate : shortest));
}

export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	const absolutePath = resolvePath(rawPath, cwd);
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	const caps = getCapabilities();
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims =
					img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

export function renderToolPath(
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { emptyFallback?: string },
): string {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(value, cwd)), value, cwd);
}
