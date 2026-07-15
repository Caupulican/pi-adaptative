import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("cross-platform package dependencies", () => {
	it("keeps the platform-limited FFF native binding optional", async () => {
		const packageJson = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
		};

		expect(packageJson.dependencies).not.toHaveProperty("@ff-labs/fff-node");
		expect(packageJson.optionalDependencies).toMatchObject({ "@ff-labs/fff-node": "0.9.6" });
	});
});
