import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("packaged Python runtime provisioning", () => {
	it("ships a bounded best-effort postinstall that reuses the native runtime manager", async () => {
		const packageRoot = join(import.meta.dirname, "..");
		const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
			files?: string[];
			scripts?: Record<string, string>;
		};
		expect(packageJson.files).toContain("scripts/postinstall-python-runtime.mjs");
		expect(packageJson.scripts?.postinstall).toBe("node scripts/postinstall-python-runtime.mjs");

		const script = await readFile(join(packageRoot, "scripts", "postinstall-python-runtime.mjs"), "utf8");
		expect(script).toContain('import("../dist/core/python-runtime.js")');
		expect(script).toContain("ensurePythonRuntime({ force: true, silent: false })");
		expect(script).toContain("PI_OFFLINE");
		expect(script).not.toMatch(/curl[^|]*\|\s*(?:sh|bash)|\bsudo\b/u);
	});
});
