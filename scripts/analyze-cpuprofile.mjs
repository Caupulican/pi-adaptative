#!/usr/bin/env node
/**
 * Rank a V8 .cpuprofile by SELF time -- the function actually burning CPU, not the one that
 * happens to be on the stack -- by function and by file, as Markdown. Pairs with
 * scripts/profile-coding-agent-turn.mjs, scripts/profile-coding-agent-node.mjs and the
 * coding-agent long-session profile (packages/coding-agent/test/profiling/), all of which write
 * the format Node's own --cpu-prof writes.
 *
 * Usage: node scripts/analyze-cpuprofile.mjs <file.cpuprofile> [--top <n>] [--title <text>] [--callers <functionName>]
 */
import { readFileSync } from "node:fs";

function parseArgs(argv) {
	const args = { top: 30, title: undefined, file: undefined, callers: undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--top") args.top = Number(argv[++i]);
		else if (arg === "--title") args.title = argv[++i];
		else if (arg === "--callers") args.callers = argv[++i];
		else if (arg === "--help" || arg === "-h") {
			console.log("Usage: node scripts/analyze-cpuprofile.mjs <file.cpuprofile> [--top <n>] [--title <text>]");
			process.exit(0);
		} else args.file = arg;
	}
	if (!args.file) {
		console.error("analyze-cpuprofile: a .cpuprofile path is required");
		process.exit(2);
	}
	return args;
}

function shortUrl(url) {
	if (!url) return "(native)";
	const repo = url.indexOf("/pi-adaptative/");
	if (repo >= 0) return url.slice(repo + "/pi-adaptative/".length);
	const modules = url.indexOf("node_modules/");
	if (modules >= 0) return `node_modules/${url.slice(modules + "node_modules/".length).split("/")[0]}`;
	return url.startsWith("node:") ? url : url.split("/").pop() ?? url;
}

const { file, top, title, callers } = parseArgs(process.argv.slice(2));
const profile = JSON.parse(readFileSync(file, "utf-8"));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const selfMicros = new Map();
for (let i = 0; i < profile.samples.length; i++) {
	const id = profile.samples[i];
	selfMicros.set(id, (selfMicros.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
}
const total = [...selfMicros.values()].reduce((sum, value) => sum + value, 0) || 1;
const byFunction = new Map();
const byFile = new Map();
for (const [id, micros] of selfMicros) {
	const node = nodes.get(id);
	if (!node) continue;
	const frame = node.callFrame;
	const location = shortUrl(frame.url);
	const fnKey = `${frame.functionName || "(anonymous)"} — ${location}:${(frame.lineNumber ?? -1) + 1}`;
	byFunction.set(fnKey, (byFunction.get(fnKey) ?? 0) + micros);
	byFile.set(location, (byFile.get(location) ?? 0) + micros);
}
if (callers) {
	// Attribute a function's self time to the frames that called it: which caller is paying.
	const parentOf = new Map();
	for (const node of profile.nodes) for (const child of node.children ?? []) parentOf.set(child, node.id);
	const byCaller = new Map();
	let matched = 0;
	for (const [id, micros] of selfMicros) {
		const node = nodes.get(id);
		if (!node || (node.callFrame.functionName || "(anonymous)") !== callers) continue;
		matched += micros;
		let parentId = parentOf.get(id);
		let label = "(root)";
		while (parentId !== undefined) {
			const parent = nodes.get(parentId);
			const name = parent?.callFrame.functionName || "(anonymous)";
			if (parent && name !== callers) {
				label = `${name} — ${shortUrl(parent.callFrame.url)}:${(parent.callFrame.lineNumber ?? -1) + 1}`;
				break;
			}
			parentId = parentOf.get(parentId);
		}
		byCaller.set(label, (byCaller.get(label) ?? 0) + micros);
	}
	console.log(`### Callers of ${callers} (${(matched / 1000).toFixed(1)} ms self time)\n\n| ms | share | caller |\n|---:|---:|---|`);
	for (const [label, micros] of [...byCaller.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)) {
		console.log(`| ${(micros / 1000).toFixed(1)} | ${((100 * micros) / Math.max(matched, 1)).toFixed(1)}% | ${label.replace(/\|/g, "\\|")} |`);
	}
	process.exit(0);
}

const rows = (map, limit) =>
	[...map.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([key, micros]) => `| ${(micros / 1000).toFixed(1)} | ${((100 * micros) / total).toFixed(1)}% | ${key.replace(/\|/g, "\\|")} |`)
		.join("\n");

console.log(`### ${title ?? file}\n`);
console.log(`Sampled: ${(total / 1000).toFixed(0)} ms of self time.\n`);
console.log("#### By function (self time)\n\n| ms | share | function — file:line |\n|---:|---:|---|");
console.log(rows(byFunction, top));
console.log("\n#### By file (self time)\n\n| ms | share | file |\n|---:|---:|---|");
console.log(rows(byFile, Math.min(top, 25)));
console.log("");
