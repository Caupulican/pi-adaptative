import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
const STATIC_NODE_SQLITE = /(?:from|import)\s*\(?\s*["']node:sqlite["']/;

function listTypeScriptFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listTypeScriptFiles(path));
		else if (entry.name.endsWith(".ts")) files.push(path);
	}
	return files;
}

describe("sqlite compile graph", () => {
	it("does not statically import node:sqlite from compiled source", () => {
		const hits = listTypeScriptFiles(srcRoot).filter((file) => STATIC_NODE_SQLITE.test(readFileSync(file, "utf8")));
		expect(hits).toEqual([]);
	});

	it("opens sqlite through bun:sqlite under Bun without a static node:sqlite import", () => {
		const adapter = readFileSync(new URL("../src/core/context/sqlite-database.ts", import.meta.url), "utf8");
		expect(adapter).toMatch(/bun:sqlite/);
		expect(adapter).not.toMatch(STATIC_NODE_SQLITE);
	});
});
