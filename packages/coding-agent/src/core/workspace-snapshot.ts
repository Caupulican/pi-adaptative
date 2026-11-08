/**
 * What the model would otherwise spend its first calls finding out: the names at the top of the working directory. Read
 * once per directory for the life of the process, so the system prompt stays byte-stable within a session.
 */

import { readdirSync } from "node:fs";

const MAX_LISTED = 40;
const MAX_ENTRIES_READ = 400;
// Hidden entries stay listed (the agent reads and writes dotfiles; secrets are redacted, not hidden), except version-control metadata and OS noise.
const SKIPPED = new Set([
	"node_modules",
	"dist",
	"build",
	"target",
	"coverage",
	"__pycache__",
	"vendor",
	".git",
	".hg",
	".svn",
	".DS_Store",
]);

const snapshots = new Map<string, string>();

/** One line naming the top-level files and folders of `cwd` (folders end in `/`), or "" when there is nothing useful to say. */
export function workspaceSnapshotLine(cwd: string): string {
	const cached = snapshots.get(cwd);
	if (cached !== undefined) return cached;
	let line = "";
	try {
		const entries = readdirSync(cwd, { withFileTypes: true })
			.filter((entry) => !SKIPPED.has(entry.name))
			.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
			.sort((a, b) => a.localeCompare(b));
		if (entries.length > 0 && entries.length <= MAX_ENTRIES_READ) {
			const shown = entries.slice(0, MAX_LISTED);
			const more = entries.length - shown.length;
			line = `\nTop-level entries of the working directory: ${shown.join(", ")}${more > 0 ? ` (and ${more} more)` : ""}`;
		}
	} catch {
		line = "";
	}
	snapshots.set(cwd, line);
	return line;
}
