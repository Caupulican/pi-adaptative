import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { piCollaborationExtension } from "../src/core/collaboration/extension.ts";
import { NativeProviderRegistry } from "../src/core/collaboration/native-provider.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-collaboration-extension-"));
	let tool: ToolDefinition | undefined;
	const handlers = new Map<string, () => Promise<void>>();
	const run = vi.fn(async () => ({ code: 0, reason: "exited" as const, stdout: "", stderr: "" }));
	const backend = vi.fn(async () => {
		throw new Error("Backend launch should not occur in a preview.");
	});
	const provision = vi.fn(async () => ({ path: "/managed/herdr", globalPath: true }));
	const api = {
		registerTool: (value: ToolDefinition) => {
			tool = value;
		},
		registerCommand: vi.fn(),
		on: (name: string, handler: () => Promise<void>) => {
			handlers.set(name, handler);
		},
		getActiveTools: () => ["read", "bash", "delegate", "pi_collaboration"],
		getThinkingLevel: () => "high",
		getEffectiveResourceProfile: () => ({}),
		reportManagedLane: vi.fn(),
	} as unknown as ExtensionAPI;
	const context = {
		cwd: root,
		sessionManager: { getSessionId: () => "parent", getSessionFile: () => undefined },
		ui: { notify: vi.fn() },
	} as unknown as ExtensionContext;
	piCollaborationExtension(api, {
		stateDirectory: root,
		backend,
		provision,
		providers: new NativeProviderRegistry(run, [], () => ({
			executable: "/current/node",
			argsPrefix: ["--conditions=pi-source", "/current/cli.ts"],
			environment: { PI_PACKAGE_DIR: "/current", TSX_TSCONFIG_PATH: "/current/tsconfig.json" },
		})),
	});
	cleanups.push(async () => {
		await handlers.get("session_shutdown")?.();
		await rm(root, { recursive: true, force: true });
	});
	return {
		root,
		run,
		backend,
		provision,
		execute: (input: unknown) => tool!.execute("call", input, undefined, undefined, context),
	};
}

it("checks backend readiness without creating an orphan server", async () => {
	const f = await fixture();
	await expect(f.execute({ action: "guard" })).resolves.toMatchObject({ details: { guard: { allowed: true } } });
	expect(f.provision).toHaveBeenCalledTimes(1);
	expect(f.backend).not.toHaveBeenCalled();
});

it("assigns distinct implementation, validation and review tasks to the default team", async () => {
	const f = await fixture();
	const result = await f.execute({ action: "workspace_plan" });
	const content = result.content[0];
	if (content.type !== "text") throw new Error("Expected plan text.");
	const plan = JSON.parse(content.text);
	expect(plan.job.agents.map((agent: { name: string }) => agent.name)).toEqual(["builder", "validator", "reviewer"]);
	expect(new Set(plan.job.agents.map((agent: { task: string }) => agent.task)).size).toBe(3);
	for (const agent of plan.job.agents) expect(agent.args).not.toContain("--verbose");
});

it("keeps distinct long launch keys in distinct backend sessions", async () => {
	const f = await fixture();
	const sessions: string[] = [];
	for (const suffix of ["a", "b"]) {
		const result = await f.execute({ action: "workspace_plan", launchKey: `${"j".repeat(63)}${suffix}` });
		const content = result.content[0];
		if (content.type !== "text") throw new Error("Expected plan text.");
		sessions.push(JSON.parse(content.text).job.sessionName);
	}
	expect(sessions[0]).not.toBe(sessions[1]);
});

it("composes default Pi launches from the stable current harness after native option validation", async () => {
	const f = await fixture();
	const result = await f.execute({
		action: "workspace_plan",
		agents: [{ provider: "pi", apiProvider: "fixture", model: "model", env: { PI_PACKAGE_DIR: "/retired" } }],
	});
	const content = result.content[0];
	if (content.type !== "text") throw new Error("Expected plan text.");
	const agent = JSON.parse(content.text).job.agents[0];
	expect(agent.executable).toBe("/current/node");
	expect(agent.args.slice(0, 6)).toEqual([
		"--conditions=pi-source",
		"/current/cli.ts",
		"--provider",
		"fixture",
		"--model",
		"model",
	]);
	expect(agent.args).toContain("--session-mode");
	expect(agent.env).toMatchObject({ PI_PACKAGE_DIR: "/current", TSX_TSCONFIG_PATH: "/current/tsconfig.json" });
	expect(f.run).not.toHaveBeenCalled();
});

it("preserves a structured wrapper, composed arguments and YOLO policy in a preview", async () => {
	const f = await fixture();
	const result = await f.execute({
		action: "workspace_plan",
		agents: [
			{
				provider: "claude",
				command: "CLAUDE_CONFIG_DIR=/isolated claude-wrapper --model sonnet",
				args: ["--verbose"],
			},
		],
	});
	const content = result.content[0];
	if (content.type !== "text") throw new Error("Expected plan text.");
	const plan = JSON.parse(content.text);
	expect(plan.job.agents[0]).toMatchObject({
		executable: "claude-wrapper",
		// Provider selection is now canonicalized once after unrelated native arguments.
		args: ["--verbose", "--model", "sonnet", "--dangerously-skip-permissions"],
		env: { CLAUDE_CONFIG_DIR: "/isolated" },
	});
	expect(f.run).not.toHaveBeenCalled();
	expect(f.backend).not.toHaveBeenCalled();
});

it("probes the exact wrapper and environment before admitting a native launch", async () => {
	const f = await fixture();
	await expect(
		f.execute({
			action: "fire_task",
			task: "Read only",
			agents: [{ provider: "claude", command: "CLAUDE_CONFIG_DIR=/isolated claude-wrapper" }],
		}),
	).rejects.toThrow(/not admitted/);
	expect(f.run).toHaveBeenCalledWith(
		"claude-wrapper",
		["auth", "status"],
		expect.objectContaining({ env: expect.objectContaining({ CLAUDE_CONFIG_DIR: "/isolated" }) }),
	);
	expect(f.backend).not.toHaveBeenCalled();
});
