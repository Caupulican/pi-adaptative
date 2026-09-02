#!/usr/bin/env node
/**
 * Rank a V8 .heapsnapshot by what the heap holds: self size by node type and constructor name, and
 * strings by shape (whitespace collapsed, digits replaced) so many instances of one kind of text
 * show up as one row. Self size, not retained size: it answers "what is the memory made of", which
 * is the question a growing heap raises first; a retained-size walk needs dominators and is not
 * needed to find a memo or a duplicated text.
 *
 * Usage: node scripts/analyze-heapsnapshot.mjs <file.heapsnapshot> [--top <n>]
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const topIndex = args.indexOf("--top");
const top = topIndex >= 0 ? Number(args[topIndex + 1]) : 25;
if (!file) {
	console.error("analyze-heapsnapshot: a .heapsnapshot path is required");
	process.exit(2);
}
const snapshot = JSON.parse(readFileSync(file, "utf-8"));
const meta = snapshot.snapshot.meta;
const nodeFields = meta.node_fields;
const nodeTypes = meta.node_types[0];
const fieldCount = nodeFields.length;
const typeOffset = nodeFields.indexOf("type");
const nameOffset = nodeFields.indexOf("name");
const sizeOffset = nodeFields.indexOf("self_size");
const nodes = snapshot.nodes;
const strings = snapshot.strings;

const byKind = new Map();
const byStringShape = new Map();
let total = 0;
for (let index = 0; index < nodes.length; index += fieldCount) {
	const type = nodeTypes[nodes[index + typeOffset]];
	const name = strings[nodes[index + nameOffset]] ?? "";
	const size = nodes[index + sizeOffset];
	total += size;
	const isString = type === "string" || type === "concatenated string" || type === "sliced string";
	const kindKey = isString ? `${type}` : `${type}:${name.slice(0, 60)}`;
	const kind = byKind.get(kindKey) ?? { size: 0, count: 0 };
	kind.size += size;
	kind.count += 1;
	byKind.set(kindKey, kind);
	if (type === "string" && size >= 256) {
		const shape = name.replace(/\s+/g, " ").replace(/\d+/g, "#").slice(0, 72);
		const entry = byStringShape.get(shape) ?? { size: 0, count: 0 };
		entry.size += size;
		entry.count += 1;
		byStringShape.set(shape, entry);
	}
}
const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
const rows = (map) =>
	[...map.entries()]
		.sort((a, b) => b[1].size - a[1].size)
		.slice(0, top)
		.map(([key, entry]) => `| ${mb(entry.size)} | ${((100 * entry.size) / total).toFixed(1)}% | ${entry.count} | ${key.replace(/\|/g, "\\|")} |`)
		.join("\n");
console.log(`### ${file}\n\nHeap self size: ${mb(total)} MB across ${nodes.length / fieldCount} nodes.\n`);
console.log("#### By node type and constructor (self size)\n\n| MB | share | count | kind |\n|---:|---:|---:|---|");
console.log(rows(byKind));
console.log("\n#### Strings of 256 bytes or more, by shape (self size)\n\n| MB | share | count | shape |\n|---:|---:|---:|---|");
console.log(rows(byStringShape));
