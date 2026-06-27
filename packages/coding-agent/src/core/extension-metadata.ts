/**
 * Human-friendly name + description for an extension, derived from its path/files.
 *
 * Extensions are commonly laid out as `<extension-name>/index.ts` (or `.js`/`.mjs`), so the basename
 * is the useless `index.ts` for every one of them. Consumers (the profile editor, resource listings,
 * the "loaded capabilities" surface) should show the *extension name* and a description instead — the
 * same affordance skills get from their frontmatter. These helpers centralize that derivation.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const ENTRY_FILE_RE = /\.(ts|tsx|js|mjs|cjs)$/i;

/**
 * Display name for an extension at `extensionPath`. For the `<name>/index.<ext>` layout the folder
 * name is the extension name; otherwise the file stem is used. Never returns the bare `index.<ext>`.
 */
export function getExtensionDisplayName(extensionPath: string): string {
	const baseName = basename(extensionPath);
	const stem = baseName.replace(ENTRY_FILE_RE, "");
	if (stem.toLowerCase() === "index") {
		const parent = basename(dirname(extensionPath));
		if (parent) return parent;
	}
	return stem || baseName;
}

/**
 * Best-effort one-line description for an extension. Tries, in order: `package.json` `description`,
 * the first heading/line of a sibling `README.md`, then the first line of a leading block/JSDoc
 * comment in the entry file. Returns `undefined` when nothing usable is found.
 */
export function getExtensionDescription(extensionPath: string): string | undefined {
	let dir = extensionPath;
	let entryFile: string | undefined;
	try {
		if (existsSync(extensionPath) && statSync(extensionPath).isDirectory()) {
			dir = extensionPath;
		} else {
			dir = dirname(extensionPath);
			entryFile = extensionPath;
		}
	} catch {
		return undefined;
	}

	// 1) package.json description
	const pkgDesc = readPackageDescription(join(dir, "package.json"));
	if (pkgDesc) return pkgDesc;

	// 2) README.md first heading / first non-empty line
	const readmeDesc = readReadmeSummary(join(dir, "README.md"));
	if (readmeDesc) return readmeDesc;

	// 3) leading comment of the entry file
	if (entryFile) {
		const commentDesc = readLeadingCommentSummary(entryFile);
		if (commentDesc) return commentDesc;
	}
	return undefined;
}

function readPackageDescription(pkgPath: string): string | undefined {
	try {
		if (!existsSync(pkgPath)) return undefined;
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { description?: unknown };
		if (typeof pkg.description === "string" && pkg.description.trim()) {
			return pkg.description.trim();
		}
	} catch {}
	return undefined;
}

function readReadmeSummary(readmePath: string): string | undefined {
	try {
		if (!existsSync(readmePath)) return undefined;
		for (const raw of readFileSync(readmePath, "utf-8").split("\n")) {
			const line = raw.replace(/^#+\s*/, "").trim();
			if (line) return line;
		}
	} catch {}
	return undefined;
}

function readLeadingCommentSummary(entryPath: string): string | undefined {
	try {
		if (!existsSync(entryPath)) return undefined;
		// Read a bounded prefix; the description, if any, is at the very top.
		const head = readFileSync(entryPath, "utf-8").slice(0, 2048);
		for (const raw of head.split("\n")) {
			const line = raw.trim();
			if (!line) continue;
			// Strip comment markers; stop at the first real line of content.
			const stripped = line
				.replace(/^\/\*\*?|^\*\/?|^\/\/+/g, "")
				.replace(/\*\/$/, "")
				.trim();
			if (!stripped || stripped === "*") continue;
			if (line.startsWith("/*") || line.startsWith("*") || line.startsWith("//")) {
				if (stripped) return stripped;
			}
			// First non-comment line → no leading description.
			return undefined;
		}
	} catch {}
	return undefined;
}
