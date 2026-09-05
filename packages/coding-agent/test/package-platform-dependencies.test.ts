import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FFF_NODE_VERSION } from "../src/utils/tools-manager.ts";

describe("cross-platform package dependencies", () => {
	it("keeps the platform-limited FFF native binding optional", async () => {
		const packageJson = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
		};

		expect(packageJson.dependencies).not.toHaveProperty("@ff-labs/fff-node");
		const pinnedVersion = packageJson.optionalDependencies?.["@ff-labs/fff-node"];
		expect(pinnedVersion).toMatch(/^\d+\.\d+\.\d+$/);
		expect(FFF_NODE_VERSION).toBe(pinnedVersion);
	});
});
