/**
 * Shared file reading for the ratchet checks: header comments, file size, legacy markers and
 * doctrine enforcement all walk TypeScript source the same way and count lines the same way.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Every `.ts` file under `directory` (recursive), excluding declaration files. Sorted, repo-absolute. */
export function walkTypeScriptFiles(directory) {
	const found = [];
	const visit = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(path);
		}
	};
	visit(directory);
	return found.sort();
}

/** Lines as an editor shows them: a trailing newline does not start a new line. */
export function countLines(text) {
	const parts = text.split(/\r?\n/);
	return text.endsWith("\n") ? parts.length - 1 : parts.length;
}

/** True when the file opens with a `/** ... *\/` block, before any import or code. */
export function hasLeadingDocHeader(text) {
	return /^﻿?\s*\/\*\*[\s\S]*?\*\//.test(text);
}

/** Repo-relative path with forward slashes, the form every ratchet file uses as its key. */
export function repoRelative(root, path) {
	return relative(root, path).split(sep).join("/");
}

export function readText(path) {
	return readFileSync(path, "utf8");
}
