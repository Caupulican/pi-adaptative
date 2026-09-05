import type { AgentTool } from "@caupulican/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createLaneToolSurface } from "../src/core/autonomy/lane-tool-surface.ts";
import {
	createWorkerToolAdapterRegistry,
	unsupportedWorkerToolReason,
	type WorkerToolAdapter,
	WorkerToolAdapterRegistry,
} from "../src/core/autonomy/worker-tool-adapter-registry.ts";
import type { Skill } from "../src/core/skills.ts";
import { runSkillAudit } from "../src/core/tools/skill-audit.ts";

const parameters = Type.Object({});

function tool(name: string): AgentTool<typeof parameters, unknown> {
	return {
		name,
		label: name,
		description: `fresh ${name}`,
		parameters,
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
	};
}

describe("worker tool adapter registry", () => {
	it("materializes a fresh host-owned adapter and never returns the prior tool", () => {
		const create = vi.fn(() => tool("artifact_retrieve"));
		const registry = new WorkerToolAdapterRegistry().register({
			name: "artifact_retrieve",
			description: "bounded artifact retrieval",
			create,
		});

		const first = registry.materialize("artifact_retrieve", { cwd: "/tmp/project" });
		const second = registry.materialize("artifact_retrieve", { cwd: "/tmp/project" });

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) throw new Error("Expected adapter materialization.");
		expect(first.tool).not.toBe(second.tool);
		expect(create).toHaveBeenCalledTimes(2);
	});

	it("reports deterministic unsupported reasons instead of silently dropping a requested tool", () => {
		const registry = new WorkerToolAdapterRegistry();
		expect(registry.materialize("web_search", { cwd: "/tmp/project" })).toEqual({
			ok: false,
			reason: unsupportedWorkerToolReason("web_search"),
		});
	});

	it("rejects duplicate names and adapter factories that violate the tool identity contract", () => {
		const adapter: WorkerToolAdapter = {
			name: "skill_audit",
			description: "read-only skill audit",
			create: () => tool("wrong_name"),
		};
		const registry = new WorkerToolAdapterRegistry().register(adapter);
		expect(() => registry.register(adapter)).toThrow("Duplicate worker tool adapter");
		expect(registry.materialize("skill_audit", { cwd: "/tmp/project" })).toEqual({
			ok: false,
			reason: "worker_tool_adapter_contract_violation:skill_audit:created=wrong_name",
		});
	});

	it("rejects an adapter that competes with a classified built-in", () => {
		const registry = new WorkerToolAdapterRegistry().register({
			name: "read",
			description: "must not replace the lane read owner",
			create: () => tool("read"),
		});
		expect(() => createLaneToolSurface({ cwd: "/tmp/project", workerToolAdapters: registry })).toThrow(
			"Worker tool adapter 'read' conflicts with a built-in lane tool.",
		);
	});

	it.each(["delegate", "pi_collaboration"])(
		"permanently excludes root control %s from broker registration",
		(name) => {
			expect(() =>
				new WorkerToolAdapterRegistry().register({
					name,
					description: "must remain root-owned",
					create: () => tool(name),
				}),
			).toThrow(`worker_tool_adapter_forbidden:${name}`);
		},
	);

	it("adds registered adapters to the same lane UAC and keeps them out when not registered", async () => {
		const registry = new WorkerToolAdapterRegistry().register({
			name: "skill_audit",
			description: "read-only skill audit",
			create: () => tool("skill_audit"),
		});
		const surface = createLaneToolSurface({ cwd: "/tmp/project", workerToolAdapters: registry });
		expect(surface.allowedTools).toContain("skill_audit");
		expect(surface.tools.map((candidate) => candidate.name)).toContain("skill_audit");

		const withoutRegistry = createLaneToolSurface({ cwd: "/tmp/project" });
		expect(withoutRegistry.allowedTools).not.toContain("skill_audit");
		await expect(
			surface.tools.find((candidate) => candidate.name === "skill_audit")?.execute("id", {}),
		).resolves.toEqual(expect.objectContaining({ content: [{ type: "text", text: "ok" }] }));
	});

	it("builds read-only skill and audit adapters from host brokers", async () => {
		const registry = createWorkerToolAdapterRegistry({
			skill: {
				search: () => ({ candidates: [{ name: "safe-skill", description: "safe guidance" }] }),
				read: () => ({ ok: true, name: "safe-skill", description: "safe guidance", body: "BODY" }),
			},
			skillAudit: {
				getSkills: () => [],
				redactPath: () => "skill:redacted",
			},
		});
		const skill = registry.materialize("skill", { cwd: "/tmp/project" });
		const audit = registry.materialize("skill_audit", { cwd: "/tmp/project" });
		if (!skill.ok || !audit.ok) throw new Error("Expected read-only skill adapters.");

		const result = await skill.tool.execute("read", { action: "read", name: "safe-skill" });
		expect(result.content[0]).toEqual({ type: "text", text: "skill: safe-skill\nsafe guidance\n\nBODY" });
		const actionSchema = (skill.tool.parameters as { properties: { action: { anyOf: Array<{ const: string }> } } })
			.properties.action;
		expect(actionSchema.anyOf.map((entry) => entry.const)).toEqual(["search", "read"]);
		expect(audit.tool.name).toBe("skill_audit");
	});

	it("bounds worker skill-audit drafts and snapshots without changing the foreground runner", async () => {
		const skills: Skill[] = Array.from({ length: 6 }, (_, index) => ({
			name: `skill-${index}`,
			description: "shared bounded audit trigger",
			filePath: `/tmp/skill-${index}.md`,
			baseDir: "/tmp",
			sourceInfo: { path: `/tmp/skill-${index}.md`, source: "test", scope: "user", origin: "top-level" },
			disableModelInvocation: false,
			content: "shared bounded audit body",
		}));
		const registry = createWorkerToolAdapterRegistry({
			skillAudit: {
				getSkills: () => skills,
				redactPath: () => "skill:redacted",
				maxSkills: 2,
				maxComparisonPairs: 1,
				maxDraftFieldChars: 8,
			},
		});
		const materialized = registry.materialize("skill_audit", { cwd: "/tmp/project" });
		if (!materialized.ok) throw new Error("Expected bounded skill audit adapter.");

		await expect(materialized.tool.execute("oversized", { draftName: "x".repeat(9) })).rejects.toThrow(
			"skill_audit_draft_too_large:draftName",
		);

		const report = runSkillAudit("/tmp/project", undefined, skills, undefined, {
			maxSkills: 2,
			maxComparisonPairs: 1,
		});
		expect(report.skills).toHaveLength(2);
		expect(report.nearDuplicates).toHaveLength(1);
		expect(runSkillAudit("/tmp/project", undefined, skills).skills).toHaveLength(6);
	});

	it("honors an already-aborted signal before entering the quadratic comparison", () => {
		const controller = new AbortController();
		controller.abort();
		expect(() => runSkillAudit("/tmp/project", undefined, [], undefined, { signal: controller.signal })).toThrow(
			"Operation aborted",
		);
	});

	it("checks the abort signal while evaluating comparison pairs", () => {
		const skills: Skill[] = Array.from({ length: 20 }, (_, index) => ({
			name: `skill-${index}`,
			description: "shared abort comparison trigger",
			filePath: `/tmp/skill-${index}.md`,
			baseDir: "/tmp",
			sourceInfo: { path: `/tmp/skill-${index}.md`, source: "test", scope: "user", origin: "top-level" },
			disableModelInvocation: false,
			content: "shared abort comparison body",
		}));
		let checks = 0;
		const signal = {
			get aborted() {
				checks++;
				return checks >= 8;
			},
		} as unknown as AbortSignal;

		expect(() => runSkillAudit("/tmp/project", undefined, skills, undefined, { signal })).toThrow(
			"Operation aborted",
		);
		expect(checks).toBeGreaterThanOrEqual(8);
	});

	it("materializes toolkit scripts fresh, forwards cancellation, and hides private-path scripts", async () => {
		const scripts = [
			{ name: "safe", description: "safe script", runner: "bash" as const, path: "/tmp/project/safe.sh" },
			{ name: "private", description: "private script", runner: "bash" as const, path: "/tmp/agent/MEMORY.md" },
		];
		const execute = vi.fn(async (_script, _args, signal) => {
			expect(signal).toBeDefined();
			return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1, timedOut: false };
		});
		const registry = createWorkerToolAdapterRegistry({
			runToolkitScript: { getScripts: () => scripts, execute },
		});
		const controller = new AbortController();
		const materialized = registry.materialize("run_toolkit_script", {
			cwd: "/tmp/project",
			credentialBoundary: {
				redactSensitiveText: (text) => text,
				protectedDirectories: ["/tmp/agent"],
			},
		});
		expect(materialized.ok).toBe(true);
		if (!materialized.ok) return;

		await expect(
			materialized.tool.execute("safe-call", { script: "safe" }, controller.signal),
		).resolves.toMatchObject({ details: { outcome: "executed", scriptName: "safe" } });
		expect(execute).toHaveBeenCalledWith(scripts[0], [], controller.signal);

		await expect(
			materialized.tool.execute("private-call", { script: "private" }, controller.signal),
		).resolves.toMatchObject({ details: { outcome: "not_found" } });
		expect(execute).toHaveBeenCalledTimes(1);
	});
});
