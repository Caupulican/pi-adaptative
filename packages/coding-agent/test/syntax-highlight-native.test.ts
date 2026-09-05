import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("native syntax highlight package contract", () => {
	it("keeps the generated grammar and alias catalog aligned with the installed dependency", () => {
		const generator = fileURLToPath(new URL("../../../scripts/generate-highlight-languages.mjs", import.meta.url));
		const result = spawnSync(process.execPath, [generator, "--check"], { encoding: "utf8", timeout: 10_000 });
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
	});

	it("loads exported grammar modules and preserves lazy registration without a bundler", () => {
		const fixture = fileURLToPath(new URL("./fixtures/syntax-highlight-native-contract.ts", import.meta.url));
		const result = spawnSync(process.execPath, [fixture], { encoding: "utf8", timeout: 10_000 });
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("syntax highlighting native contract passed");
	});
});
