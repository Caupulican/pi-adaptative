import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const NODE_RUNTIME_BASELINE = "24.18.0";

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("Node runtime baseline", () => {
	it("pins development, CI, and every standalone workspace package to the same LTS patch", () => {
		expect(readFileSync(join(REPOSITORY_ROOT, ".nvmrc"), "utf-8").trim()).toBe(NODE_RUNTIME_BASELINE);

		for (const relativePath of [
			"package.json",
			"packages/agent/package.json",
			"packages/ai/package.json",
			"packages/coding-agent/package.json",
			"packages/tui/package.json",
		]) {
			const packageJson = readJson(join(REPOSITORY_ROOT, relativePath));
			const engines = packageJson.engines as Record<string, unknown> | undefined;
			expect(engines?.node, relativePath).toBe(`>=${NODE_RUNTIME_BASELINE}`);
		}

		for (const relativePath of [
			".github/workflows/ci.yml",
			".github/workflows/npm-audit.yml",
			".github/workflows/build-binaries.yml",
		]) {
			const workflow = readFileSync(join(REPOSITORY_ROOT, relativePath), "utf-8");
			expect(workflow, relativePath).toContain(`node-version: '${NODE_RUNTIME_BASELINE}'`);
			expect(workflow, relativePath).not.toMatch(/node-version:\s*['"]?24['"]?\s*$/mu);
		}
	});
});
