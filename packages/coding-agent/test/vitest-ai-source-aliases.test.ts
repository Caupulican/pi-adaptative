import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { piAiSourceAliases } from "../../agent/vitest-ai-source-aliases.ts";

/**
 * The alias list must stay complete with respect to `pi-ai`'s export map.
 *
 * A missing entry does not fail loudly: the specifier falls through to the package's `import`
 * condition (`./dist/...`), which resolves on any machine that has built the package and fails
 * with `Cannot find package` on a clean checkout. That is exactly how nine provider entry points
 * went missing unnoticed — the suite was green wherever a stale `dist` happened to exist.
 */
const aiPackageRoot = new URL("../../ai/", import.meta.url);
const aiExports = (
	JSON.parse(readFileSync(new URL("package.json", aiPackageRoot), "utf-8")) as {
		exports: Record<string, { "pi-source"?: string }>;
	}
).exports;

describe("pi-ai source aliases", () => {
	it("covers every export the package publishes", () => {
		const uncovered = Object.keys(aiExports).filter((subpath) => {
			const specifier = subpath === "." ? "@caupulican/pi-ai" : `@caupulican/pi-ai/${subpath.slice(2)}`;
			return !piAiSourceAliases.some((alias) => (alias.find as RegExp).test(specifier));
		});
		expect(uncovered).toEqual([]);
	});

	it("resolves every alias to a source file that exists", () => {
		const missing = piAiSourceAliases
			.map((alias) => alias.replacement)
			.filter((replacement) => !existsSync(replacement));
		expect(missing).toEqual([]);
	});

	it("never points an alias at a build output", () => {
		// `dist` is absent on a clean checkout; an alias resolving there is the defect this guards.
		const built = piAiSourceAliases
			.map((alias) => alias.replacement)
			.filter((replacement) => replacement.includes(`${"/"}dist${"/"}`) || replacement.includes("\\dist\\"));
		expect(built).toEqual([]);
	});

	it("matches a subpath without the bare-package pattern shadowing it", () => {
		const bedrock = piAiSourceAliases.filter((alias) =>
			(alias.find as RegExp).test("@caupulican/pi-ai/bedrock-provider"),
		);
		expect(bedrock).toHaveLength(1);
		// Read the target from the manifest rather than restating it — restating is the drift.
		const declared = aiExports["./bedrock-provider"]?.["pi-source"];
		expect(declared).toBeDefined();
		expect(bedrock[0]?.replacement).toBe(fileURLToPath(new URL(declared as string, aiPackageRoot)));
	});
});
