import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const IGNORED_BASENAME = /(?:^|\/)(?:models\.generated\.ts|package-lock\.json)$/;
const INCLUDED_RE = /^packages\/[^/]+\/(?:src|test)\//;

export function isBiomeIncludedRelativePath(relativePath: string): boolean {
	const relative = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
	if (relative.includes("node_modules/") || IGNORED_BASENAME.test(relative)) return false;
	if (relative.startsWith("scripts/") && relative.endsWith(".mjs")) return false;
	return (
		INCLUDED_RE.test(relative) &&
		(/\.(?:ts|tsx|js|jsx|cjs|mts|cts|json)$/.test(relative) || relative.endsWith(".css"))
	);
}

function resolveBiomeBin(cwd: string): string | undefined {
	const local = join(cwd, "node_modules", "@biomejs", "biome", "bin", "biome");
	return existsSync(local) ? local : undefined;
}

export function toFormattingRelativePath(filePath: string, cwd: string): string | undefined {
	const resolved = resolve(cwd, filePath);
	const relativePath = relative(cwd, resolved).split(sep).join("/");
	if (!relativePath || relativePath.startsWith("../") || isAbsolute(relativePath)) return undefined;
	return isBiomeIncludedRelativePath(relativePath) ? relativePath : undefined;
}

/** Format mutated source before it is written. Ignored paths and missing biome are no-ops. */
export function formatMutatedSourceText(content: string, filePath: string, cwd: string): string {
	const relativePath = toFormattingRelativePath(filePath, cwd);
	if (!relativePath) return content;
	const biome = resolveBiomeBin(cwd);
	if (!biome) return content;
	try {
		return execFileSync(biome, ["format", "--stdin-file-path", relativePath], {
			cwd,
			input: content,
			encoding: "utf8",
			timeout: 15_000,
			maxBuffer: 4 * 1024 * 1024,
			stdio: ["pipe", "pipe", "ignore"],
		});
	} catch {
		return content;
	}
}
