import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PI_AGENT_CORE_EXTENSION_SUBPATHS } from "../src/core/extensions/virtual-modules.ts";

const extensionIndex = readFileSync(new URL("../src/core/extensions/index.ts", import.meta.url), "utf8");
const extensionLoader = readFileSync(new URL("../src/core/extensions/loader.ts", import.meta.url), "utf8");
const runtimeBuilder = readFileSync(new URL("../src/core/runtime-builder.ts", import.meta.url), "utf8");
const extensionifyRuntime = readFileSync(new URL("../src/core/tools/extensionify-runtime.ts", import.meta.url), "utf8");
const publicIndex = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const bunEntrypoint = readFileSync(new URL("../src/bun/cli.ts", import.meta.url), "utf8");
const bundledVirtualModules = readFileSync(
	new URL("../src/core/extensions/bundled-virtual-modules.ts", import.meta.url),
	"utf8",
);
const agentPackage = JSON.parse(readFileSync(new URL("../../agent/package.json", import.meta.url), "utf8")) as {
	exports: Record<string, unknown>;
};
const memoryProviders = [
	"../src/core/context/file-store-memory-provider.ts",
	"../src/core/memory/providers/file-store.ts",
	"../src/core/memory/providers/user-memory-archive.ts",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

describe("extension loader dependency boundary", () => {
	it("keeps ordinary session construction off the heavyweight extension-loader graph", () => {
		expect(extensionIndex).not.toMatch(/from "\.\/loader\.ts"/);
		expect(runtimeBuilder).not.toMatch(/from "\.\/extensions\/loader\.ts"/);
		expect(runtimeBuilder).not.toMatch(/from "\.\/tools\/index\.ts"/);
		expect(extensionifyRuntime).not.toMatch(/extensions\/loader\.ts|jiti/);
		for (const provider of memoryProviders) expect(provider).not.toMatch(/resource-loader\.ts/);
	});

	it("keeps extension-loading entry points available from the public package", () => {
		expect(publicIndex).toMatch(/from "\.\/core\/extensions\/loader\.ts"/);
	});

	it("loads the bundled SDK catalog only from the Bun binary entrypoint", () => {
		expect(extensionLoader).not.toMatch(/_bundledPi|_bundledTypebox|\.\.\/\.\.\/index\.ts/);
		expect(bunEntrypoint).toMatch(/bundled-virtual-modules\.ts/);
	});

	it("covers every supported agent-core subpath in both Node and Bun extension adapters", () => {
		const exportedSubpaths = Object.keys(agentPackage.exports)
			.filter((subpath) => subpath !== "." && subpath !== "./package.json")
			.map((subpath) => subpath.slice(2))
			.sort();
		expect(Object.keys(PI_AGENT_CORE_EXTENSION_SUBPATHS).sort()).toEqual(exportedSubpaths);
		expect(extensionLoader).toMatch(/PI_AGENT_CORE_EXTENSION_SUBPATHS/);
		expect(bundledVirtualModules).toMatch(/piAgentCoreVirtualModules/);
	});
});
