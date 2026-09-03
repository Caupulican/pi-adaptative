/**
 * Search-output reducer for `rg`/`grep` run through the bash tool. Measured on live sessions rg was
 * 37-59 % of all bash output bytes and a third of those bytes were the file path repeated on every
 * hit line. The reducer regroups `path:line:text` (and `path-line-text` context lines) into the
 * layout our own grep tool already uses: the path once, then `  line: text` and `  line- context`.
 * Nothing is dropped below the per-file cap; above it the remainder is counted, and the raw output
 * stays one read away (the caller persists it).
 *
 * The reducer only rewrites output it fully understands: any line that is not a hit, a context
 * line, a group separator or blank makes the whole output pass through unchanged, and output modes
 * that do not carry `path:line` (`-l`, `-c`, `--json`, `--files`, no filename, no line number) are
 * never touched.
 */
import type { CommandFamilyClassification } from "./command-family.ts";
import type { OutputReducer, OutputReductionRequest } from "./output-reduction.ts";

const PATH_ONLY_MODE_FLAGS = new Set([
	"-l",
	"--files-with-matches",
	"-L",
	"--files-without-match",
	"-c",
	"--count",
	"--count-matches",
	"--json",
	"--files",
	"-N",
	"--no-line-number",
	"-h",
	"--no-filename",
	"--heading",
	"--vimgrep",
	"-r",
	"--replace",
	"--pretty",
	"-p",
	"--stats",
	"-q",
	"--quiet",
]);

/** `--` separates non-contiguous context groups in rg and grep output. */
const GROUP_SEPARATOR = "--";
const MAX_LINE_CHARS = 2_000;

const HITS_PER_FILE: Record<"standard" | "compact", number> = { standard: 60, compact: 30 };
const MAX_FILES: Record<"standard" | "compact", number> = { standard: 200, compact: 80 };

interface SearchLine {
	path: string;
	line: number;
	separator: ":" | "-";
	text: string;
}

/** `path:12:text`; the path may carry a drive letter and otherwise holds no colon. */
const HIT_LINE_RE = /^((?:[A-Za-z]:)?[^:\n]*?):(\d+):(.*)$/u;

function clip(text: string): string {
	if (text.length <= MAX_LINE_CHARS) return text;
	const side = Math.floor((MAX_LINE_CHARS - 20) / 2);
	return `${text.slice(0, side)} … [clipped] … ${text.slice(-side)}`;
}

/** Short flags that change the output shape; `r`/`p` only mean replace/pretty for rg (grep: recursive/perl). */
const CLUSTER_MODE_FLAGS: Record<string, RegExp> = { rg: /[lLcNhqpr]/u, other: /[lLchq]/u };

function outputModeUnsuitable(tool: string, argv: string[]): boolean {
	const clusterFlags = tool === "rg" ? CLUSTER_MODE_FLAGS.rg : CLUSTER_MODE_FLAGS.other;
	for (const arg of argv.slice(1)) {
		if (arg === "--") break;
		const flag = arg.startsWith("--") ? arg.split("=", 1)[0] : arg;
		if (PATH_ONLY_MODE_FLAGS.has(flag) && (tool === "rg" || (flag !== "-r" && flag !== "-p"))) return true;
		// Clustered short flags: `-lc`, `-nl`.
		if (/^-[a-zA-Z]{2,}$/u.test(arg) && clusterFlags.test(arg.slice(1))) return true;
	}
	return false;
}

/**
 * Parse every line. Hit lines are recognized directly; context lines (`path-line-text`) are
 * recognized by the paths hits established, so a path containing `-digits-` cannot mislead the
 * parser. Undefined when any non-blank line is something else: the output is not plain search output.
 */
function parseSearchOutput(text: string): SearchLine[] | undefined {
	const rawLines = text.split("\n");
	if (rawLines.at(-1) === "") rawLines.pop();
	const hits = new Map<number, SearchLine>();
	const paths = new Set<string>();
	rawLines.forEach((line, index) => {
		const match = HIT_LINE_RE.exec(line);
		if (!match || match[1].length === 0) return;
		hits.set(index, { path: match[1], line: Number.parseInt(match[2], 10), separator: ":", text: match[3] });
		paths.add(match[1]);
	});
	if (hits.size === 0) return undefined;
	// Longest path first so `src/a` never claims a context line of `src/a/b.ts`.
	const knownPaths = [...paths].sort((a, b) => b.length - a.length);
	const parsed: SearchLine[] = [];
	for (let index = 0; index < rawLines.length; index++) {
		const line = rawLines[index];
		const hit = hits.get(index);
		if (hit) {
			parsed.push(hit);
			continue;
		}
		if (line === GROUP_SEPARATOR) {
			parsed.push({ path: GROUP_SEPARATOR, line: 0, separator: "-", text: "" });
			continue;
		}
		if (line.trim().length === 0) continue;
		const owner = knownPaths.find((path) => line.startsWith(`${path}-`));
		const contextMatch = owner ? /^(\d+)-(.*)$/u.exec(line.slice(owner.length + 1)) : null;
		if (!owner || !contextMatch) return undefined;
		parsed.push({ path: owner, line: Number.parseInt(contextMatch[1], 10), separator: "-", text: contextMatch[2] });
	}
	return parsed;
}

export interface SearchReduction {
	text: string;
	omittedLines: number;
}

/** Group parsed search output by file in the grep tool's layout with per-file and file-count caps. */
export function reduceSearchOutput(
	text: string,
	level: "standard" | "compact" = "standard",
): SearchReduction | undefined {
	const parsed = parseSearchOutput(text);
	if (!parsed) return undefined;
	const perFileCap = HITS_PER_FILE[level];
	const fileCap = MAX_FILES[level];
	const files = new Map<string, SearchLine[]>();
	let lastPath: string | undefined;
	for (const entry of parsed) {
		if (entry.path === GROUP_SEPARATOR) {
			// A separator belongs to the file whose group just ended; dropped at file boundaries.
			if (lastPath !== undefined) files.get(lastPath)?.push(entry);
			continue;
		}
		const list = files.get(entry.path);
		if (list) list.push(entry);
		else files.set(entry.path, [entry]);
		lastPath = entry.path;
	}
	const out: string[] = [];
	let omitted = 0;
	let fileIndex = 0;
	for (const [path, entries] of files) {
		if (fileIndex >= fileCap) {
			omitted += entries.filter((entry) => entry.path !== GROUP_SEPARATOR).length;
			continue;
		}
		fileIndex++;
		out.push(path);
		let hitsShown = 0;
		let hitsHidden = 0;
		let pendingSeparator = false;
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			if (entry.path === GROUP_SEPARATOR) {
				// Keep a separator only between two shown groups.
				pendingSeparator = index > 0 && index < entries.length - 1;
				continue;
			}
			if (entry.separator === ":") {
				if (hitsShown >= perFileCap) {
					hitsHidden++;
					continue;
				}
				hitsShown++;
			} else if (hitsShown >= perFileCap) {
				// Context of hidden hits is hidden with them.
				omitted++;
				continue;
			}
			if (pendingSeparator) {
				out.push("  --");
				pendingSeparator = false;
			}
			out.push(`  ${entry.line}${entry.separator} ${clip(entry.text)}`);
		}
		if (hitsHidden > 0) {
			out.push(`  [+${hitsHidden} more hits in this file]`);
			omitted += hitsHidden;
		}
	}
	if (fileIndex < files.size) out.push(`[+${files.size - fileIndex} more files]`);
	return { text: `${out.join("\n")}\n`, omittedLines: omitted };
}

export const searchOutputReducer: OutputReducer = {
	name: "search",
	applies(classification: CommandFamilyClassification): boolean {
		return classification.family === "search" && !outputModeUnsuitable(classification.tool, classification.argv);
	},
	reduce(_classification: CommandFamilyClassification, request: OutputReductionRequest) {
		return reduceSearchOutput(request.text, request.level);
	},
};
