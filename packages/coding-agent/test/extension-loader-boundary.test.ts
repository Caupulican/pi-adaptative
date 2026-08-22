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
const bundledTmuxRuntimeSources = [
	"../src/bundled-resources/extensions/tmux-agent-manager/index.ts",
	"../src/bundled-resources/extensions/tmux-agent-manager/launch-profile.ts",
].map((path) => ({ path, source: readFileSync(new URL(path, import.meta.url), "utf8") }));
const agentPackage = JSON.parse(readFileSync(new URL("../../agent/package.json", import.meta.url), "utf8")) as {
	exports: Record<string, unknown>;
};
const memoryProviders = [
	"../src/core/context/file-store-memory-provider.ts",
	"../src/core/memory/providers/file-store.ts",
	"../src/core/memory/providers/user-memory-archive.ts",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
const eagerAgentCoreRuntimeOwners = [
	"../src/core/agent-session.ts",
	"../src/core/compaction-controller.ts",
	"../src/core/context/context-composition.ts",
	"../src/core/extensions/runner.ts",
	"../src/core/models/perf-profile.ts",
	"../src/core/provider-request-runtime-controller.ts",
	"../src/core/session-analytics.ts",
	"../src/core/skill-vault.ts",
	"../src/core/tools/edit.ts",
	"../src/core/tools/file-failure-recovery.ts",
	"../src/core/tools/write.ts",
].map((path) => ({ path, source: readFileSync(new URL(path, import.meta.url), "utf8") }));
const eagerAgentCoreNodeRuntimeOwners = [
	"../src/core/session-analytics.ts",
	"../src/core/session-manager-factory.ts",
	"../src/core/session-tree-navigator.ts",
	"../src/core/tools/grep.ts",
	"../src/core/tools/read.ts",
].map((path) => ({ path, source: readFileSync(new URL(path, import.meta.url), "utf8") }));
const focusedGoalIntegrationTests = [
	"./agent-session-goal-autosteer.test.ts",
	"./goal-task-compaction-survival.test.ts",
].map((path) => ({ path, source: readFileSync(new URL(path, import.meta.url), "utf8") }));

function agentCoreRuntimeImports(source: string, subpath = ""): string[] {
	const escapedSpecifier = `@caupulican/pi-agent-core${subpath}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return source.match(new RegExp(`import[ \\t]+(?!type\\b)[^;]+[ \\t]+from[ \\t]+"${escapedSpecifier}";`, "g")) ?? [];
}

function focusedTestHeavyRuntimeImports(source: string): string[] {
	return (
		source.match(
			/import[ \t]+(?!type\b)[^;]+[ \t]+from[ \t]+"(?:\.\.\/src\/core\/agent-session\.ts|\.\/suite\/harness\.ts)";/g,
		) ?? []
	);
}

describe("extension loader dependency boundary", () => {
	it("keeps ordinary session construction off the heavyweight extension-loader graph", () => {
		expect(extensionIndex).not.toMatch(/from "\.\/loader\.ts"/);
		expect(runtimeBuilder).not.toMatch(/from "\.\/extensions\/loader\.ts"/);
		expect(runtimeBuilder).not.toMatch(/from "\.\/tools\/index\.ts"/);
		expect(extensionifyRuntime).not.toMatch(/extensions\/loader\.ts|jiti/);
		for (const provider of memoryProviders) expect(provider).not.toMatch(/resource-loader\.ts/);
	});

	it("keeps ordinary session construction off the agent-core root runtime barrel", () => {
		const mixedImport = 'import { type AgentMessage, measureJsonLength } from "@caupulican/pi-agent-core";';
		const typeOnlyImport = 'import type { AgentMessage } from "@caupulican/pi-agent-core";';
		expect(agentCoreRuntimeImports(mixedImport)).toEqual([mixedImport]);
		expect(agentCoreRuntimeImports(typeOnlyImport)).toEqual([]);

		const violations = eagerAgentCoreRuntimeOwners.flatMap(({ path, source }) =>
			agentCoreRuntimeImports(source).map((statement) => ({ path, statement })),
		);
		expect(violations).toEqual([]);
	});

	it("keeps ordinary session construction off the batteries-included agent-core node entry", () => {
		const violations = eagerAgentCoreNodeRuntimeOwners.flatMap(({ path, source }) =>
			agentCoreRuntimeImports(source, "/node").map((statement) => ({ path, statement })),
		);
		expect(violations).toEqual([]);
	});

	it("keeps focused goal integration tests off batteries-included package barrels", () => {
		const violations = focusedGoalIntegrationTests.flatMap(({ path, source }) =>
			(source.match(/import[ \t]+(?!type\b)[^;]+[ \t]+from[ \t]+"@caupulican\/pi-(?:agent-core|ai)";/g) ?? []).map(
				(statement) => ({ path, statement }),
			),
		);
		expect(violations).toEqual([]);
	});

	it("keeps focused goal regressions on narrow owners instead of the full session harness", () => {
		const runtimeImport = 'import { AgentSession } from "../src/core/agent-session.ts";';
		const typeOnlyImport = 'import type { AgentSession } from "../src/core/agent-session.ts";';
		expect(focusedTestHeavyRuntimeImports(runtimeImport)).toEqual([runtimeImport]);
		expect(focusedTestHeavyRuntimeImports(typeOnlyImport)).toEqual([]);

		const violations = focusedGoalIntegrationTests.flatMap(({ path, source }) =>
			focusedTestHeavyRuntimeImports(source).map((statement) => ({ path, statement })),
		);
		expect(violations).toEqual([]);
	});

	it("keeps extension-loading entry points available from the public package", () => {
		expect(publicIndex).toMatch(/from "\.\/core\/extensions\/loader\.ts"/);
	});

	it("loads the bundled SDK catalog only from the Bun binary entrypoint", () => {
		expect(extensionLoader).not.toMatch(/_bundledPi|_bundledTypebox|\.\.\/\.\.\/index\.ts/);
		expect(bunEntrypoint).toMatch(/bundled-virtual-modules\.ts/);
	});

	it("keeps copied bundled extensions on the embedded package runtime boundary", () => {
		const violations = bundledTmuxRuntimeSources.flatMap(({ path, source }) =>
			(source.match(/from[ \t]+"\.\.\/\.\.\/\.\.\/core\/[^"]+"/g) ?? []).map((statement) => ({
				path,
				statement,
			})),
		);
		expect(violations).toEqual([]);
		expect(bundledVirtualModules).toMatch(/"@caupulican\/pi-adaptative": bundledPiCodingAgent/);
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
