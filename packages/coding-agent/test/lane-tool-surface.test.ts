import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentContext } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLaneToolSurface, type LaneToolSurface } from "../src/core/autonomy/lane-tool-surface.ts";
import {
	type ExecutionGrant,
	ORCHESTRATION_SCHEMA_VERSION,
	type ToolCapabilityManifest,
} from "../src/core/orchestration/contracts.ts";
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
		expect(first.allowedTools).not.toContain("ask_question");
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
		expect(allowed.allowedTools).not.toContain("ask_question");

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

	it("rejects an oversized memory query before invoking the memory boundary", async () => {
		const readMemory = vi.fn(async () => "memory");
		const surface = createLaneToolSurface({
			cwd,
			profile: profile({ tools: { allow: ["memory"] } }),
			readMemory,
		});
		const memory = surface.tools.find((tool) => tool.name === "memory");
		if (!memory) throw new Error("Expected the memory tool.");

		await expect(memory.execute("memory-1", { query: "x".repeat(4_097) })).rejects.toThrow("memory_query_invalid");
		expect(readMemory).not.toHaveBeenCalled();
	});

	it("seeds the compiled gateway from durable cumulative usage and rejects invalid seeds", () => {
		const grant: ExecutionGrant = {
			schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
			grantId: "grant-1",
			objectiveId: "objective-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			subjectId: "worker-1",
			role: "explorer",
			capabilities: ["filesystem.read"],
			allowedTools: ["read"],
			resources: [],
			readPaths: [cwd],
			writePaths: [],
			deniedPaths: [],
			budget: { maxToolCalls: 2 },
			policyVersion: "policy-1",
			decisionTrace: [],
			issuedAt: "2026-07-27T00:00:00.000Z",
		};
		const manifests: ToolCapabilityManifest[] = [
			{
				toolName: "read",
				moduleSpecifier: "./read.ts",
				capabilities: ["filesystem.read"],
				roles: ["explorer"],
				enforcements: ["path-scope"],
			},
		];
		const surface = createLaneToolSurface({
			cwd,
			grant,
			toolManifests: manifests,
			initialUsage: {
				toolCalls: 1,
				inputTokens: 2,
				outputTokens: 3,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 5,
				costUsd: 0.1,
				activeWallClockMs: 4,
			},
		});

		const usage = surface.gateway?.getUsage();
		expect(usage).toMatchObject({
			toolCalls: 1,
			inputTokens: 2,
			outputTokens: 3,
			totalTokens: 5,
			costUsd: 0.1,
		});
		expect(usage?.wallClockMs).toBeGreaterThanOrEqual(4);
		expect(() =>
			createLaneToolSurface({
				cwd,
				grant,
				toolManifests: manifests,
				initialUsage: {
					toolCalls: -1,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 0,
					costUsd: 0,
					activeWallClockMs: 0,
				},
			}),
		).toThrow("initial usage must contain finite non-negative values and safe-integer counts");
	});
});
