import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ignore from "ignore";

const RESOURCE_IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export type ResourceIgnoreMatcher = ReturnType<typeof ignore>;

export function createResourceIgnoreMatcher(): ResourceIgnoreMatcher {
	return ignore();
}

export function toPosixResourcePath(path: string): string {
	return path.split(sep).join("/");
}

function prefixResourceIgnorePattern(line: string, prefix: string): string | undefined {
	const trimmed = line.trim();
	if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return undefined;

	let pattern = line;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	}
	if (pattern.startsWith("/")) pattern = pattern.slice(1);

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

export function addResourceIgnoreRules(matcher: ResourceIgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixResourcePath(relativeDir)}/` : "";

	for (const filename of RESOURCE_IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const patterns = readFileSync(ignorePath, "utf8")
				.split(/\r?\n/)
				.map((line) => prefixResourceIgnorePattern(line, prefix))
				.filter((line): line is string => line !== undefined);
			if (patterns.length > 0) matcher.add(patterns);
		} catch {}
	}
}
