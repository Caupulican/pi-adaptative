import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parse } from "@babel/parser";
import { repoRelative } from "./lib/ratchet-files.mjs";

const root = resolve(import.meta.dirname, "..");
const baseline = JSON.parse(readFileSync(join(root, "scripts/source-comment-ratchet.json"), "utf8"));
const [mode = "--check", ...requested] = process.argv.slice(2);
if (!["--inventory", "--list", "--check"].includes(mode) || (mode === "--check" && requested.length)) {
	throw new Error("Usage: node scripts/check-source-comments.mjs [--check | --inventory [path ...] | --list [path ...]]");
}

function ownedSources() {
	const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	}).split("\0");
	return paths.filter((file) => {
		if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)) return false;
		if (/(?:^|\/)(?:vendor|dist|node_modules)\/|\.(?:generated|min)\./.test(file)) return false;
		const path = join(root, file);
		return existsSync(path) && lstatSync(path).isFile();
	}).sort();
}

function selectedFiles(paths, scopes) {
	if (!scopes.length) throw new Error("The comment scan needs at least one file or directory.");
	const selected = new Set();
	for (const scope of scopes) {
		const relative = repoRelative(root, resolve(root, scope));
		const matches = paths.filter((file) => !relative || file === relative || file.startsWith(relative + "/"));
		if (!matches.length) throw new Error(`No owned JS/TS sources in ${scope}`);
		for (const file of matches) selected.add(file);
	}
	return [...selected].sort();
}

function parseComments(file, source) {
	const extension = extname(file);
	const plugins = [];
	if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) plugins.push(["typescript", { dts: /\.d\.[cm]?ts$/.test(file) }]);
	if (/\.[jt]sx$/.test(extension)) plugins.push("jsx");
	return parse(source, {
		sourceFilename: file,
		sourceType: "unambiguous",
		attachComment: false,
		plugins,
	}).comments;
}

function countLines(source, comments) {
	const lines = source.split(/\r\n|[\r\n\u2028\u2029]/);
	const touched = new Map();
	for (const { loc } of comments) {
		for (let line = loc.start.line; line <= loc.end.line; line++) {
			const previous = touched.get(line) ?? { end: 0, hasCode: false };
			const start = line === loc.start.line ? loc.start.column : 0;
			const end = line === loc.end.line ? loc.end.column : lines[line - 1].length;
			const hasCode = previous.hasCode || /\S/.test(lines[line - 1].slice(previous.end, start));
			touched.set(line, { end, hasCode });
		}
	}
	let mixed = 0;
	for (const [line, { end, hasCode }] of touched) {
		if (hasCode || /\S/.test(lines[line - 1].slice(end))) mixed++;
	}
	return { mixed, standalone: touched.size - mixed };
}

const scopes = mode === "--check" ? baseline.scopes : requested.length ? requested : ["."];
const files = selectedFiles(ownedSources(), scopes);
const failures = [];
const totals = { files: 0, comments: 0, standalone: 0, mixed: 0 };
if (mode === "--check") {
	for (const file of Object.keys(baseline.retained)) {
		if (!files.includes(file)) failures.push(`Retained comment entry is outside the enrolled files: ${file}`);
	}
}
for (const file of files) {
	try {
		const source = readFileSync(join(root, file), "utf8");
		const comments = parseComments(file, source);
		const retained = [...(baseline.retained[file] ?? [])];
		for (const comment of comments) {
			const raw = source.slice(comment.start, comment.end).replace(/\r\n?/g, "\n");
			if (mode === "--list") console.log(JSON.stringify({ file, line: comment.loc.start.line, text: raw }));
			if (mode !== "--check") continue;
			const index = retained.indexOf(raw);
			if (index === -1) failures.push(`${file}:${comment.loc.start.line} unreviewed comment: ${raw.split("\n")[0]}`);
			else retained.splice(index, 1);
		}
		if (mode === "--check" && retained.length) failures.push(`${file}: remove ${retained.length} retired baseline entries`);
		const lines = countLines(source, comments);
		totals.files++;
		totals.comments += comments.length;
		totals.standalone += lines.standalone;
		totals.mixed += lines.mixed;
	} catch (error) {
		failures.push(`${file}: ${error.message}`);
	}
}
if (failures.length) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else if (mode !== "--list") {
	console.log(`${totals.files} files, ${totals.comments} comments, ${totals.standalone} comment-only lines, ${totals.mixed} lines shared with code`);
}
