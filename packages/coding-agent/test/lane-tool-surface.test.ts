import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentContext } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLaneToolSurface, type LaneToolSurface } from "../src/core/autonomy/lane-tool-surface.ts";
import type { NormalizedProfile } from "../src/core/profile-registry.ts";
import type { ResourceProfileSettings } from "../src/core/settings-manager.ts";

function profile(resources: ResourceProfileSettings): NormalizedProfile {
	return { name: "lane", resources, source: "inline" };
}

async function gate(surface: LaneToolSurface, toolName: string, args: Record<string, unknown>) {
	const toolCall = fauxToolCall(toolName, args);
	const assistantMessage = fauxAssistantMessage([toolCall], { stopReason: "toolUse" });
	const context: AgentContext = { systemPrompt: "test", messages: [], tools: surface.tools };
	return surface.beforeToolCall({ assistantMessage, toolCall, args, context });
}

describe("classified lane tool surface", () => {
	let cwd: string;
	let outside: string;

	beforeEach(() => {
		cwd = mkdtempSync(path.join(tmpdir(), "pi-lane-tools-"));
		outside = mkdtempSync(path.join(tmpdir(), "pi-lane-tools-outside-"));
		mkdirSync(path.join(cwd, "src"), { recursive: true });
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("provides fresh classified read tools without a lane profile", () => {
		const first = createLaneToolSurface({ cwd });
		const second = createLaneToolSurface({ cwd });
		expect(first.allowedTools).toEqual(["read", "grep", "find", "ls"]);
		expect(first.tools.map((tool) => tool.name)).toEqual(first.allowedTools);
		expect(first.tools[0]).not.toBe(second.tools[0]);
		expect(first.allowedTools).not.toContain("delegate");
		expect(first.allowedTools).not.toContain("bash");
	});

	it("denies all tools for active profiles with a missing or empty tools kind", () => {
		for (const laneProfile of [profile({}), profile({ tools: { allow: [], block: [] } })]) {
			const surface = createLaneToolSurface({ cwd, profile: laneProfile });
			expect(surface.allowedTools).toEqual([]);
			expect(surface.deniedTools).toEqual(["read", "grep", "find", "ls"]);
			expect(surface.tools).toEqual([]);
		}
	});

	it("expands wildcard allow and block patterns over safe candidates only", () => {
		const allowed = createLaneToolSurface({
			cwd,
			profile: profile({ tools: { allow: ["*"] } }),
			writeEnabled: true,
			writePaths: ["src"],
		});
		expect(allowed.allowedTools).toEqual(["read", "grep", "find", "ls", "write", "edit"]);
		expect(allowed.allowedTools).not.toContain("delegate");

		const blocked = createLaneToolSurface({ cwd, profile: profile({ tools: { block: ["*"] } }) });
		expect(blocked.allowedTools).toEqual([]);
		expect(blocked.deniedTools).toEqual(["read", "grep", "find", "ls"]);
	});

	it("applies concrete allow/deny and block-only filters with block precedence", () => {
		const concrete = createLaneToolSurface({
			cwd,
			profile: profile({ tools: { allow: ["read", "grep"], block: ["grep"] } }),
		});
		expect(concrete.allowedTools).toEqual(["read"]);
		expect(concrete.deniedTools).toEqual(["grep"]);

		const blockOnly = createLaneToolSurface({ cwd, profile: profile({ tools: { block: ["grep"] } }) });
		expect(blockOnly.allowedTools).toEqual(["read", "find", "ls"]);
	});

	it("surfaces concrete opaque grants instead of making them executable", () => {
		const surface = createLaneToolSurface({
			cwd,
			profile: profile({ tools: { allow: ["read", "extension_mutator"] } }),
		});
		expect(surface.allowedTools).toEqual(["read"]);
		expect(surface.unboundAllowPatterns).toEqual(["extension_mutator"]);
	});

	it("keeps reads in cwd and writes in the explicit write roots", async () => {
		const surface = createLaneToolSurface({
			cwd,
			profile: profile({ tools: { allow: ["*"] } }),
			writeEnabled: true,
			writePaths: ["src"],
		});

		expect(await gate(surface, "read", { path: path.join(cwd, "README.md") })).toBeUndefined();
		expect((await gate(surface, "read", { path: path.join(outside, "secret.txt") }))?.block).toBe(true);
		expect(await gate(surface, "write", { path: "src/ok.ts", content: "ok" })).toBeUndefined();
		expect((await gate(surface, "write", { path: "outside.ts", content: "no" }))?.block).toBe(true);
	});

	it("never materializes write tools without both write opt-ins", () => {
		const allowAll = profile({ tools: { allow: ["*"] } });
		expect(createLaneToolSurface({ cwd, profile: allowAll, writeEnabled: true }).allowedTools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
		]);
		expect(createLaneToolSurface({ cwd, profile: allowAll, writePaths: ["src"] }).allowedTools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
		]);
	});
});
