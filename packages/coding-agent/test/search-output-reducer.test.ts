/**
 * Search reducer contract: every hit the raw output carried is present in the reduced text or
 * counted in a cap notice, context lines follow their hits, group separators survive inside a
 * file, and output shapes without `path:line` pass through untouched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyCommandFamily } from "../src/core/tools/command-family.ts";
import { reduceSearchOutput, searchOutputReducer } from "../src/core/tools/search-output-reducer.ts";

const fixtures = join(import.meta.dirname, "fixtures", "tool-output");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf-8");

/** Every `path:line` pair of the raw hits, for the round-trip contract. */
function rawHits(raw: string): Set<string> {
	const hits = new Set<string>();
	for (const line of raw.split("\n")) {
		const match = /^((?:[A-Za-z]:)?[^:\n]*?):(\d+):/u.exec(line);
		if (match) hits.add(`${match[1]}\0${match[2]}`);
	}
	return hits;
}

function reducedHits(reduced: string): Set<string> {
	const hits = new Set<string>();
	let path = "";
	for (const line of reduced.split("\n")) {
		if (line.length === 0) continue;
		if (!line.startsWith("  ")) {
			path = line;
			continue;
		}
		const match = /^ {2}(\d+): /u.exec(line);
		if (match) hits.add(`${path}\0${match[1]}`);
	}
	return hits;
}

describe("reduceSearchOutput", () => {
	it("groups multi-file hits under one path line each and keeps every hit", () => {
		const raw = fixture("rg-multi-file.txt");
		const reduced = reduceSearchOutput(raw);
		expect(reduced).toBeDefined();
		expect(reduced!.omittedLines).toBe(0);
		expect(reducedHits(reduced!.text)).toEqual(rawHits(raw));
		expect(reduced!.text.length).toBeLessThan(raw.length * 0.75);
		expect(reduced!.text.startsWith("src/module_0/component.ts\n  10: ")).toBe(true);
	});

	it("saves most on a single file with many hits and caps the file at the standard bound", () => {
		const raw = fixture("rg-single-file.txt");
		const reduced = reduceSearchOutput(raw);
		expect(reduced).toBeDefined();
		expect(reduced!.text.length).toBeLessThan(raw.length * 0.4);
		// 80 hits in one file: the first 60 are shown, the rest counted, nothing silently lost.
		expect(reducedHits(reduced!.text).size).toBe(60);
		expect(reduced!.omittedLines).toBe(20);
		expect(reduced!.text).toContain("  [+20 more hits in this file]");
		for (const hit of reducedHits(reduced!.text)) expect(rawHits(raw).has(hit)).toBe(true);
	});

	it("keeps context lines with their hits and group separators inside a file", () => {
		const raw = fixture("rg-context.txt");
		const reduced = reduceSearchOutput(raw);
		expect(reduced).toBeDefined();
		const lines = reduced!.text.split("\n");
		expect(lines[0]).toBe("src/lib/parser.ts");
		// Leading whitespace of the raw lines is kept verbatim.
		expect(lines[1]).toBe("  99-   // before");
		expect(lines[2]).toBe("  100:   needle(token);");
		expect(lines[3]).toBe("  101-   // after");
		expect(lines[4]).toBe("  --");
		expect(reducedHits(reduced!.text)).toEqual(rawHits(raw));
	});

	it("recognizes context lines by the hit paths even when a path contains -digits-", () => {
		const raw = ["src/v2-3-final.ts-9-before", "src/v2-3-final.ts:10:needle", "src/v2-3-final.ts-11-after", ""].join(
			"\n",
		);
		const reduced = reduceSearchOutput(raw);
		expect(reduced?.text).toBe("src/v2-3-final.ts\n  9- before\n  10: needle\n  11- after\n");
	});

	it("caps hits per file and counts the remainder", () => {
		const raw = Array.from({ length: 100 }, (_, index) => `deep/path/to/file.ts:${index + 1}:hit ${index}`).join(
			"\n",
		);
		const reduced = reduceSearchOutput(`${raw}\n`, "compact");
		expect(reduced).toBeDefined();
		expect(reduced!.text).toContain("  [+70 more hits in this file]");
		expect(reduced!.omittedLines).toBe(70);
		expect(reducedHits(reduced!.text).size).toBe(30);
	});

	it("passes through output it does not fully understand", () => {
		expect(reduceSearchOutput("src/a.ts:1:hit\nsome unrelated line\n")).toBeUndefined();
		expect(reduceSearchOutput("12:no path here\n13:single file mode\n")).toBeUndefined();
		expect(reduceSearchOutput("src/a.ts\nsrc/b.ts\n")).toBeUndefined();
		expect(reduceSearchOutput("")).toBeUndefined();
	});

	it("handles Windows drive paths", () => {
		const raw = "C:/work/proj/src/a.ts:3:hit\nC:/work/proj/src/a.ts:9:hit\n";
		expect(reduceSearchOutput(raw)?.text).toBe("C:/work/proj/src/a.ts\n  3: hit\n  9: hit\n");
	});

	it("is deterministic", () => {
		const raw = fixture("rg-multi-file.txt");
		expect(reduceSearchOutput(raw)).toEqual(reduceSearchOutput(raw));
	});
});

describe("searchOutputReducer.applies", () => {
	const request = { tool: "bash", command: "", text: "", exitCode: 0, level: "standard" as const };
	it("applies to plain rg and grep searches, through cd prefixes and trailing bounds", () => {
		for (const command of [
			"rg -n needle src",
			"grep -rn needle .",
			"cd /repo && rg -n -g '*.ts' needle",
			"rg -n needle | head -50",
		]) {
			expect(searchOutputReducer.applies(classifyCommandFamily(command), request), command).toBe(true);
		}
	});
	it("leaves alone output modes without path:line and non-search commands", () => {
		for (const command of [
			"rg -l needle src",
			"rg -c needle src",
			"rg --json needle src",
			"rg --files src",
			"rg -nh needle src",
			"rg -N needle src",
			"grep -rln needle .",
			"ls -la",
			"rg --heading -n needle src",
		]) {
			expect(searchOutputReducer.applies(classifyCommandFamily(command), request), command).toBe(false);
		}
	});
});
