import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const NODE_RUNTIME_BASELINE = readFileSync(join(REPOSITORY_ROOT, ".nvmrc"), "utf-8").trim();

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("Node runtime baseline", () => {
	it("pins development, CI, and every standalone workspace package to the same LTS patch", () => {
		expect(NODE_RUNTIME_BASELINE).toMatch(/^24\.\d+\.\d+$/u);

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

		const workflowsDirectory = join(REPOSITORY_ROOT, ".github/workflows");
		for (const filename of readdirSync(workflowsDirectory).filter((name) => /\.ya?ml$/u.test(name))) {
			const workflow = readFileSync(join(workflowsDirectory, filename), "utf-8");
			const nodeSetupCount = [...workflow.matchAll(/uses: actions\/setup-node@/gu)].length;
			expect([...workflow.matchAll(/node-version-file: ['"]?\.nvmrc['"]?/gu)], filename).toHaveLength(
				nodeSetupCount,
			);
			expect(workflow, filename).not.toMatch(/node-version:/u);
		}
	});

	it("pins the compiled release runtime through its development version file and runs its transport contract", () => {
		const bunVersion = readFileSync(join(REPOSITORY_ROOT, ".bun-version"), "utf-8").trim();
		expect(bunVersion).toMatch(/^\d+\.\d+\.\d+$/u);
		const workflow = readFileSync(join(REPOSITORY_ROOT, ".github/workflows/build-binaries.yml"), "utf-8");
		expect(workflow).toContain("bun-version-file: '.bun-version'");
		expect(workflow).not.toMatch(/bun-version:/u);
		const step = workflow
			.split("      - name: Verify compiled Bun WebFetch transport\n")[1]
			?.split("      - name:")[0];
		expect(step).toBeDefined();
		expect(step).not.toMatch(/\bif:|continue-on-error:/u);
		expect(step).toContain("bun build --compile packages/coding-agent/test/fixtures/webfetch-native-contract.ts");
		expect(step).toMatch(/^\s*"\$\{RUNNER_TEMP\}\/pi-webfetch-native-contract"$/mu);
	});
});
